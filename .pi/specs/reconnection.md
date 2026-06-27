# SSH Reconnection Strategies — Design Reference

> Last updated: 2026-06-27
> Covers: auto-reconnect scheduler, password buffer, tab triggers, error classification

## Overview

Two classes of SSH connections dictate reconnection behavior:

| Class | Examples | Auto-Scheduler? | Needs User Input? |
|-------|----------|:---:|:---:|
| **Autonomous** | Key-based auth, batch mode, password from secret store, cached password available | ✅ Rapid 5s/3s | Never |
| **Interactive** | Password or keyboard-interactive auth, no cached password | ❌ No (or only for auth-failed edge case) | Yes — password prompt |

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
2. Skips `needsInteractiveAuth()` connections
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

## Decision Tree: Which Strategy?

```
Connection goes down
        │
        ▼
needsInteractiveAuth(connName)?
        │
   ┌────┴────┐
   │ YES     │  (password/kbd-interactive, no cache, no batch, no secret store)
   │         ▼
   │    Is Status == Error AND ErrorCode == "auth-failed"?
   │         │
   │    ┌────┴────┐
   │    │ YES     │  (post-fix: no scheduler)
   │    │         ▼
   │    │    Password prompt stays visible (re-prompt goroutine)
   │    │    User enters new password → cached → Connect() triggered
   │    │
   │    │ NO      │  (init, disconnected, or other error)
   │    │         ▼
   │    │    SKIP scheduler. Connection stays in current state.
   │    │    User must manually click [Reconnect] or block remount triggers ConnEnsureCommand.
   │    │    ▸ GAP: tab switch does NOT trigger reconnect (see Phase 8)
   │    │
   └────┴────┐
   │ NO      │  (key-based, cache exists, batch mode, secret store)
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

¹ Skipped if `needsInteractiveAuth()` && NOT auth-failed  
² Checks `IsConnected()` first, cooldown-based  
³ `needsInteractiveAuth()` → skip fast-path  
⁴ Error state only reconnects if `conn.getCachedPassword() != nil`  
⁵ Uses no-timeout context for interactive-auth connections

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

---

## Key Files

| File | Role |
|------|------|
| `pkg/jobcontroller/jobcontroller.go` | Scheduler, `onConnectionDown`, `needsInteractiveAuth`, system resume |
| `pkg/remote/conncontroller/conncontroller.go` | `Connect()`, `EnsureConnection`, `AttemptReconnect`, password cache |
| `pkg/remote/sshclient.go` | `ConnectToClient`, password callback, `ClassifyConnError` |
| `pkg/userinput/userinput.go` | `GetUserInput`, window scope resolution |
| `pkg/service/userinputservice/userinputservice.go` | `SendUserInputResponse` handler |
| `pkg/wps/wps.go` | Event broker, buffering, scoping |
| `frontend/app/store/modalmodel.ts` | `activeUserInputPromptsAtom`, dismiss, reset |
| `frontend/app/store/global.ts` | `subscribeToConnEvents`, prompt event handler |
| `frontend/app/block/connstatusoverlay.tsx` | Reconnect button, status display |
| `frontend/app/block/blockframe.tsx` | `ConnEnsureCommand` on mount, `UserInputPromptOverlay` |
| `frontend/app/modals/userinputprompt.tsx` | Password prompt component |
