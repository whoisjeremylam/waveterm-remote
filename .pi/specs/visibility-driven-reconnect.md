# Visibility-Driven Reconnect & Auto-Reconnect Fixes — Spec

> Status: Spec (awaiting approval)
> Created: 2026-07-07
> Design reference: [[reconnection-design.md]]
> Implementation reference: [[reconnection.md]]

## Problem

Two related bugs prevent waveterm-remote from feeling "connected all along":

1. **Key-based connections never auto-reconnect on wake.** `needsInteractiveAuth` / `canAutoReconnectLocked` infer "needs interactive auth" from SSH's default auth-method flags (password/kbd-interactive default to enabled when nil), so key-based connections are wrongly classified as interactive. The background scheduler (`onConnectionDown`) and `HandleSystemResume` both skip them. The UI's `CanAutoReconnect` flag is also false, so the retry/countdown overlay never shows.

2. **No reconnect on tab switch / app focus.** There is no trigger that re-establishes a disconnected connection when the user's attention returns to it. `TermResyncHandler` only fires `resyncController` on a status *change*; the backend `ResyncController` → `CheckConnStatus` returns an error for a down connection without reconnecting. The user must click "Reconnect".

Two supporting issues compound the above:

3. **Stall auto-disconnect clears the cached password.** `disconnectOnStall` → `Close()` → `clearCachedPassword()`. An involuntary network drop (sleep/wake) wipes the cached password, so even password connections that *would* auto-reconnect silently lose their cache ~10s after wake.

4. **Multiple password prompts render simultaneously on one tab.** `TabUserInputPromptOverlay` maps over all matching connections. When visibility-driven reconnect fires `EnsureConnection` for two disconnected password-connections on the same tab, both prompts appear at once. The desired UX is serialized: one prompt at a time.

## Goals

- Key-based connections auto-reconnect on wake and on background scheduler, silently.
- Switching to a tab (or focusing the app) with a disconnected terminal block triggers a reconnect, so the user doesn't click "Reconnect".
- Involuntary disconnects (stall, TCP drop) do not clear the cached password.
- Multiple connections needing passwords on one tab prompt sequentially, not simultaneously.

## Non-goals

- IntersectionObserver-based per-block visibility triggers (deferred).
- Tracking `LastAuthMethod` from the SSH handshake (future enhancement; heuristic is sufficient).
- Network-online polling (deferred).
- Changing the password prompt's non-modal, per-tab scoping model.

---

## Change 1 — Fix the "can reconnect without a prompt" heuristic

### Files
- `pkg/jobcontroller/jobcontroller.go` — `needsInteractiveAuth`
- `pkg/remote/conncontroller/conncontroller.go` — `canAutoReconnectLocked`

### Current (buggy) logic

Both functions return `true` (interactive) when `SshPasswordAuthentication` or `SshKbdInteractiveAuthentication` are nil/unset (SSH defaults), regardless of whether the connection has ever connected via key.

### New logic

Add a check: if the connection has connected successfully before **and** no password secret is configured, treat it as non-interactive. This covers key-based connections that have proven they don't need a password.

**`needsInteractiveAuth` (`jobcontroller.go`):**

```go
func needsInteractiveAuth(connName string) bool {
    if conncontroller.HasCachedPassword(connName) {
        return false
    }
    config := wconfig.GetWatcher().GetFullConfig()
    connConfig, ok := config.Connections[connName]
    if !ok {
        return true // unknown connection, assume interactive
    }
    if utilfn.SafeDeref(connConfig.SshBatchMode) {
        return false
    }
    if connConfig.SshPasswordSecretName != nil && *connConfig.SshPasswordSecretName != "" {
        return false
    }
    if connConfig.SshPreferredAuthentications != nil {
        hasInteractive := false
        for _, method := range connConfig.SshPreferredAuthentications {
            if method == "password" || method == "keyboard-interactive" {
                hasInteractive = true
                break
            }
        }
        if !hasInteractive {
            return false
        }
    }
    // NEW: a connection that has connected successfully before without a password
    // secret configured is key-based (or otherwise non-interactive). SSH will try
    // keys first on reconnect; if the key fails, it falls back to the password
    // callback, which prompts — but that's a rare, correct-to-surface case.
    if hasConnectedSuccessfully(connName) && connConfig.SshPasswordSecretName == nil {
        return false
    }
    passwordAuth := connConfig.SshPasswordAuthentication == nil || utilfn.SafeDeref(connConfig.SshPasswordAuthentication)
    kbdAuth := connConfig.SshKbdInteractiveAuthentication == nil || utilfn.SafeDeref(connConfig.SshKbdInteractiveAuthentication)
    return passwordAuth || kbdAuth
}
```

