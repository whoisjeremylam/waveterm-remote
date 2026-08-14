# Reconnection P1/P2 — Verification & Remaining-Gap Checklist

> Created: 2026-08-14 · Companion to [[reconnection-ux-backlog.md]]
> P1 (UX-1.1–1.8) and most of P2 are **coded and merged**. This doc is the
> **verification** pass (manual QA) + the few remaining gaps. It is NOT an
> implementation spec — the code already exists.

## Part A — Manual verification by item

Run each scenario against a live build (`task dev`). Record Pass/Fail in the
box. "How to verify" gives the fastest repro; "Where" gives the code to inspect
if it fails.

### P1 — Clarity

| # | Item | How to verify | Expected | Where |
|---|------|---------------|----------|-------|
| 1.1 | Post-give-up copy | Let a connection retry until `reconnectstopreason` is set (max-duration or connection-refused), or force an early-stop | Overlay shows "Auto-retry paused after the time limit" / "SSH refused the connection" with last error, not a bare "Disconnected" | `GaveUpOverlay` in `frontend/app/block/connstatusoverlay.tsx`; `ReconnectGaveUp`/`ReconnectStopReason`/`ReconnectError` on `ConnStatus` |
| 1.2 | Interactive-auth idle | Connect to a password host with **no cached password**, then drop the network so it disconnects | Overlay shows "Sign in required — click Reconnect or focus this tab…"; no fake countdown | `DisconnectedOverlay` (UX-1.2 branch) |
| 1.3 | Stalled heal-first | Force a stall (e.g. `kill -STOP` the remote sshd, or suspend the network mid-session) | "Connection stalled (no activity for Ns)" with **Reconnect Now** (primary) and Disconnect (secondary); Reconnect preserves the cached password | `StalledOverlay`, `handleForceReconnect` |
| 1.4 | Wrong-password feedback | Reconnect with a wrong password (or cached wrong password) | Re-prompt appears with "Incorrect password — please try again.", field cleared | `requestPasswordRePrompt` in `pkg/remote/conncontroller/conncontroller.go` (~1603) |
| 1.5 | Session-gone CTA | Kill the remote `wsh` / job manager (`kill` the jobmanager process) | "Remote session ended" + **Start new durable session** (not just Reconnect host) | `JobSessionOverlay` `"gone"` mode |
| 1.6 | Password queue | Two+ password hosts on the same window, all disconnected; switch back to the tab | Prompts appear one at a time; the waiting one shows "Waiting to sign in…" and the active one shows "(1 of N)" | `AuthQueueWaiting`, `QueuePosition/QueueTotal`, `windowPromptLocks` in `pkg/userinput/userinput.go` |
| 1.7 | Disk drain | Disconnect during heavy output (e.g. `yes` or agent streaming), then reconnect | "Catching up on output… (X / Y)" overlay appears while drain replays | `DrainCatchUpOverlay`; `DrainActive/Total/RemainingBytes` on `StreamManager` |
| 1.8 | Passphrase vs password | Connect to a host whose key is passphrase-protected (agent off) | Prompt title is "Key passphrase" with a lock icon, not "Password" | `createPublicKeyCallback` in `pkg/remote/sshclient.go` (~460); `userinputprompt.tsx` prompt-type icons |

### P2 — Polish (spot-check)

| # | Item | How to verify | Expected |
|---|------|---------------|----------|
| 2.1 | Hysteresis | Brief Wi-Fi flap (<2s) that heals fast | No red "Disconnected" flash; overlay stays hidden or only flashes briefly |
| 2.2 | Flap-stable | Flap the network repeatedly (~5 drops in 30s) | Single "Network unstable — retrying…" state, not cycling overlays |
| 2.3 | Visibility expand | Focus the SCM/preview block on a tab whose shared connection is down | Connection heals without focusing the term block |
| 2.5 | Agent after sleep | Lock macOS keychain / kill ssh-agent, then wake | "SSH agent unavailable…" hint, not an opaque auth loop |
| 2.6 | Accessibility | Tab through the reconnect overlay with a screen reader | `aria-live` announces status changes; Cancel/Reconnect reachable by keyboard |

