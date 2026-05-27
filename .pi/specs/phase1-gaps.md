# Phase 1 (Gap C) Implementation Gaps

**Branch:** `fix/auto-reconnect-detection-gaps`
**Date:** 2026-05-27
**Related:** Issue #7 (problem), Issue #8 (implementation plan)

## What Phase 1 Implements

Auto-disconnect on persistent stall in `ConnMonitor`: when a connection stalls (keepalive timeout) for longer than a configurable threshold (default 30s), and the user isn't actively typing, the connection is forcibly closed via `conn.Close()`. This converts a zombie "Connected" state into "Disconnected," allowing the existing auto-reconnect machinery to detect the state change.

**Files changed:**
- `pkg/remote/conncontroller/connmonitor.go` — stall tracking + disconnect logic
- `pkg/wconfig/settingsconfig.go` — `ConnStallAutoDisconnect`, `ConnStallDisconnectThreshold`
- `pkg/remote/sshclient.go` — merge function for new config fields

## Gaps Found

### GAP-1: Disconnect→Reconnect loop is incomplete (critical)

**The auto-disconnect fires, but nothing reconnects the connection automatically.**

After `disconnectOnStall()` calls `conn.Close()`:

1. `conn.Status` → `Disconnected` + `FireConnChangeEvent()` fires
2. `handleConnChangeEvent` records `cs.actual = false` → `reconcileConn` → `onConnectionDown()` (just logs, no reconnect)
3. Individual job routes go down → `handleRouteDownEvent` → `attemptAutoReconnect(jobId, connName)`
4. `attemptAutoReconnect` checks `conncontroller.IsConnected(connName)` → returns `false` → **logs "connection is down, skipping auto-reconnect"** and returns
5. Connection stays **Disconnected** indefinitely — user must still manually reconnect

**Root cause:** `onConnectionUp` (which triggers `ReconnectJob` for all durable sessions) only fires when a connection transitions **to** Connected. `attemptAutoReconnect` only tries when the connection is **still up** after a route drops. Neither mechanism calls `conn.Connect()` to bring a Disconnected connection back.

**Impact:** The user experience is essentially unchanged — they still see a disconnected session and must manually click "Connect." The only improvement is that the state accurately shows "Disconnected" instead of a zombie "Connected (stalled)" state.

**Fix needed:** A mechanism that calls `conn.Connect()` when a connection becomes Disconnected and has durable jobs that need it. Options:

| Option | Description | Effort |
|--------|-------------|--------|
| A. `onConnectionDown` reconnect scheduler | When connection goes down with running durable jobs, schedule periodic `Connect()` attempts (e.g., every 30s for 5 min) | ~80 lines in `jobcontroller.go` |
| B. Phase 2: `NotifySystemResumeCommand` | On macOS wake, force `Connect()` for all previously-connected sessions | ~50 lines in `wshserver.go` + helper |
| C. Phase 3: network-online polling | Detect network return and trigger `Connect()` | ~100 lines, cross-platform |
| D. Hybrid A+B | A for general network drops, B for immediate wake response | Recommended |

Option A is the most general — it covers sleep/wake, Wi-Fi drops, VPN changes, and any other network interruption without platform-specific detection. Option B adds an immediate fast-path for the most common user-facing scenario (macOS wake).

---

### GAP-2: Urgent guard prevents disconnect on dead connections (bug)

When a connection is truly dead (TCP RST never received — the exact macOS sleep scenario), user keystrokes still call `NotifyInput()` which updates `LastInputTime`. This makes `isUrgent()` return `true` indefinitely, because the user keeps typing into a dead socket.

The stall-disconnect code:
```go
} else if !urgent {
    // only disconnects if user ISN'T typing
    thresholdMs := cm.getStallDisconnectThresholdMs()
    if now-stallStart > thresholdMs {
        cm.disconnectOnStall()
    }
}
```

**If `urgent` stays true, `disconnectOnStall()` never fires.** The connection remains in zombie "Connected + Stalled" state forever — the exact problem Phase 1 is meant to fix.

**Fix:** When the connection health status is already `Stalled`, the urgent guard should be relaxed. Options:

| Option | Description |
|--------|-------------|
| A. Remove urgent guard entirely for stall-disconnect | User typing on a stalled connection is going nowhere — disconnect regardless |
| B. Cap urgent-protected stall duration | Still honor urgent for the first threshold period, but disconnect after 2× threshold even if urgent |
| C. Check stall health in urgent | `urgent = isUrgent() && cm.Conn.GetConnHealthStatus() != ConnHealthStatus_Stalled` |

Option A is simplest and most correct: if the keepalive monitor says the connection is stalled, the user's keystrokes are not reaching the remote. Disconnecting is the right action regardless of local input activity.

