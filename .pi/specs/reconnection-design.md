# Reconnection System — Design Doc

> Status: Design reference
> Last updated: 2026-07-07
> Related: [[reconnection.md]] (implementation reference), [[visibility-driven-reconnect.md]] (change spec)

## Purpose

waveterm-remote's USP: working on a remote server should feel like working locally. A dropped SSH connection — whether from sleep, Wi-Fi flap, VPN bounce, or a flaky network — should heal itself with no more friction than a local terminal would show after a brief glitch.

This document captures the intended design: the reconnection scenarios, the interactive-login model, and how the UX presents all of it to the user. It is the authoritative "what and why." Implementation details live in `reconnection.md`; specific changes live in spec files.

---

## Guiding Principles

1. **Attention is the rate limiter.** Background reconnect must not retry forever. When the user's attention returns to a disconnected connection, that is the natural moment to retry — and it is acceptable to prompt then, because the user is present.
2. **Involuntary disconnects must not lose state.** A network drop is not a user action. Cached passwords, reconnect eligibility, and job state must survive it. Only explicit user disconnect (the Disconnect button) and wrong-password (auth-failed) clear auth state.
3. **Distinguish "can reconnect silently" from "may need to prompt."** A connection that has authenticated successfully before via key (or with a cached password) can reconnect without bothering the user. A connection that will need a password prompt must not retry unattended in the background forever — but it *should* retry when the user looks at it.
4. **Genuinely-unavailable is not infinite-retry.** No network, VPN down, or a down remote should not produce an unbounded reconnect storm. The background scheduler is bounded; visibility-driven reconnect is bounded by user attention (once per look).
5. **One prompt per connection, serialized per tab.** The user is never shown two password prompts for the same connection, and never shown prompts for multiple connections simultaneously on one tab.

---

## Reconnection Scenarios

### Scenario 1 — Brief network blip (Wi-Fi flap, sub-second to ~5s drop)

The SSH TCP connection dies. `waitForDisconnect` sets `Status = Disconnected`, retains the cached password (it does **not** clear it — only explicit disconnect / auth-failed clear it). `onConnectionDown` fires.

- **Autonomous connection** (key-based, or password with cache still present): `needsInteractiveAuth` returns false → `scheduleConnectionReconnect` starts → retries every 5s (3s in aggressive mode) → reconnects silently within seconds. User sees at most a brief "Disconnected → Reconnecting" flash.
- **Interactive connection** (password, no cache): `needsInteractiveAuth` returns true → background scheduler skips. Stays disconnected until the user's attention returns (Scenario 6).

### Scenario 2 — Sleep / wake (laptop suspended, network gone for minutes)

While suspended, goroutines are paused by the OS. On wake:

1. Electron `powerMonitor` fires `resume` → `NotifySystemResumeCommand` → `HandleSystemResume`.
2. `HandleSystemResume` iterates connections that have running durable jobs. For each:
   - Skip if `needsInteractiveAuth` (can't auto-reconnect silently).
   - If stalled (zombie after sleep), force-disconnect so reconnect starts fresh.
   - Call `AttemptReconnect` immediately (bypasses the 5s scheduler tick).

Simultaneously, the keepalive monitor's 3s ticker fires a catch-up tick. If the TCP is dead, keepalive errors → stall is detected → `disconnectOnStall` → `Close()`. This is the path that **must not clear the cached password** (see Scenario 4). After `Close()`, `waitForDisconnect` / `onConnectionDown` → scheduler starts (for autonomous connections).

**Design intent for wake:** `HandleSystemResume` gives a head-start when the user is already looking at waveterm. It is a complement to, not a replacement for, visibility-driven reconnect (Scenario 6). It uses the same `needsInteractiveAuth` heuristic, so once that heuristic is fixed (spec item #1), key-based connections benefit from the fast path too.

### Scenario 3 — Intermittent / flapping connection

Connection drops and returns rapidly. Guards prevent storms:
- `connectionReconnectSchedulers` dedup map: one scheduler per connection.
- `Connect()` `lifecycleLock` + `isWithinConnectCooldown` (5s): concurrent `Connect()` calls serialize.
- `setPendingAuth` / `waitForPendingAuth`: only one password prompt per connection at a time.
- `singleflight` on `ReconnectJob`: dedupes job-route reconnects.

The aggressive mode (3s interval, extendable 2min window) kicks in when `isNetworkUnreachableError` matches, catching the moment the network returns.

### Scenario 4 — Stall auto-disconnect (zombie connection)

A connection that is "up" at the TCP level but not responding (e.g., firewall silently dropping packets, or sleep where keepalive can't propagate). The keepalive monitor (`connmonitor.go`) detects no activity, sends keepalives, and if stall persists beyond the threshold (default 5s, configurable via `conn:stalldisconnectthreshold`), calls `disconnectOnStall` → `Close()`.

**Critical design rule:** `disconnectOnStall` is an *involuntary* disconnect. It must not clear the cached password. Only two things clear the cache:
- Explicit user Disconnect (`ConnDisconnectCommand`)
- `auth-failed` (wrong password)

This rule is currently violated: `Close()` unconditionally calls `clearCachedPassword()`, and the stall path calls `Close()`. Spec item #2 fixes this.

### Scenario 5 — Genuinely unavailable (no network, VPN down, remote down)

The remote is not coming back soon. The background scheduler retries for a bounded window, then stops:

- **Current:** `ConnReconnectMaxDuration = 5 min` hard cap, then the scheduler exits and clears retry state.
- **Design:** extend the cap for connections that can reconnect silently (key-based / cached password), since silent retries are cheap. Keep a shorter cap for connections that might prompt. Distinguish error types: `connection-refused` / `auth-failed` should stop the scheduler early (server is up but rejecting; needs user action), while `no-route-to-host` / `network-unreachable` / `timeout` justify continued retry.

After the scheduler gives up, the only re-trigger is visibility (Scenario 6) or manual Reconnect.

### Scenario 6 — User returns to waveterm (visibility-driven reconnect)

The user switches to a tab, or focuses the waveterm window, or the app regains focus. One or more terminal blocks on that tab are disconnected. **This is the core USP moment.**

Design:
- Frontend detects the visibility event (tab switch / app focus).
- For each unique connection on visible blocks that is `disconnected` or `error`, fire `ConnConnectCommand` (the same RPC the Reconnect button uses) → backend `EnsureConnection` / `AttemptReconnect`.
- `EnsureConnection` is idempotent and cooldown-guarded: if a `Connect()` is already in flight or was attempted within the last 5s, it returns immediately or waits on `pendingAuth`. This prevents storms when the user rapidly switches tabs.
- Status transitions cleanly: `disconnected` → `connecting` (overlay shows "Connecting…") → `connected` or back to `disconnected` with error. No stacking of disconnected states.
- For a **durable shell**, once the SSH connection re-establishes, `onConnectionUp` automatically reconnects the job. So visibility-driven reconnect of the *connection* is sufficient; job reattachment follows.

This does **not** use IntersectionObserver (out of scope — that's for scroll/visibility of individual blocks within a tab, and adds complexity). Tab switch + app focus cover the described scenario.

### Scenario 7 — System resume while waveterm is front app

Overlap of Scenario 2 and 6: the laptop wakes and the user is already looking at waveterm. `HandleSystemResume` fires the fast-path reconnect immediately, so the user sees "Connecting…" rather than "Disconnected." This is why `HandleSystemResume` is kept even after visibility-driven reconnect lands.

---

## Interactive Login (Password / Keyboard-Interactive)

### The password buffer model

The password is a **persistent buffer**, not tied to a single connection attempt:

```
connectInternal() → ConnectToClient() → SSH password callback
  ├─ cached password in context? → use it, no prompt
  ├─ orphaned password (user typed after prev prompt timed out)? → use it
  ├─ password from secret store? → use it, no prompt
  └─ none → GetUserInput() → frontend prompt → user types → cached → used
```

`CachedPassword` lives on the `SSHConn` (in `clientControllerMap`, process-lifetime). It is cleared only by:
- Explicit Disconnect (`ConnDisconnectCommand` → `Close()`)
- `auth-failed` (wrong password) → clears cache, fires `requestPasswordRePrompt` background goroutine to re-prompt

It is **not** cleared by `waitForDisconnect` (involuntary TCP drop) — and spec item #2 ensures the stall path also does not clear it.

### The prompt UX

The password prompt is **non-modal** and **scoped to the tab** that contains a terminal block for that connection:

1. **Per-tab rendering.** `TabUserInputPromptOverlay` (rendered in `workspace.tsx`) filters `activeUserInputPrompts` by `tabHasTerminalBlockForConn` — only tabs with a `view === "term"` block whose `connection === connName` show the prompt. Other tabs are not bothered.
2. **Centered in the tab view.** `absolute inset-0 flex items-center justify-center`.
3. **One prompt per connection.** `activeUserInputPromptsAtom` is a `Record<connName, ...>`; `upsertUserInputPrompt` overwrites by key. Backend `setPendingAuth` ensures only one `Connect()` / one `GetUserInput` per connection at a time.
4. **Multiple connections on one tab → serialized, not simultaneous.** *(Currently shows all at once — spec item #4 fixes this with backend serialization.)* The design: when a tab becomes visible and multiple connections need passwords, prompts appear one at a time. When the first is dismissed (correct password or cancel), the next connection's prompt appears.
5. **Correct password dismisses across all tabs.** On `connchange(connected)`, the frontend calls `dismissUserInputPrompt(connName)`, removing the prompt globally. On `auth-failed`, it calls `resetDismissedUserInputPrompts` so all tabs re-show.
6. **Orphaned password recovery.** If the 60s `GetUserInput` times out before the user finishes typing, `SendUserInputResponse` caches the password via `CacheOrphanedPassword`; the next `Connect()` picks it up without re-prompting.

### When the prompt appears (and does not)

| Trigger | Autonomous conn (key/cache) | Interactive conn (no cache) |
|---------|:---:|:---:|
| Background scheduler | Silently retries, no prompt | Skipped (no prompt) |
| `HandleSystemResume` | Fast-path reconnect, no prompt | Skipped (no prompt) |
| Visibility-driven reconnect | Silently reconnects, no prompt | **Prompts** (user is present) |
| Manual Reconnect button | Silently reconnects | **Prompts** |
| `auth-failed` during any attempt | n/a | Re-prompt via background goroutine |

---

## The "can reconnect without a prompt" heuristic

This is the single most important predicate in the system. It gates the background scheduler, `HandleSystemResume`, and the UI's `CanAutoReconnect` flag.

**Current (buggy) logic** (`needsInteractiveAuth` / `canAutoReconnectLocked`): infers "needs interactive auth" from SSH's *default* auth-method flags (password / keyboard-interactive default to enabled when nil). This wrongly classifies key-based connections as interactive — so they never auto-reconnect on wake, and the UI never shows the retry countdown.

**Design (fix):** A connection can reconnect silently if **any** of:
- It has a cached password (`HasCachedPassword`), OR
- It has a password in the secret store (`SshPasswordSecretName`), OR
- Batch mode is on (`SshBatchMode` — prompts are suppressed), OR
- PreferredAuthentications excludes password/keyboard-interactive, OR
- **It has connected successfully before without needing a password** (`HasConnected` / `LastConnectTime > 0`) — this is the key-based case. SSH tries keys first; if the key fails on reconnect, it falls back to the password callback, which prompts. That fallback prompt is acceptable (rare, and the user is likely present).

The last condition is the new addition. It cleanly separates "has proven it doesn't need a password" from "SSH defaults say password auth is enabled." A future enhancement may track `LastAuthMethod` from the SSH handshake for precision, but the heuristic is sufficient for now.

---

## UX Presentation

### Connection status overlay (`ConnStatusOverlay`)

Shown per block, layered above the terminal:

| State | Overlay | What user sees |
|-------|---------|---------------|
| `connected` + `good` | none | Normal terminal |
| `connected` + `stalled` | `StalledOverlay` (yellow) | "Connection to host is stalled (no activity for Ns)" + Disconnect button |
| `connecting` (retry) | `RetryingOverlay` (spinner) | "Attempt N — connecting to host…" |
| `disconnected` + countdown | `CountdownOverlay` (clock) | "Last attempt failed: error" + "Retrying in Ns" + Reconnect now |
| `disconnected` (scheduler gave up or no auto-reconnect) | `DisconnectedOverlay` (red) | "Disconnected from host" + error + Reconnect button |
| `error` | overlay with error detail + Reconnect | Copy-error button |
| `connecting` (manual / first) | none (or spinner) | "Connecting to host…" |

The retry/countdown overlays are gated on `CanAutoReconnect` — they only show when auto-reconnect is possible. With the heuristic fix, key-based connections will now show the countdown, confirming to the user that retry is happening.

### Password prompt overlay

- Non-modal, centered in the tab view, only on tabs with a terminal block for that connection.
- One prompt per connection; serialized across connections on the same tab (spec item #4).
- Dismissed globally on successful connect; re-shown on `auth-failed`.
- Hidden behind the prompt: the `DisconnectedOverlay` is suppressed while an active prompt exists for the connection (so the user isn't asked to click Reconnect while typing a password).

### What the user should never see

- A frozen terminal with no indication of what happened (the overlay always shows on disconnect).
- Two password prompts for the same connection.
- A password prompt on a tab that has no terminal block for that connection.
- A "Disconnected" overlay that requires a manual click when the connection could have reconnected silently (the background scheduler or visibility-driven reconnect should handle it).
- A cached password being lost after a sleep/wake, forcing a re-prompt for a connection the user already authenticated.

---

## Component map

| Component | File | Role |
|-----------|------|------|
| Background scheduler | `pkg/jobcontroller/jobcontroller.go` (`scheduleConnectionReconnect`) | Bounded retry loop for autonomous connections |
| `needsInteractiveAuth` / `canAutoReconnectLocked` | `jobcontroller.go` / `conncontroller.go` | The "can reconnect silently" predicate |
| `HandleSystemResume` | `jobcontroller.go` | Fast-path reconnect on macOS wake |
| Visibility-driven reconnect | *new* (frontend trigger + backend `EnsureConnection`) | Reconnect on tab switch / app focus |
| `Connect` / `EnsureConnection` / `AttemptReconnect` | `conncontroller.go` | The actual (re)connection, idempotent + cooldown-guarded |
| `CachedPassword` + `setPendingAuth` | `conncontroller.go` | Password buffer + per-connection prompt dedup |
| Password callback | `sshclient.go` (`createPasswordCallbackPrompt`) | Uses cache → secret store → prompt |
| `requestPasswordRePrompt` | `conncontroller.go` | Background re-prompt on auth-failed |
| Stall monitor | `connmonitor.go` | Detects zombie connections, auto-disconnects |
| `ConnStatus` + retry fields | `wshrpctypes.go` / `conncontroller.go` | Feeds the UI overlay |
| `connchange` event handler | `frontend/app/store/global.ts` | Updates conn status, dismisses/resets prompts |
| `ConnStatusOverlay` | `frontend/app/block/connstatusoverlay.tsx` | Per-block status/retry overlay |
| `TabUserInputPromptOverlay` | `frontend/app/tab/tabuserinputpromptoverlay.tsx` | Per-tab password prompt |
| `modalsModel` | `frontend/app/store/modalmodel.ts` | Prompt state: active prompts, per-tab dismissals |

---

## Open design questions (resolved)

1. **Prompt on visibility-driven reconnect with no cached password** — Yes, prompt automatically. The user is present; surfacing the prompt is the "feels connected" behavior. Falls back to the password callback.
2. **Failed state** — No special "failed" terminal state. Keep current behavior: error shown in overlay + Reconnect button. Visibility-driven reconnect still attempts on each look (bounded by user attention, not infinite).
3. **Visibility triggers** — Tab switch + app focus. Not IntersectionObserver.
4. **`HandleSystemResume`** — Keep. Gives a seamless experience when waveterm is the front app on wake.
5. **Password prompt serialization across connections** — Backend serialization (spec item #4), not frontend queueing. More robust: prevents concurrent SSH handshakes for different connections on the same tab.

---

## References

- [[reconnection.md]] — implementation reference (state diagrams, all 16 triggers, constants)
- [[reconnect-ui-overlay.md]] — overlay UI spec (retry/countdown/disconnected states)
- [[visibility-driven-reconnect.md]] — spec for the changes described here
- `.pi/draft-issue-autoconnect-bugs.md` — historical bug analysis (cooldown race, connStates race, missing triggers)