## Part B — Scenario matrix (UX-3.2, Q1–Q17)

Record Pass/Fail and platform. These are the sign-off gate for "production-ready".

| ID | Scenario | Platform | Pass? |
|----|----------|----------|-------|
| Q1 | Wi-Fi flap <5s, key auth | macOS/Linux | |
| Q2 | Sleep/wake, key auth, app front | macOS | |
| Q3 | Sleep/wake, key auth, background then focus | macOS | |
| Q4 | Sleep/wake, password + cache | macOS | |
| Q5 | Sleep/wake, password, no cache (prompt) | macOS | |
| Q6 | VPN delayed 30–120s after wake | macOS | |
| Q7 | Server reboot / connection-refused then up, user watches tab | any | |
| Q8 | `JobManagerGone`, Start new session | any | |
| Q9 | User Disconnect, no auto reconnect | any | |
| Q10 | Stop auto-retry | any | |
| Q11 | Password Cancel then focus | any | |
| Q12 | Multi-host password tab after wake | any | |
| Q13 | Conn up, kill job path / partial job fail | any | |
| Q14 | Host key changed | any | |
| Q15 | Agent running during disconnect; catch-up after | any | |
| Q16 | App start while offline, then online | any | |
| Q17 | Linux sleep/wake (as available) | Linux | |

## Part C — Remaining gaps (tasks, not yet done)

### G1 — UX-1.6 residual: handshake deadline vs queue wait *(real, narrow)*

**What's already done:** the prompt-level queue wait is decoupled —
`waitForWindowPromptLock` (`pkg/userinput/userinput.go`) ignores parent deadlines
(only aborts on explicit cancel), and a fresh 60s prompt timeout starts after the
lock is held.

**What remains:** the SSH handshake's `net.Conn` deadline in
`ConnectToClient` (`pkg/remote/sshclient.go` ~1052) is set once at dial time to
`max(ctx.Deadline, now+5s)` and keeps ticking through the queue wait. With N
password hosts reconnecting together, a late-queued connection can hit its
handshake deadline while waiting its turn, so its auth write fails when it
finally submits.

**Impact:** a retryable path error (no cache clear, no wrong re-prompt) — thrash,
not data loss. Reproduces only with 2+ password hosts reconnecting concurrently
and a long first prompt.

**Fix options (pick one):**
1. Refresh/extend the `net.Conn` deadline when the prompt lock is acquired (e.g.
   a callback from `userinput` → `sshclient` to re-arm `SetDeadline`).
2. Give prompt-requiring dials a generous handshake budget up front.
3. Explicitly re-queue failed-waiting conns after the queue drains (re-trigger
   Ensure), rather than relying on implicit scheduler/visibility retry.

**Verify by:** 3 password hosts on one window → wake/disconnect → observe host #3
does not fail its first handshake while queued.

### G2 — UX-1.7 optional polish *(optional, perf/UX)*

- [ ] Scrollback gap marker for drained-vs-live output (visual separator).
- [ ] Rate-limit / chunk the xterm write for very large drains so a multi-MB
      catch-up doesn't freeze the renderer (tie-in with the drain overlay).

### G3 — UX-1.5 optional copy *(optional, copy)*

- [ ] Add a note in the "Remote session ended" overlay that tmux sessions on the
      remote may still exist (pointing at future tmux-restore work).

## Part D — Spec hygiene (UX-3.1)

- [ ] Reconcile `reconnection.md` "current behavior" constants (15m silent cap,
      early-terminate rules) with the merged code.
- [ ] Fix the decision tree in `reconnection.md` that still claims a tab-switch gap.
- [ ] Mark Known Gaps G1–G6 fixed/open accurately; archive the superseded
      `HasConnected` heuristic notes.
- [ ] UX-3.3 diagnostics panel (last-N attempts per conn) — decide go/no-go.