---

### GAP-3: No unit tests

No tests exist for any of the new code:
- `disconnectOnStall()` logic
- `getStallDisconnectThresholdMs()` config reading
- `shouldAutoDisconnectOnStall()` config reading
- `StallStartTime` tracking in `checkConnection()`
- `urgent` guard interaction with stall-disconnect

The existing test pattern in `jobcontroller_test.go` uses hand-written mocks and `t.Parallel()`. New tests should follow the same pattern.

**Suggested test cases:**

| Test | Scenario | Expected |
|------|----------|----------|
| StallDisconnectAfterThreshold | Stall persists >30s, not urgent | `conn.Close()` called |
| NoDisconnectWhenUrgent | Stall persists >30s, user typing | `conn.Close()` NOT called (current behavior) |
| NoDisconnectWhenStallClears | Stall <30s then clears | `StallStartTime` reset, no disconnect |
| DisconnectRespectsConfig | `ConnStallAutoDisconnect=false` | `conn.Close()` NOT called |
| ThresholdFromConfig | `ConnStallDisconnectThreshold=10` (10s) | Disconnect after 10s, not 30s |
| UrgentOnDeadConnection | Stall + user typing on dead socket | Should disconnect (requires GAP-2 fix) |

---

### GAP-4: No user-facing documentation

New config keywords `conn:stallautodisconnect` and `conn:stalldisconnectthreshold` are not documented in `docs/docs/connections.mdx`. Users have no way to discover or configure these settings.

**Fix:** Add a table entry in `docs/docs/connections.mdx` (similar to existing `conn:askbeforewshinstall` entry):

| Keyword | Type | Default | Description |
|---------|------|---------|-------------|
| `conn:stallautodisconnect` | bool | true | Automatically disconnect SSH connections when stalled for the threshold duration |
| `conn:stalldisconnectthreshold` | int (seconds) | 30 | How long (in seconds) a connection must be stalled before auto-disconnecting |

---

### GAP-5: `StallStartTime` not explicitly reset on monitor recreation

When a connection reconnects, `connectInternal()` creates a new `ConnMonitor` via `MakeConnMonitor()`. The new `StallStartTime` defaults to 0 (correct for `atomic.Int64`). However, if the old monitor's `Close()` is called while a stall-disconnect goroutine is still running, there's a subtle timing window:

1. `disconnectOnStall()` launches `go func() { cm.Conn.Close() }()`
2. `Close()` on the connection calls `conn.Monitor.Close()` (cancels the ticker)
3. The goroutine from step 1 still references `cm` (the old monitor)
4. `conn.Close()` runs (from both the goroutine AND the `waitForDisconnect` path)

This is not a functional bug — `Close()` is idempotent (checks status via `lifecycleLock`) — but it means two `Close()` calls happen, one from the stall-disconnect goroutine and one from `waitForDisconnect`. The log message `"disconnecting due to persistent stall"` fires before `Close()`, which is fine for debugging.

**Assessment:** Low risk, no code change needed. The `lifecycleLock` in `Close()` prevents double-status-change. Just noting for awareness.

---

### GAP-6: Config field naming — unit not obvious

`ConnStallDisconnectThreshold` is stored as `*int` in seconds, but the field name doesn't indicate the unit. Compare with `SshPort` (also `*string`, not `*int16` — different concern but same pattern of implicit units).

**Suggestion:** Rename to `ConnStallDisconnectThresholdSec` or add a doc comment. Low priority — the `getStallDisconnectThresholdMs()` conversion makes the unit clear in code.

---

## Priority Order

| Priority | Gap | Action | Impact |
|----------|-----|--------|--------|
| **P0** | GAP-1 | Implement disconnect→reconnect loop | Without this, Phase 1 doesn't actually fix the user-facing problem |
| **P0** | GAP-2 | Fix urgent guard on dead connections | Without this, Phase 1 doesn't fire in the primary scenario (macOS sleep) |
| **P1** | GAP-3 | Add unit tests | No coverage for new logic |
| **P1** | GAP-4 | Add documentation | Users can't discover new config |
| **P2** | GAP-5 | Document timing window | No code change, awareness only |
| **P2** | GAP-6 | Consider field rename | Cosmetic |

## Recommended Implementation Order

1. **GAP-2** (urgent guard fix) — 5 lines, fixes the core bug that prevents Phase 1 from working in the primary scenario
2. **GAP-1** (reconnect loop) — implement Option D (reconnect scheduler in `onConnectionDown` + `NotifySystemResumeCommand` fast-path). This is what makes the whole feature actually work end-to-end.
3. **GAP-3** (tests) — validate the corrected logic
4. **GAP-4** (docs) — make the feature discoverable