**`hasConnectedSuccessfully` helper** (new, in `jobcontroller.go`):

```go
// hasConnectedSuccessfully returns true if the connection has connected at least
// once before (LastConnectTime > 0). Used to infer key-based / non-interactive auth.
func hasConnectedSuccessfully(connName string) bool {
    if conncontroller.IsLocalConnName(connName) {
        return false
    }
    connOpts, err := remote.ParseOpts(connName)
    if err != nil {
        return false
    }
    conn := conncontroller.MaybeGetConn(connOpts)
    if conn == nil {
        return false
    }
    return conn.HasConnected()
}
```

**`canAutoReconnectLocked` (`conncontroller.go`):** mirror the same change — add the `HasConnected && no password secret` short-circuit before the default-flags check. Since `canAutoReconnectLocked` is a method on `SSHConn` with `conn.lock` held, it can read `conn.LastConnectTime > 0` directly rather than going through the `hasConnectedSuccessfully` helper.

**`SSHConn.HasConnected()`** (new method, `conncontroller.go`):

```go
func (conn *SSHConn) HasConnected() bool {
    conn.lock.Lock()
    defer conn.lock.Unlock()
    return conn.LastConnectTime > 0
}
```

### Behavior

| Connection type | `HasConnected` | Secret store | Result |
|---|---|---|---|
| Key-based, never connected | false | nil | interactive (conservative — first connect must prompt if needed) |
| Key-based, connected before | true | nil | **non-interactive** (the fix) |
| Password, cached | — | — | non-interactive (existing) |
| Password, secret store | — | set | non-interactive (existing) |
| Password, no cache, no secret, never connected | false | nil | interactive (existing) |

### Test cases

| # | Setup | Expected |
|---|---|---|
| 1.1 | Key-based conn, `LastConnectTime > 0`, no secret → `needsInteractiveAuth` | `false` |
| 1.2 | Same conn → `canAutoReconnectLocked` | `true` |
| 1.3 | Key-based conn, never connected (`LastConnectTime = 0`) → `needsInteractiveAuth` | `true` (conservative) |
| 1.4 | Password conn, `HasCachedPassword` true → `needsInteractiveAuth` | `false` |
| 1.5 | Password conn, `SshBatchMode` true → `needsInteractiveAuth` | `false` |
| 1.6 | Conn with `PreferredAuthentications = ["publickey"]` → `needsInteractiveAuth` | `false` |
| 1.7 | Unknown conn (not in config) → `needsInteractiveAuth` | `true` |

---

## Change 2 — Don't clear cached password on involuntary disconnect

### Files
- `pkg/remote/conncontroller/conncontroller.go` — `Close()`, and a new `closeInvoluntary` helper or flag

### Current (buggy) logic

`Close()` unconditionally calls `clearCachedPassword()`. All callers:

| Caller | Location | User-initiated? | Should clear cache? |
|---|---|---|---|
| `DisconnectClient` | `conncontroller.go:1888` | Yes (programmatic disconnect API) | Yes |
| `ConnDisconnectCommand` (SSH) | `wshserver.go:615` | Yes (Disconnect button RPC) | Yes |
| `ConnDisconnectCommand` (WSL) | `wshserver.go:605` | Yes (wslconn, different type — N/A) | N/A |
| `disconnectOnStall` | `connmonitor.go:248` | **No** (involuntary) | **No** |
| `HandleSystemResume` stall path | `jobcontroller.go:590` | **No** (involuntary) | **No** |

### New logic

Split the cache-clear intent. Two options:

**Option A (preferred): explicit-clear flag on `Close`.**

```go
func (conn *SSHConn) Close() error {
    return conn.closeInternal(true /* clearPassword */)
}

// CloseInvoluntary disconnects without clearing the cached password.
// Used by stall auto-disconnect and other non-user-initiated disconnects.
func (conn *SSHConn) CloseInvoluntary() error {
    return conn.closeInternal(false /* clearPassword */)
}

func (conn *SSHConn) closeInternal(clearPassword bool) error {
    conn.lifecycleLock.Lock()
    defer conn.lifecycleLock.Unlock()
    conn.WithLock(func() {
        if conn.Status == Status_Connected || conn.Status == Status_Connecting {
            conn.Status = Status_Disconnected
        }
        conn.ConnHealthStatus = ConnHealthStatus_Good
    })
    if clearPassword {
        conn.clearCachedPassword()
    }
    conn.FireConnChangeEvent()
    conn.closeInternal_withlifecyclelock(nil)
    return nil
}
```

