# SSH Reconnection Strategies — Design Reference

> Last updated: 2026-07-17
> Covers: auto-reconnect scheduler, password buffer, tab triggers, error classification, auth-prompt tracking

## Overview

Two classes of SSH connections dictate reconnection behavior:

| Class | Examples | Auto-Scheduler? | Needs User Input? |
|-------|----------|:---:|:---:|
| **Autonomous** | Key-based auth (unencrypted key or agent), batch mode, password from secret store, cached password available | ✅ Rapid 5s/3s | Never |
| **Interactive** | Password typed by user, passphrase-encrypted key, keyboard-interactive (no cached password) | ❌ No (or only for auth-failed edge case) | Yes — password/passphrase prompt |

Eligibility is determined by `CanReconnectWithoutPrompt` (see [Auto-Reconnect Eligibility](#auto-reconnect-eligibility-canreconnectwithoutprompt)), which uses a runtime `authPromptState` flag (set after each successful handshake) as the primary signal, with a `~/.ssh/config` publickey fallback for cold starts.

---

## Constants & Timeout Variables

| Variable | File | Value | Purpose |
|----------|------|-------|---------|
| `ConnReconnectInterval` | `jobcontroller.go:122` | 5s | Normal scheduler retry interval |
| `ConnReconnectAggressiveInterval` | `jobcontroller.go:124` | 3s | Aggressive mode (network unreachable) |
| `ConnReconnectMaxDuration` | `jobcontroller.go:123` | 5 min | Scheduler gives up after this |
| `ConnReconnectAggressiveDuration` | `jobcontroller.go:125` | 2 min | Aggressive window, extended on each net error |
| `ConnReconnectCooldown` (scheduler connect timeout) | `jobcontroller.go:816` | 5s | Timeout per `AttemptReconnect` call |
| `AutoReconnectCooldown` | `jobcontroller.go:121` | 30s | Cooldown for job route reconnect |
| `userInputTimeout` (password prompt) | `sshclient.go:442` | 60s | Max time user has to enter password |
| `userInputContextTimeout` (decoupled, post-fix) | `conncontroller.go` (new) | 120s | Independent context for password buffer |
| `ConnectCooldown` | `conncontroller.go:986-995` | 5s | Min interval between `Connect()` calls |
| `WaitForConnectPoll` | `conncontroller.go:821-843` | 100ms | Poll interval while waiting for connection |
| `PendingEventTTL` | `wps.go` | (TTL) | Max age of buffered events before expiry |
| `StallDisconnectThreshold` | `connmonitor.go` | 5s | Time before stalled connection is auto-closed |

---

## Strategy A: Autonomous Connections (No Password Needed)

### State Diagram

```
                 ┌──────────┐
                 │   init   │  (block created, no connection yet)
                 └────┬─────┘
                      │ ConnEnsureCommand / EnsureConnection
                      ▼
                 ┌──────────┐
                 │connecting│  (SSH handshake in progress)
                 └────┬─────┘
                      │
          ┌───────────┼───────────┐
          ▼           │           ▼
    ┌──────────┐      │     ┌──────────┐
    │connected │◄─────┘     │  error   │  (handshake failed)
    └────┬─────┘            └────┬─────┘
         │                       │
         │  remote disconnect    │  onConnectionDown
         │  OR stall detected    │  (needsInteractiveAuth = false)
         ▼                       ▼
    ┌──────────┐           ┌──────────────┐
    │disconnected│         │ scheduler    │ (reconnect loop)
    └────┬─────┘           │ running      │
         │                 └──────┬───────┘
         │ onConnectionDown       │
         │ (needsInteractiveAuth  │ every 5s (3s aggressive):
         │  = false)              │   AttemptReconnect(ctx, 5s)
         ▼                        │   → Connect() → connectInternal()
    ┌──────────────┐              │   → ConnectToClient()
    │ scheduler    │              │   → SSH key auth (no prompt)
    │ running      │              │
    └──────┬───────┘              ▼
           │                 ┌──────────┐
           │ success         │connected │  → scheduler stops
           ▼                 └──────────┘
      ┌──────────┐
      │connected │  → scheduler stops
      └──────────┘

    After 5 min without success:
           ▼
      ┌──────────────┐
      │ disconnected │  (permanent, scheduler gave up)
      │ (static)     │  User sees: "Disconnected from user@host"
      └──────────────┘  [Reconnect] button
```

### What the User Sees

| Connection State | UI | User Action |
|-----------------|----|-------------|
| `connecting` | Spinner, "Connecting to user@host..." | Wait |
| `connected` | Normal terminal | Use normally |
| `disconnected` (scheduler running) | "Reconnecting in Ns..." countdown, "Retrying..." | Wait or click [Reconnect] |
| `disconnected` (scheduler gave up) | "Disconnected from user@host" | Click [Reconnect] |
| `error` (transient) | Error message + retry countdown | Wait |

### Aggressive Mode

Triggered when error is **network unreachable** (Wi-Fi down, no route, interface down). Uses 3s interval for up to 2 minutes, extended each time a network error is seen again.

```
Normal:  5s interval, max 5 min
Aggressive: 3s interval, max 2 min (extendable)
```

### System Resume Fast-Path (macOS)

On laptop wake:
1. `HandleSystemResume` iterates all connections
2. Skips connections where `needsInteractiveAuth()` returns true (delegates to `CanReconnectWithoutPrompt`)
3. For stalled connections: force-disconnects first
4. Calls `AttemptReconnect(ctx, 5s)` immediately (bypasses scheduler tick)

---

## Strategy B: Interactive-Auth Connections (Password Required)

### State Diagram

```
                 ┌──────────┐
                 │   init   │  (block created, no connection yet)
                 └────┬─────┘
                      │ ConnEnsureCommand / EnsureConnection
                      ▼
                 ┌──────────┐
                 │connecting│  (SSH handshake in progress)
                 └────┬─────┘
                      │
                      │ server requests password
                      │ no cached password available
                      ▼
                 ┌───────────────┐
                 │ password      │  (middle of ssh handshake)
                 │ prompt shown  │  User sees: centered prompt on tab
                 │ (per-tab)     │  "Password Authentication"
                 └───────┬───────┘  [password input] + [Ok] [Cancel]
                         │
          ┌──────────────┼──────────────┐
          ▼              │              ▼
    ┌──────────┐         │        ┌──────────┐
    │connected │◄────────┘        │  error   │
    └──────────┘  correct         │ (auth-   │
         │        password        │  failed) │
         │                        └────┬─────┘
         │  prompts auto-dismissed     │
         │                             │ cached password cleared
         ▼                             │ → background re-prompt
    ┌──────────┐                       ▼
    │connected │                  ┌───────────────┐
    │(stable)  │                  │ password      │  (re-prompt, independent
    └──────────┘                  │ prompt shown  │   of connection lifecycle)
                                  │ (new request) │  User sees: same prompt,
                                  └───────┬───────┘  input cleared for retry
                                          │
                             ┌────────────┼────────────┐
                             ▼            │            ▼
                       ┌──────────┐       │      ┌──────────┐
                       │connected │◄──────┘      │  error   │  (cancel)
                       └──────────┘ correct      │ (cancel) │
                            │      password      └──────────┘
                            │
                            ▼
                       ┌──────────┐
                       │connected │
                       │(stable)  │
                       └──────────┘

    If connection disconnects later (with cached password):
           ▼
      ┌──────────────┐
      │disconnected  │  → behaves like Strategy A (auto-reconnect)
      └──────────────┘    because cached password exists
```

### What the User Sees

| Connection State | UI | User Action |
|-----------------|----|-------------|
| `connecting` | Spinner, "Connecting to user@host..." | Wait |
| `password prompt` (first time) | Centered prompt on tab: title, "Password:", input, [Ok] [Cancel] | Enter password |
| `password prompt` (after wrong password) | Same prompt, input cleared. Prompt re-shown automatically. | Enter new password |
| `connected` | Normal terminal | Use normally |
| `disconnected` (cached password exists) | "Reconnecting in Ns..." (like Strategy A) | Wait |
| `disconnected` (no cached password, prompt available) | Password prompt visible + "Disconnected" overlay behind it | Enter password |
| `disconnected` (no cached password, prompt timed out) | "Disconnected from user@host" | Click [Reconnect] |
| `error` (auth-failed) | Prompt re-appears automatically (background re-prompt goroutine) | Enter new password |

### Password Buffer Model

The password prompt is a **persistent buffer**, NOT tied to any single connection attempt:

```
┌─────────────────────────────────────────────┐
│  Password Buffer (conn.CachedPassword)      │
│                                              │
│  Write: User enters password in prompt       │
│  Read:  connectInternal() → ConnectToClient  │
│         → password callback → uses cache     │
│  Clear: auth-failed (wrong password)         │
│                                              │
│  Prompt lifecycle:                           │
│  1. No cache → show prompt (userinput event) │
│  2. User enters → cache → dismiss prompt     │
│  3. Auth success → connection established    │
│  4. Auth fail → clear cache → re-show prompt │
│     (background goroutine, independent ctx)  │
└─────────────────────────────────────────────┘
```

### Orphaned Password Recovery

If the connection context times out before the user finishes typing:
1. `connectInternal` returns (parent goroutine exits)
2. Password callback goroutine continues (independent 120s context)
3. User enters password → `SendUserInputResponse` RPC
4. Channel may or may not exist
5. **If channel exists** (password callback still waiting): response sent, `pwTracker` set
6. **If channel gone** (parent returned, channel unregistered): `SendUserInputResponse` calls `CacheOrphanedPassword` → stores on `conn.CachedPassword` directly
7. Next connect attempt uses cached password, no prompt

---

## Auto-Reconnect Eligibility: `CanReconnectWithoutPrompt`

All three auto-reconnect gates (`onConnectionDown` scheduler, `HandleSystemResume` fast-path, `DeriveConnStatus` UI `CanAutoReconnect` flag) delegate to a single function: `conncontroller.CanReconnectWithoutPrompt(connName)`. This replaced the previous `needsInteractiveAuth` / `canAutoReconnectLocked` / `NeedsInteractiveAuth` trio, which inspected only `connections.json` and missed key-based connections whose SSH config (`~/.ssh/config` IdentityFile) is merged at connect time.

### Decision order (in `canReconnectWithoutPromptLocked`, called with `conn.lock` held)

| # | Condition | Result | Why |
|---|-----------|--------|-----|
| 1 | Cached password (`conn.CachedPassword != nil`) | ✅ true | Replayable without prompting |
| 2 | `conn.LastErrorCode == "auth-failed"` | ❌ false | Credential rejected; retry won't help. Wait for user re-auth (`requestPasswordRePrompt`) or key fix. Prevents retry storm. |
| 3 | `conn.authPromptState == authPromptNone` | ✅ true | Last successful connect used no prompt (unencrypted key, agent key, replayable secret) |
| 4 | `conn.authPromptState == authPromptUsed` | ❌ false | Last successful connect needed a prompt (password typed, key passphrase, keyboard-interactive) and no password was cached (step 1) |
| 5 | `conn.authPromptState == authPromptUnknown` (never connected or cleared after auth-failed) | config fallback | `canReconnectFromKeywordsOrPubkey`: checks `connections.json` (batch mode, password secret, preferred auth, disabled password/kbd) then `~/.ssh/config` (`HasPublicKeyAuth`: IdentityFile exists + PubkeyAuthentication enabled) |

`NeedsInteractiveAuth` (startup reconnect) is intentionally conservative — it only trusts the runtime flag and cached password, NOT the publickey fallback, because a configured key may be passphrase-encrypted (requiring a prompt). This gives the startup connect a generous no-deadline context.

### `authPromptState` flag

Stored on `SSHConn.authPromptState` (atomic.Int32). Set after a successful `ConnectToClient` in `connectInternal`, based on the `AuthTracker`:

| Value | Constant | Set when |
|------|----------|----------|
| 0 | `authPromptUnknown` | Never connected, or cleared after `auth-failed` |
| 1 | `authPromptNone` | Successful connect with `InteractivePromptUsed() == false` (no password typed, no passphrase, no kbd-interactive) |
| 2 | `authPromptUsed` | Successful connect with `InteractivePromptUsed() == true` |

Cleared to `authPromptUnknown` in `Connect` when `errorCode == "auth-failed"` (alongside `clearCachedPassword`).

### `AuthTracker` (replaces `PasswordUsedTracker`)

Set by the SSH auth callbacks during `ConnectToClient`:

| Field | Set by | Replayable? |
|------|-------|:---:|
| `PasswordUsed` + `Password` | Password callback (secret store, cache, OR user-typed) | Depends (see below) |
| `PasswordFromPrompt` | Password callback, user-typed path only | ❌ |
| `PassphrasePrompted` | Publickey callback, passphrase prompt path | ❌ |
| `KbdInteractiveUsed` | Keyboard-interactive callback | ❌ |

`InteractivePromptUsed()` returns `PasswordFromPrompt || PassphrasePrompted || KbdInteractiveUsed`. Replayable credentials (secret-store password, cached password, unencrypted key, agent key) do NOT set any of these — only live user prompts do.

### Config fallback: `HasPublicKeyAuth` (`~/.ssh/config`)

When the runtime flag is unknown (cold start, post-auth-failed), `canReconnectFromKeywordsOrPubkey` falls back to inspecting `~/.ssh/config`:
1. `connections.json` settings (via `conn.getConnectionConfig`): batch mode, password secret, preferred auth (publickey-only), disabled password/kbd-interactive
2. `remote.HasPublicKeyAuth(host)`: PubkeyAuthentication enabled, `publickey` in PreferredAuthentications (if set), and at least one IdentityFile that exists on disk

The IdentityFile existence check is critical — `ssh_config` returns default identity files (`~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc.) even when none are configured, so a non-existent default must not count.

### Why the runtime flag is the primary signal

Config inspection guesses; runtime observation knows. The flag handles cases config can't:
- Passphrase-encrypted keys (IdentityFile set but needs a passphrase → flag = `authPromptUsed`)
- Revoked keys (key fails after first connect → auth-failed clears flag → stops retry storm)
- Agent-only auth (no IdentityFile, agent has the key → flag = `authPromptNone` after first connect)
- Password from secret store (no prompt → flag = `authPromptNone`)

### `sshConfigMu` mutex

`findSshConfigKeywords` reads `~/.ssh/config` via the `ssh_config` library, whose `ReloadConfigs`/`doLoadConfigs` is not thread-safe. `sshConfigMu` (sync.Mutex) serializes all calls to prevent races when multiple connections query the config concurrently (e.g., `HandleSystemResume` iterating connections, scheduler reconnects, `CanReconnectWithoutPrompt` in `DeriveConnStatus`).

## Decision Tree: Which Strategy?

```
Connection goes down
        │
        ▼
CanReconnectWithoutPrompt(connName)?
        │
   ┌────┴────┐
   │ YES     │  (key-based with authPromptNone, cached password, batch mode, secret store)
   │         ▼
   └──► START scheduler
        │
        ▼
   scheduleConnectionReconnect()
        │
        ▼
   Every 5s (3s aggressive):
     AttemptReconnect(ctx, 5s)
       → Connect() → connectInternal()
       → ConnectToClient() → key auth (no prompt)
        │
   ┌────┴──────┬──────────┐
   ▼           ▼          ▼
connected   max 5 min   no durable jobs
(success)   → give up   → give up

   │ NO      │  (password/kbd-interactive, no cache, flag=used, or auth-failed)
   │         ▼
   │    Is Status == Error AND ErrorCode == "auth-failed"?
   │         │
   │    ┌────┴────┐
   │    │ YES     │  (credential rejected)
   │    │         ▼
   │    │    Password prompt stays visible (re-prompt goroutine)
   │    │    User enters new password → cached → Connect() triggered
   │    │    authPromptState cleared to authPromptUnknown
   │    │
   │    │ NO      │  (init, disconnected, or other error)
   │    │         ▼
   │    │    SKIP scheduler. Connection stays in current state.
   │    │    User must manually click [Reconnect] or block remount triggers ConnEnsureCommand.
   │    │    ▸ GAP: tab switch does NOT trigger reconnect (see Phase 8)
   │    │
   └────┴────┘
```

---

## Error Classification & Behavior

| Error Code | Triggered By | Scheduler? | Prompt Behavior |
|------------|-------------|:---:|-----------------|
| `auth-failed` | Wrong password, handshake rejection | ❌ (post-fix) | Re-prompt via background goroutine |
| `dial-error` | DNS, connection refused, **timeout**, network unreachable | ✅ (if autonomous) | For interactive: prompt stays visible (not dismissed) |
| `unknown` | Unclassified errors | ✅ (if autonomous) | Dismiss prompt |
| `user-cancelled` | User clicked Cancel on prompt | ❌ | Prompt dismissed, connection stays in error |

> **Note**: Timeout errors currently classified as `dial-error` (sshclient.go:194-195) cause the frontend to dismiss the prompt on `connchange`. Phase 3A fixes this by not dismissing on non-auth errors.

---

## All 16 Reconnection Triggers (Full Reference)

### Automatic Triggers

| # | Trigger | File:Line | Password? | Non-Password? |
|---|---------|-----------|:---:|:---:|
| 1 | `Event_ConnChange` → `onConnectionDown` → scheduler start | `jobcontroller.go:134,296,661` | Conditional¹ | ✅ |
| 2 | `Event_RouteDown` → `attemptAutoReconnect` (30s cooldown) | `jobcontroller.go:133,381` | Runs² | ✅ |
| 3 | `Event_ConnChange` → `onConnectionUp` → reconnect jobs | `jobcontroller.go:134,290,521` | ✅ | ✅ |
| 4 | System resume (macOS `powerMonitor.on("resume")`) | `emain.ts:325` → `jobcontroller.go:557` | ❌ Skipped³ | ✅ |
| 5 | Block mount `ConnEnsureCommand` | `blockframe.tsx:141` → `wshserver.go` | Conditional⁴ | ✅ |
| 6 | Preview block `ConnEnsureCommand` | `preview-model.tsx:402` | Conditional⁴ | ✅ |
| 7 | Switch connection modal `ConnEnsureCommand` | `conntypeahead.tsx:366` | Conditional⁴ | ✅ |
| 10 | `DurableShellController.startDurableShell` → `EnsureConnection` | `durableshellcontroller.go:248` | Conditional⁴ | ✅ |
| 11 | `StartupReconnectDurableShells` (app start) | `blockcontroller.go:190` | ✅⁵ | ✅ |
| 12 | Scheduler ticker `scheduleConnectionReconnect` | `jobcontroller.go:776` | Conditional¹ | ✅ |
| 14 | `ConnMonitor` stall → auto-disconnect → feeds #1 | `connmonitor.go:154,222` | Feeds #1 | ✅ |

¹ Skipped if `needsInteractiveAuth()` returns true (i.e. `CanReconnectWithoutPrompt` returns false). For auth-failed connections, `CanReconnectWithoutPrompt` returns false (credential rejected) — the scheduler skips and waits for `requestPasswordRePrompt`.  
² Checks `IsConnected()` first, cooldown-based  
³ `needsInteractiveAuth()` → skip fast-path (delegates to `CanReconnectWithoutPrompt`; key-based connections with `authPromptNone` pass, password-based with `authPromptUsed` or unknown skip)  
⁴ Error state reconnects regardless of cached password (`EnsureConnection` always retries from `Status_Error`)  
⁵ `NeedsInteractiveAuth` (startup) uses no-timeout context for connections that may need a prompt (conservative: only trusts runtime flag + cached password, not publickey fallback, because a configured key may be passphrase-encrypted)

### Manual Triggers

| # | Trigger | File:Line | Initiated By |
|---|---------|-----------|-------------|
| 8 | `ConnStatusOverlay` "Reconnect" button → `ConnConnectCommand` | `connstatusoverlay.tsx:299` | User click |
| 9 | Connection typeahead "Reconnect to X" → `ConnConnectCommand` | `conntypeahead.tsx:122` | User click |
| 15 | `ReconnectJob` / `ReconnectJobsForConn` RPC | `jobcontroller.go:1397` | External RPC |
| 16 | `ConnConnectCommand` generic | `wshserver.go:618` | Any frontend RPC |

### Detection (not triggers)

| # | Mechanism | File:Line | Purpose |
|---|-----------|-----------|---------|
| 13 | `waitForDisconnect` goroutine | `conncontroller.go:1575` | Detects remote disconnect → fires connchange |
| — | `ConnMonitor.UpdateLastActivityTime` | `connmonitor.go:60` | Prevents false stall detection |

---

## Known Gaps (to be addressed)

| # | Gap | Priority | Plan Phase |
|---|-----|----------|------------|
| G1 | No tab-switch trigger for disconnected connections | High | Phase 8 |
| G2 | Auth-failed leaves prompt permanently dismissed (no re-prompt without manual Reconnect) | Critical | Phase 6.5 |
| G3 | Password lost when context timeout kills parent goroutine before user responds | High | Phase 2A |
| G4 | `connchange` events not buffered — late windows miss dismissals | High | Phase 5 |
| G5 | Scheduler 5s timeout propagates to password callback (60s→5s) | High | Phase 2B-2C |
| G6 | ConnName lost when `context.Background()` decoupled from connection context (Phase 2 broke ConnName injection) | High | Phase 2D (fixed 2026-06-27) |

---

## Phase 2D: ConnName Injection Fix (2026-06-27)

Phase 2 decoupled the password timeout from the connection context by using `context.Background()` in `sshclient.go` callbacks. However this also removed the `ConnName` from the context, causing:
- Frontend fell through to `pushModal` path → prompt rendered inline without absolute positioning
- `ModalsRenderer` rendered the prompt as a flex child → occupied space, pushed content right
- `connchange(connected)` dismissal only cleared `activeUserInputPromptsAtom`, not `modalsAtom` → prompt persisted

**Fix**: All 5 `GetUserInput` call sites in `sshclient.go` now explicitly set `request.ConnName` from `genconn.GetConnData(connCtx).GetConnName()`. Frontend `global.ts` always uses `upsertUserInputPrompt` (overlay path) — no more `pushModal` fallback.

---

## Key Files

| File | Role |
|------|------|
| `pkg/jobcontroller/jobcontroller.go` | Scheduler, `onConnectionDown`, `needsInteractiveAuth` (delegates to `CanReconnectWithoutPrompt`), system resume |
| `pkg/remote/conncontroller/conncontroller.go` | `Connect()`, `EnsureConnection`, `AttemptReconnect`, password cache, `CanReconnectWithoutPrompt`, `authPromptState`, `authPrompt*` constants |
| `pkg/remote/sshclient.go` | `ConnectToClient`, `AuthTracker` (password/passphrase/kbd-interactive prompt tracking), `HasPublicKeyAuth` (~/.ssh/config fallback), `ClassifyConnError` |
| `pkg/userinput/userinput.go` | `GetUserInput`, window scope resolution |
| `pkg/service/userinputservice/userinputservice.go` | `SendUserInputResponse` handler |
| `pkg/wps/wps.go` | Event broker, buffering, scoping |
| `frontend/app/store/modalmodel.ts` | `activeUserInputPromptsAtom`, dismiss, reset |
| `frontend/app/store/global.ts` | `subscribeToConnEvents`, prompt event handler |
| `frontend/app/block/connstatusoverlay.tsx` | Reconnect button, status display |
| `frontend/app/block/blockframe.tsx` | `ConnEnsureCommand` on mount, `UserInputPromptOverlay` |
| `frontend/app/tab/tabuserinputpromptoverlay.tsx` | Tab-level password prompt overlay (phase 1) |
| `frontend/app/workspace/workspace.tsx` | Overlay rendering at workspace level (phase 1 fix) |
| `frontend/app/modals/userinputprompt.tsx` | Password prompt component |

---

## Phase 2E: Job Reconnect Convergence & Bounded Retry (2026-07-18)

### Convergence invariant (new)

**After a connection reaches `Connected`, every job on that connection must reach a terminal state — `Connected` (route up + active stream) or `Done` (`JobManagerGone`) — never silently stuck `Disconnected`.**

Prior to this phase, `onConnectionUp` could finish with `successCount < len(jobsToReconnect)` and leave the remaining jobs `Disconnected` with no retry. The conn-level status (`connchange`) reported `Connected` (green icon), but `jobConnStates[jobId]` stayed `Disconnected`, so `CheckJobConnected` rejected `SendInput` with `"job is not connected (status: disconnected)"`. The only recovery path was an external trigger (tab switch → `ConnEnsureCommand`, or a subsequent `onConnectionUp`).

### Incident that motivated this

Sleep/wake on a cellular + WireGuard link. `onConnectionUp("jeremy@dev2.jlam.io")` reconnected after a 21.9s scheduler wait. The conn had 3 durable jobs. With a **single shared 5s context** for the whole function:

- Job 1 (`d0d4d086`): `RemoteReconnectToJobManagerCommand` RPC hit its own `rpcOpts.Timeout=5000` at 07:28:43.303 — remote wsh was still tearing down a stale job-manager socket and responded at 07:28:48.577 (10.3s).
- Jobs 2/3 (`896db6a5`, `f669b04a`): never sent an RPC — `DBMustGet` at the top of `doReconnectJob` hit `context deadline exceeded` because the shared 5s ctx was already expired by the time the loop reached them.
- Result: `finished reconnecting jobs: 0/3 successful`. Conn stayed `Connected` (green), 2 jobs stuck `Disconnected` until a manual tab switch at 07:30:44 recovered one of them (f669b04a, via `ConnEnsureCommand`). d0d4d086/896db6a5 remained dead.

Root cause was **not** remote latency alone — it was local-side contention: one slow job's 5s RPC consumed the shared 5s ctx, starving jobs 2/3 before they could start. The remote wsh responds in <1s once settled (f669b04a's solo tab-switch reconnect took 0.7s end-to-end).

### The two independent timeouts in `doReconnectJob`

`doReconnectJob` (`jobcontroller.go:1408`) has two deadlines that must not be confused:

1. **`rpcOpts.Timeout = 5000`** on the `RemoteReconnectToJobManagerCommand` RPC (`jobcontroller.go:1465`). This is the per-call SSH round-trip deadline. It is **not** derived from the caller's `ctx`. It governs how long we wait for the remote wsh to respond.
2. **The caller's `ctx`** (passed to `doReconnectJob`), which feeds `DBMustGet`, `DBUpdateFn`, `sendBlockJobStatusEventByJob`, and `WaitForRegister` (capped at 2s via `context.WithTimeout`).

Keeping `rpcOpts.Timeout=5000` preserves snappiness in the common case (remote responds in <1s). Raising it would make every reconnect potentially block 5→15s. The fix is **not** to raise the RPC timeout — it's to stop sharing one ctx across all jobs and to retry the failures.

### Changes

**1. Per-job context in `onConnectionUp` and `ReconnectJobsForConn`** (`jobcontroller.go:543`, `:1514`)

Replace the single shared `context.WithTimeout(background, 5s)` for the whole job loop with:
- A short ctx (5s) for the `DBGetAllObjsByType` job lookup only.
- A **fresh `context.WithTimeout(background, 10s)` per `ReconnectJob` call**. 10s gives `RPC(5s) + WaitForRegister(2s) + slack`; common case is still <1s because the ctx is a safety bound, not the RPC timeout.

This eliminates starvation: a slow job 1 no longer dooms jobs 2…N. Both `onConnectionUp` (trigger #3) and `ReconnectJobsForConn` (trigger #15) have the identical shared-ctx pattern and must be fixed together.

**2. Bounded retry of failed jobs in `onConnectionUp`** (`jobcontroller.go:543`)

After the initial loop, if `successCount < len(jobsToReconnect)`, retry the failed jobs with **3 attempts at 3s/6s/12s backoff**. Per attempt:
- Re-check `conncontroller.IsConnected(connName)`; abort the retry if the conn is down (avoids firing RPC into a dead conn during a flap).
- Skip jobs whose `JobManagerStatus == Done` (set by `JobManagerGone` in `doReconnectJob` — terminal, not retryable).
- Stream-health-aware skip: if `CheckJobConnected` succeeds and `jobStreamHealth.active == true`, the job is converged — skip. This avoids masking the Layer 3 "Connected-but-no-stream" bug (see decisions.md 2026-07-12).
- Use `ReconnectJob` (singleflight-deduped via `reconnectConnGroup`) so concurrent triggers collapse.

The retry recovers the train/WireGuard case: attempt 1 fails at 5s (remote still settling), attempt 2 at +3s hits a settled remote and succeeds in <1s — matching f669b04a's solo tab-switch timing. Aborts on conn-down between attempts (the 07:28:13→16→38 flap would not waste attempts).

**3. Document the convergence invariant** (this section). The spec previously documented triggers but not the post-condition. The retry loop in (2) is the enforcement mechanism; the invariant makes the expected behavior testable and prevents regressions.

**4. `rpcOpts.Timeout` stays 5000** (no change). Raising it would trade snappiness for a rare slow-remote case that the retry already handles.

### Constants

| Constant | Value | Where | Purpose |
|---|---|---|---|
| Per-job reconnect ctx | 10s | `onConnectionUp`, `ReconnectJobsForConn` | Bounds `DBMustGet` + `WaitForRegister` per job; RPC has its own 5s timeout |
| Job-lookup ctx | 5s | `onConnectionUp`, `ReconnectJobsForConn` | Bounds `DBGetAllObjsByType` only |
| `rpcOpts.Timeout` (unchanged) | 5s | `doReconnectJob:1465` | Per-call SSH round-trip deadline |
| Retry attempts | 3 | `onConnectionUp` | Bounded retry of failed jobs |
| Retry backoff | 3s, 6s, 12s | `onConnectionUp` | Sleep before each retry attempt |

### What this does NOT change

- `rpcOpts.Timeout` (snappiness preserved for the common case)
- `attemptAutoReconnect` (RouteDown handler, 30s cooldown) — independent path
- `scheduleConnectionReconnect` (5s scheduler) — independent path
- `HandleSystemResume` fast-path — calls `AttemptReconnect`, not `onConnectionUp`
- The Layer 3 "Connected-but-no-stream" fix (decisions.md 2026-07-12) — separate, though the retry's stream-health-aware skip avoids masking it

### Detection (how to verify)

After a sleep/wake with a slow link, grep the backend log:
```
grep "finished reconnecting jobs" <log>            # should be N/N, not 0/N

grep "retry.*reconnect" <log>                       # new: retry attempts logged
grep "aborting retry.*conn down" <log>             # new: conn-down aborts
grep "error reconnecting" <log>                    # should be followed by a retry, not terminal
```
Regression signal: `finished reconnecting jobs: 0/N` with no subsequent retry, followed by `SendInput` failing with `job is not connected`.

---

## Phase 2F: Startup-Failed Connection Retry (2026-07-18)

### The gap

`StartupReconnectDurableShells` (`blockcontroller.go:190`) is the only reconnect path that runs at app start. For each durable shell's connection, it calls `EnsureConnection` **once** with a 10s ctx (non-interactive) or no-deadline ctx (interactive). On failure, the startup goroutine logs and returns — there is no retry.

The ongoing reconnect scheduler (`scheduleConnectionReconnect`, 5s interval, 5min cap) is the natural retry mechanism, but it only starts via `onConnectionDown`, which fires on a **Connected→Disconnected transition**. A connection that was never `Connected` (startup failed before the handshake completed) never produces that transition:

| Event | `cs.actual` before | `connStatus.Connected` | Transition? | `onConnectionDown` fires? |
|---|---|---|---|---|
| Connecting (first event) | `false` (initial) | `false` | No | No |
| Error (after startup fail) | `false` | `false` | No | No |

`handleConnChangeEvent` (`jobcontroller.go:488`) only increments `actualGen` when `cs.actual != connStatus.Connected`. A conn that starts at `actual: false` and stays `false` (Connecting→Error) never signals `reconcileConn`, so `onConnectionDown` never fires, and `scheduleConnectionReconnect` never starts. The conn sits in `Status_Error` indefinitely — no `ConnMonitor` (only created on successful connect), no periodic retry, no wake-event retry (`HandleSystemResume` is wake-event only). Recovery requires an app restart (which re-runs the one-shot startup) or a manual reconnect.

This is symmetric to Phase 2E: Phase 2E was "conn up but jobs didn't reconnect"; Phase 2F is "conn never came up at startup."

### The fix

When `EnsureConnection` fails at startup for a **non-interactive-auth** connection, explicitly start `scheduleConnectionReconnect` via a new exported entry point `StartConnectionReconnectScheduler`. This reuses the existing scheduler (5s interval, 5min cap, aggressive mode on network errors) — no new retry loop.

**Why non-interactive-auth only:** Interactive-auth connections have a persistent password-prompt buffer (`requestPasswordRePrompt`) that handles retries independently. Starting the scheduler for them would race with the re-prompt goroutine and retry with no cached password. This matches `onConnectionDown`'s existing `needsInteractiveAuth` guard.

**Why reuse the existing scheduler:** The dedup map (`connectionReconnectSchedulers`) ensures only one scheduler per connection. If the conn comes up during the 5min window, the scheduler stops (`IsConnected` check at loop top). If all durable blocks are closed while the conn is down, the scheduler stops (`hasRunningDurableJobsForConn` check). If a real disconnect happens later, `onConnectionDown` sees the existing scheduler and skips — no double-spawn.

### Changes

**1. Extract `startReconnectScheduler` shared helper** (`jobcontroller.go`)

`onConnectionDown` currently contains the guard + dedup + spawn logic. Extract it into a shared `startReconnectScheduler(connName string)` that both `onConnectionDown` and `StartConnectionReconnectScheduler` call. `onConnectionDown` keeps its "connection became disconnected" log, then delegates. The shared helper:
- Skips local connections (`IsLocalConnName`)
- Skips if `needsInteractiveAuth(connName)` (interactive-auth guard)
- Deduplicates via `connectionReconnectSchedulers`
- Spawns `scheduleConnectionReconnect` goroutine with `panichandler`

**2. Export `StartConnectionReconnectScheduler`** (`jobcontroller.go`)

New exported function: logs `"starting reconnect scheduler after startup failure"`, then calls `startReconnectScheduler`. Called by `blockcontroller.StartupReconnectDurableShells` on `EnsureConnection` failure.

**3. Call it from `StartupReconnectDurableShells`** (`blockcontroller.go:190`)

After `EnsureConnection` fails, call `jobcontroller.StartConnectionReconnectScheduler(connName)`. The guard (local skip, interactive-auth skip) is inside `startReconnectScheduler` — the call site does not duplicate it. The function returns immediately (spawns a goroutine), so the startup goroutine is not blocked.

**4. Test hooks** (`jobcontroller.go`, exported for cross-package test access)

- **`NeedsInteractiveAuthTestHook func(connName string) bool`** — `needsInteractiveAuth` checks it before delegating to `conncontroller.CanReconnectWithoutPrompt`. Lets tests force the guard open/closed without depending on `conncontroller` internals (`authPromptState`, `hasPublicKeyAuthForTest`).
- **`StartupReconnectSchedulerTestHook func(connName string)`** — when set, `StartConnectionReconnectScheduler` calls the hook instead of `startReconnectScheduler`. Used by `blockcontroller` wiring tests to verify the call site without running the real scheduler goroutine.
- **`ConnectionReconnectSchedulerExists(connName string) bool`** — exported accessor for `connectionReconnectSchedulers.GetEx`. Used by `blockcontroller` tests to observe scheduler state cross-package (the map itself is unexported).
- **`GetAllBlocksForReconnectTestHook func() []ReconnectDurableBlock`** (`blockcontroller.go`) — overrides the wstore block lookup in `StartupReconnectDurableShells`. Returns pre-filtered durable blocks directly, avoiding wstore/`IsBlockTermDurable`. The `ReconnectDurableBlock` struct (BlockId, ConnName, JobId) is exported for the hook's return type.

### What this does NOT change

- `EnsureConnection`'s 10s ctx (non-interactive) / no-deadline ctx (interactive) — unchanged. The 10s bounds the SSH handshake for the startup attempt; the scheduler's 5s `connectTimeout` (in `scheduleConnectionReconnect`) bounds subsequent attempts.
- `onConnectionDown` behavior — refactored to delegate to `startReconnectScheduler`, but the guard/dedup/spawn logic is identical. `TestOnConnectionDownDeduplication` still passes.
- The scheduler's 5s `connectTimeout` vs startup's 10s — the scheduler uses a shorter timeout per attempt than startup. This is the existing behavior for all reconnects (post-disconnect); changing it is out of scope.
- Interactive-auth startup failures — no scheduler started. `requestPasswordRePrompt` handles re-prompts independently (persistent buffer model).

### Detection (how to verify)

After an app start where a key-based durable conn fails to connect (e.g., network down at startup, remote unreachable):
```
grep "starting reconnect scheduler after startup failure" <log>   # new: scheduler started
grep "reconnect scheduler started" <log>                           # existing: scheduleConnectionReconnect began
grep "scheduler attempt" <log>                                     # existing: 5s retry attempts
grep "connection is back up, stopping reconnect scheduler" <log>  # existing: scheduler stopped on success
```
Regression signal: `failed to establish connection` at startup with no subsequent `reconnect scheduler started` line, and the conn sits in `Status_Error` until manual reconnect or app restart.

---

## Phase 2G: Resume-from-Sleep Renderer Unpause (2026-07-21)

### The gap

After OS sleep/wake, a durable remote terminal block shows "connected" but typing produces no visible output. Keystrokes ARE sent (visible after an app restart, which rebuilds the terminal from WaveFS). Devtools shows `[PW-CONN] connected` and `setFocusedChild`.

This is **not** a backend stream bug. The backend reconnection is fully successful (all jobs reconnect, `restartStreaming` runs, new output loops start, data appends to WaveFS). The bug is in the **frontend xterm.js renderer pause state**.

### Root cause

xterm.js `RenderService` (`@xterm/xterm` 6.1.0-beta, `src/browser/services/RenderService.ts`) gates every render behind `_isPaused`:
- `RenderService.refreshRows()` early-returns (`_needsFullRefresh = true; return`) when `_isPaused` is true.
- `_isPaused` is set/cleared only by `_handleIntersectionChange` — the `IntersectionObserver` callback. `true` when the terminal element is NOT intersecting the viewport (background tab/split).
- After OS sleep/wake, Chromium's `IntersectionObserver` often does **not** re-fire (the element's intersection didn't change — visible before suspend, visible after). `_isPaused` stays stuck at its pre-sleep value.

The existing fix (commit `9aacb9e7`) added `refreshAfterVisibilityChange()` in `frontend/app/view/term/termwrap.ts`, triggered by `document.visibilitychange`. But it only called `renderer.renderRows(0, rows-1)` directly — a **one-shot** render of the current buffer. It did **not** reset `_isPaused = false`. So:
- Pre-sleep buffer content renders once → terminal looks "connected" with old content.
- Subsequent `terminal.write()` calls (from `handleNewFileSubjectData` → `doTerminalWrite`) trigger `RenderService.refreshRows()`, which still early-returns because `_isPaused` is still `true`.
- New output writes to xterm.js's internal buffer but never reaches the canvas → typing invisible.
- App restart rebuilds the terminal from WaveFS → everything visible.

### The fix

In `refreshAfterVisibilityChange`, reset `_isPaused` then refresh via the normal `RenderService.refreshRows` path:
```ts
const core = (this.terminal as any)._core;
const renderService = core?._renderService;
if (renderService) {
    renderService._isPaused = false;                  // unpause
    renderService.refreshRows(0, this.terminal.rows - 1);
} else {
    const renderer = core?._renderService?._renderer?.value;  // fallback (original approach)
    if (renderer && typeof renderer.renderRows === "function") {
        renderer.renderRows(0, this.terminal.rows - 1);
    }
}
this.fitAddon.fit();
```
Uses the same private-API access pattern already in the file (`core._renderService._renderer.value` in `fitaddon.ts`). Calling `refreshRows` (not `renderer.renderRows`) ensures the render debouncer and `_needsFullRefresh` are handled correctly, and future `terminal.write()` calls render normally because `_isPaused` is now `false`.

### Why `visibilitychange` and not IntersectionObserver directly

`document.visibilitychange` fires reliably on sleep/wake (the document visibility state transitions to `hidden` on suspend and back to `visible` on resume). The `IntersectionObserver` does NOT reliably fire on resume because the element's intersection with the viewport didn't change — it was visible before and visible after. The observer only fires on intersection transitions, not on visibility-state transitions. This is why the `9aacb9e7` fix used `visibilitychange` (correct trigger) but the render approach was incomplete (didn't reset `_isPaused`).

### What this does NOT change

- The `IntersectionObserver`-driven pause for background tabs/splits — still works normally for genuine visibility changes (switching tabs, hiding splits).
- `fitAddon.fit()` — still called after the unpause (dimensions may change while hidden).
- Backend stream reconnection — untouched (the backend was never the problem).

### Detection (how to verify)

After sleep/wake on a connected durable terminal:
1. Type — output should appear immediately (not invisible).
2. Devtools console: before the fix, `core._renderService._isPaused` would be `true` after resume; after the fix, `refreshAfterVisibilityChange` sets it to `false`.
3. No app restart needed to see typed text.

Regression signal: typing invisible after sleep/wake, fixed by app restart → `_isPaused` stuck `true`.

---

## Phase 2H: Output-Loop Goroutine Leak on Reconnect (2026-07-21)

### The gap

`runOutputLoop` goroutines never exit on reconnect. Across a 10k-line backend log: **85 "output loop started"**, **0 "output loop finished"**, **0 "superseded"**.

Each reconnect calls `restartStreaming`, which creates a new `streamclient.Reader` (new streamId) and overwrites `jobStreamIds[jobId]`. The old output loop's `reader.Read()` blocks forever because:
- The old streamId never receives more data (the new stream uses a different streamId).
- The supersession check at the top of `runOutputLoop`'s read loop only runs AFTER `reader.Read()` returns — and `Read()` never returns (no data, no EOF, no error on an idle stream).
- `onConnectionDown` does not close old readers.

Each reconnect leaks one goroutine + one broker reader per job. Over a long session with many sleep/wake cycles, this accumulates (the log shows 12+ reconnect cycles for one connection).

### Why this doesn't cause the "typing invisible" symptom

The new stream's reader receives data correctly — `processRecvData` keys by `streamId`, so data routes to the new reader. The leaked old readers just sit blocked on `Read()`. This is a resource leak, not a correctness bug.

### The fix

Added `jobReaders` (`ds.MakeSyncMap[*streamclient.Reader]`) to track the active reader per job. In `restartStreaming`:
1. Retrieve the previous reader from `jobReaders` before creating the new one.
2. Create the new reader, set `jobStreamIds` to the new streamId, store the new reader in `jobReaders`.
3. Close the previous reader (`prevReader.Close()`).

The ordering is critical: `jobStreamIds.Set(newId)` must happen BEFORE `prevReader.Close()` so the old `runOutputLoop`'s supersession check (`currentStreamId != streamId`) sees the new streamId and exits cleanly ("stream superseded by [new]"). If the streamId were not updated first, the old loop would hit the error path (`io.ErrClosedPipe` → `tryTerminateJobManager`), which is incorrect for a supersession.

`Reader.Close()` sets `closed = true`, `err = io.ErrClosedPipe`, and broadcasts the cond — unblocking `Read()`. It also sends a cancel ack via the broker, which triggers `cleanupReader` (removing the reader from `broker.readers`). `Reader.Close()` is idempotent (safe to call on an already-closed reader), so the `runOutputLoop` defer (`defer reader.Close()`) is safe even after `restartStreaming` already closed it.

`StartJob` also stores its reader in `jobReaders` (for consistency, though there's no previous reader to close on the first stream).

### What this does NOT change

- `onConnectionDown` still does not close readers (the conn-down → conn-up cycle creates a new stream via `restartStreaming`, which now closes the old reader). Closing readers on conn-down would be an alternative approach, but `restartStreaming` is the natural single chokepoint (all reconnect paths funnel through it).
- The error paths in `restartStreaming` (JobPrepareConnectCommand failure, StreamDone, JobStartStreamCommand failure) call `reader.Close()` on the NEW reader. The `jobReaders` entry still points to the old reader (or the new one, depending on timing), but the next `restartStreaming` call will close it (idempotent). No cleanup of `jobReaders` on error paths is needed.
- `jobReaders` entries are overwritten on each reconnect (bounded by the number of active jobs). No explicit cleanup on job termination is needed.

### Detection (how to verify)

After a reconnect cycle, grep the backend log:
```
grep "output loop finished" <log>    # should now appear (was 0 before the fix)
grep "stream superseded" <log>        # should appear when restartStreaming closes the old reader
```
Before the fix: 85 "output loop started", 0 "output loop finished", 0 "superseded".
After the fix: each reconnect's old output loop should log "stream superseded by [new]" and "output loop finished".

### Test coverage

- `TestRunOutputLoopExitsOnReaderCloseWithSupersession`: Verifies that closing the old reader (after updating `jobStreamIds`) causes `runOutputLoop` to exit via the supersession path (clean break, no DB access), not the error path. This is the core invariant that prevents the leak.
- `TestRestartStreamingClosesPrevReader`: Verifies the `jobReaders` map mechanics (retrieve prev, set new streamId, close prev, store new) and `Reader.Close()` idempotency.