Update the two involuntary callers to use `CloseInvoluntary()`:
- `disconnectOnStall` (`connmonitor.go:248`): `cm.Conn.Close()` → `cm.Conn.CloseInvoluntary()`
- `HandleSystemResume` stall path (`jobcontroller.go:590`): `conn.Close()` → `conn.CloseInvoluntary()`

The explicit-disconnect callers (`DisconnectClient`, `ConnDisconnectCommand`) keep using `Close()` (which clears).

### Test cases

| # | Setup | Expected |
|---|---|---|
| 2.1 | Stall disconnect (`disconnectOnStall`) → `CloseInvoluntary` → `getCachedPassword()` | returns cached password (not nil) |
| 2.2 | `HandleSystemResume` stall-disconnect path → `CloseInvoluntary` → `getCachedPassword()` | returns cached password (not nil) |
| 2.3 | Explicit Disconnect button → `Close()` → `getCachedPassword()` | nil |
| 2.4 | `DisconnectClient` (programmatic) → `Close()` → `getCachedPassword()` | nil |
| 2.5 | `auth-failed` in `Connect` → `clearCachedPassword` | nil (unchanged) |
| 2.6 | Stall disconnect, then `HandleSystemResume` reconnect | Uses cached password silently, no prompt |

---

## Change 3 — Visibility-driven reconnect on tab switch / app focus

### Files
- `frontend/app/view/term/term.tsx` or a new hook — detect tab activation / app focus, fire reconnect
- `frontend/app/store/wshclientapi.ts` — already has `ConnConnectCommand` (no new RPC needed)
- `pkg/wshrpc/wshserver/wshserver.go` — `ConnConnectCommand` already calls `EnsureConnection` (no backend change needed)

### Design

`EnsureConnection` (backend) is already idempotent and cooldown-guarded:
- `Status_Connected` → returns nil immediately
- `Status_Connecting` → waits on `WaitForConnect` / `pendingAuth`
- `Status_Init` / `Status_Disconnected` → checks `isWithinConnectCooldown` (5s), then calls `Connect()`
- `Status_Error` → always retries `Connect()`

So the frontend just needs to call `ConnConnectCommand` for each unique disconnected/error connection on the visible tab. The backend dedupes.

### Trigger points

1. **Tab switch** — when the active tab changes, scan the new tab's blocks for terminal blocks with disconnected/error connections, fire `ConnConnectCommand` per unique connection.
2. **App window focus** — when the Electron window gains focus (`window.addEventListener("focus")` or renderer focus), re-scan the active tab similarly. This catches the "switch away from waveterm and back" case.

Both should be **debounced/coalesced** (e.g., 200ms) so rapid tab switches don't fire multiple reconnect storms.

### Implementation sketch (frontend)

A new function, e.g. in `term-model.ts` or a shared `connectionReconnect.ts`:

```ts
// Fire ConnConnectCommand for each unique disconnected/error connection
// among the given blocks. Idempotent — backend cooldown handles dedup.
export async function reconnectDisconnectedConns(blockIds: string[]) {
    const seenConns = new Set<string>();
    for (const blockId of blockIds) {
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        const connName = block?.meta?.connection;
        if (!connName || isLocalConnName(connName) || isWslConnName(connName)) continue;
        if (seenConns.has(connName)) continue;
        seenConns.add(connName);
        const status = globalStore.get(getConnStatusAtom(connName));
        if (status?.status === "disconnected" || status?.status === "error") {
            // fire-and-forget; backend serializes via cooldown
            RpcApi.ConnConnectCommand(TabRpcClient, { host: connName, logblockid: blockId }, { timeout: 60000 })
                .catch((e) => console.log("visibility reconnect error", connName, e));
        }
    }
}
```

Wire it into:
- Tab activation (wherever `setActiveTab` is consumed / the active tab's blockIds become known)
- Window focus

### Status transitions (no stacking)

`Connect()` sets `Status = Connecting` at the start (overwriting `Disconnected`/`Error`), then `Connected` or back to `Error`. The frontend `connchange` handler replaces the atom's value, so the overlay transitions cleanly: `Disconnected` → `Connecting` (overlay shows "Connecting…") → `Connected` (overlay vanishes) or → `Disconnected`/`Error` (overlay re-shows with error). There is no stacking.

### Test cases

| # | Setup | Expected |
|---|---|---|
| 3.1 | Tab with one disconnected key-based conn → switch to tab | `ConnConnectCommand` fired; conn reconnects silently |
| 3.2 | Tab with two disconnected conns (same conn) → switch | One `ConnConnectCommand` (dedup by connName) |
| 3.3 | Tab with connected conn → switch | No `ConnConnectCommand` fired |
| 3.4 | Rapid tab switches (5x in 1s) | Coalesced; at most one reconnect attempt per 5s cooldown |
| 3.5 | Reconnect in-flight → switch tab again | `EnsureConnection` returns nil (waits on `WaitForConnect` / cooldown) |
| 3.6 | Disconnected durable shell → switch tab → conn reconnects | `onConnectionUp` reconnects the job automatically |

---

## Change 4 — Serialize password prompts across connections on one tab

### Files
- `pkg/remote/conncontroller/conncontroller.go` — per-connection prompt serialization is mostly there (`setPendingAuth`); needs a per-**tab** coordination layer
- `pkg/userinput/userinput.go` — prompt scoping
- `frontend/app/tab/tabuserinputpromptoverlay.tsx` — render only one prompt at a time

### Current behavior

`TabUserInputPromptOverlay` renders all matching prompts simultaneously via `.map`. `setPendingAuth` dedupes per-connection (one `Connect()` / one prompt per conn), but does not serialize across connections.

### Design

Backend serialization is preferred (per the user's decision). Two layers:

**Layer 1 — Per-connection dedup (existing):** `setPendingAuth` ensures only one `Connect()` per connection at a time. If a second `Connect()` for the same conn is attempted, it waits on `pendingAuthDone`. This is already correct.

**Layer 2 — Per-tab serialization (new):** When visibility-driven reconnect fires `EnsureConnection` for multiple connections on a tab, the prompts should appear one at a time. Options:

- **Option A (backend queue):** A per-tab prompt queue. `EnsureConnection` calls for the same tab are serialized so that only one connection's `Connect()` proceeds to the password callback at a time. The others wait until the first resolves (connect / cancel / fail).

- **Option B (frontend rendering queue):** Keep all prompts in `activeUserInputPromptsAtom` but render only the first; on dismiss, render the next. Simpler, but allows concurrent SSH handshakes.

**Chosen: Option A (backend).** The user explicitly preferred robustness. Implementation:

Introduce a per-tab connection-prompt coordination keyed by the originating block's tab. Since `EnsureConnection` is called from the frontend without a tab context, and `GetUserInput` resolves the window/tab via `determineScopes`/`findWindowsForConnection`, the serialization is best done at the `GetUserInput` layer: only one `GetUserInput` password prompt is active per window at a time. Subsequent password prompts for other connections wait until the first resolves.

Concretely, add a per-window semaphore/mutex in `userinput.go`:

```go
// One active password prompt per window at a time. Subsequent prompts
// for other connections wait until the first resolves.
var windowPromptMu sync.Mutex
var windowPromptCh = make(map[string]chan struct{}) // keyed by windowId
```

When `GetUserInput` for a password prompt is about to be sent to the frontend, acquire the per-window lock; release it when the response arrives or the context times out. This serializes prompts across connections within the same window (which corresponds to "same tab" in the common case; if multiple windows, they prompt independently, which is correct).

The existing per-tab dismissal (`dismissUserInputPromptForTab`) and global dismiss-on-connect (`dismissUserInputPrompt`) remain unchanged.

### Test cases

| # | Setup | Expected |
|---|---|---|
| 4.1 | Tab with 2 disconnected password-conns → switch tab | First conn's prompt appears; second waits |
| 4.2 | First prompt: correct password → connect | First prompt dismissed; second conn's prompt appears |
| 4.3 | First prompt: Cancel | First dismissed; second appears |
| 4.4 | First prompt: 60s timeout | First dismissed (orphaned password cached if typed); second appears |
| 4.5 | Same conn, two blocks on tab → switch | One prompt (per-connection dedup via `setPendingAuth`) |

---

## Change 5 — Tune background scheduler bounds and error-type termination

### Files
- `pkg/jobcontroller/jobcontroller.go` — `scheduleConnectionReconnect`, constants

### Current

- `ConnReconnectMaxDuration = 5 min` for all connections.
- Scheduler retries on every error type until the cap.

### New

- Extend the cap for connections that can reconnect silently (non-interactive): `ConnReconnectMaxDurationSilent = 15 min`. Keep `ConnReconnectMaxDuration = 5 min` for interactive-attempt connections (defensive — though interactive conns shouldn't run the scheduler at all post-fix #1, this caps any edge case).
- Early termination on `connection-refused` or `auth-failed`: these mean the server is up but rejecting. Stop the scheduler and surface the error, rather than retrying. The user must act (fix auth / check server). `auth-failed` already clears the cache and fires `requestPasswordRePrompt`; the scheduler should exit when it sees `auth-failed`.

```go
if err != nil {
    errorCode, _ := remote.ClassifyConnError(err)
    if errorCode == "auth-failed" {
        log.Printf("[conn:%s] auth-failed during reconnect, stopping scheduler", connName)
        clearRetryState(connName)
        return
    }
    // ... existing network-unreachable / aggressive logic ...
}
```

(`connection-refused` classification needs verification — check `ClassifyConnError` covers it. If not, add it.)

### Test cases

| # | Setup | Expected |
|---|---|---|
| 5.1 | Key-based conn, network down 12 min → scheduler runs up to 15 min | Reconnects when network returns within 15 min |
| 5.2 | Password conn (no cache), scheduler somehow running → auth-failed | Scheduler stops; re-prompt goroutine handles |
| 5.3 | Conn refused (server down) → classified → scheduler continues (server may come back) | Differs from auth-failed; refused is transient |

---

## Change 6 — `HandleSystemResume` uses the fixed heuristic

### Files
- `pkg/jobcontroller/jobcontroller.go` — `HandleSystemResume`

### Current

`HandleSystemResume` calls `needsInteractiveAuth(connName)` and skips if true. With the heuristic fixed (Change 1), key-based connections will no longer be skipped.

No code change beyond what Change 1 delivers — `HandleSystemResume` already calls `needsInteractiveAuth`. Verify in testing that key-based connections now get the fast-path reconnect on wake.

Also ensure `HandleSystemResume` does not clear the cached password — its stall-disconnect path (`jobcontroller.go:590`) calls `conn.Close()` for stalled connections, which Change 2 switches to `conn.CloseInvoluntary()`.

### Test cases

| # | Setup | Expected |
|---|---|---|
| 6.1 | Key-based conn, stalled after sleep → wake | Fast-path reconnect fires; reconnects silently |
| 6.2 | Password conn, cached, stalled after sleep → wake | Fast-path reconnect uses cached password |
| 6.3 | Password conn, no cache → wake | Skipped (needsInteractiveAuth true); visibility-driven reconnect handles on focus |

---

## Implementation order

1. **Change 2** (don't clear cache on stall) — small, isolated, fixes the password-cache race.
2. **Change 1** (heuristic fix + `HasConnected`) — unblocks key-based reconnect in scheduler, `HandleSystemResume`, and UI overlay.
3. **Change 6** (verify `HandleSystemResume`) — falls out of Change 1 + 2; just testing.
4. **Change 3** (visibility-driven reconnect) — the core USP piece; frontend + backend coordination.
5. **Change 4** (serialize password prompts) — UX polish; backend per-window semaphore.
6. **Change 5** (scheduler tuning) — tuning; do after observing 1–4 in practice.

---

## Validation

- `task build:backend` succeeds
- `task build:frontend` succeeds
- `go test ./pkg/remote/conncontroller/...` passes
- `go test ./pkg/jobcontroller/...` passes
- Manual: key-based conn, sleep/wake → auto-reconnects silently (Change 1 + 2)
- Manual: key-based conn, disconnect, switch away and back → reconnects on tab switch (Change 3)
- Manual: two password-conns on one tab, switch to tab → prompts appear one at a time (Change 4)
- Manual: password conn, sleep 10s, wake → cached password retained, reconnects silently (Change 2)
- Manual: `conn:stalldisconnectthreshold` still works; stall → disconnect → reconnect cycle clean

## Risks

- **Change 1 conservatism:** a key-based connection whose key is later rejected will fall back to a password prompt on reconnect. This is rare and correct to surface. If it proves noisy, track `LastAuthMethod` from the handshake and only treat `publickey` as non-interactive (future enhancement).
- **Change 3 timing:** `EnsureConnection`'s 5s cooldown prevents storms, but a user switching tabs rapidly may see a brief "Connecting…" flash on each switch. The debounce (200ms) mitigates this.
- **Change 4 backend serialization:** if the per-window semaphore deadlocks (e.g., a prompt context leaks), subsequent connections would hang. Mitigation: the 60s `GetUserInput` timeout releases the lock; verify the release path in all cases (response, timeout, cancel).