# Reconnection UX Backlog

> Status: Open backlog  
> Created: 2026-07-24  
> Design reference: [[reconnection-design.md]]  
> Implementation reference: [[reconnection.md]]  
> Related: [[visibility-driven-reconnect.md]], [[reconnect-ui-overlay.md]], [[disk-backed-stream-history.md]]

## Goal

Deliver a **production-ready, UX-optimized** reconnection experience for remote-first workflows:

> Working on a remote server should feel like working locally. A dropped SSH connection should heal itself when it can, explain itself when it cannot, and never leave the user with a silent or unexplained dead end.

Backend reconnection (scheduler, `CloseInvoluntary`, visibility-driven `ConnEnsure`, disk-backed history, job reconnect retries) is largely in place. This backlog is the **user-visible product loop**: copy, actions, attention-bound recovery, session honesty, and edge scenarios.

## Guiding principles (from design)

1. **Attention is the rate limiter** — background retry is bounded; user attention is a valid re-trigger.
2. **Involuntary ≠ clear auth** — network drops preserve cached credentials; only user Disconnect and auth-failed clear them.
3. **Silent vs prompt** — never spam prompts unattended; do prompt when the user is present.
4. **Genuinely unavailable is not infinite storm** — no unbounded background retry.
5. **UI must not lie** — conn green + dead session is worse than a clear failure.

## Non-goals (this backlog)

- MOSH / UDP roaming
- IntersectionObserver per-block visibility (still deferred unless a P2 item explicitly reopens it)
- Replacing durable-session semantics (auto-spawn fresh shell on every `JobManagerGone` without user intent)
- Full tmux session restore (separate backlog under Session Persistence)

---

## Current state (baseline)

| Layer | Status |
|-------|--------|
| Autonomous scheduler (key / cache / secret) | Done — 5s/3s intervals, 15m silent / 5m interactive caps |
| Sleep/wake fast-path (macOS) | Done — `HandleSystemResume` + `CloseInvoluntary` |
| Visibility reconnect (tab switch + window focus) | Done — `VisibilityReconnectHandler` |
| Retry overlay (disconnect / countdown / attempt N) | Done — gated on `CanAutoReconnect` |
| Password buffer + per-window prompt serialization | Done |
| Disk-backed stream history + backpressure break | Done |
| Job reconnect convergence + bounded retry | Done (Phase 2E) |
| Cancel auto-retry / stop scheduler from UI | **Done (UX-0.5)** |
| Attention-bound retry while staring at dead tab | **Done (UX-0.3 hybrid)** |
| Job-level overlay (conn up, session down) | **Done (UX-0.2)** |
| Manual-disconnect sticky suppress | **Done (UX-0.1)** |
| Host-key / permanent-failure UX | **Done (UX-0.4)** |
| Catch-up / drain UX | **Missing** |

---

## Priority legend

| Priority | Meaning |
|----------|---------|
| **P0** | Trust & recovery — ship blockers for production remote-dev |
| **P1** | Clarity — user understands state without docs |
| **P2** | Polish — reduce thrash, platform parity, a11y |
| **P3** | Spec hygiene & QA infrastructure |

---

## P0 — Trust & recovery

### UX-0.1 — Sticky suppress after user Disconnect

**Problem:** Explicit Disconnect must not auto-reconnect (scheduler, resume, visibility). Spec is ambiguous; if `onConnectionDown` still schedules after user Disconnect, intent is violated and password cache clears while reconnect races back.

**Invariant:**

> User-initiated Disconnect sets a sticky **do-not-auto-reconnect** flag until the user explicitly clicks Reconnect / Connect / ConnEnsure from a deliberate UI action.

**Scope:**

- [x] Backend: flag on `SSHConn` (`SuppressAutoReconnect`), set by `ConnDisconnectCommand` / `Close()` path only
- [x] Clear flag on: manual Reconnect button, connection typeahead Connect, first successful user-initiated `Connect`
- [x] Do **not** clear on: scheduler, `HandleSystemResume`, visibility `ConnEnsure` (visibility should no-op when flag set — or only run if user clicked Reconnect)
- [x] Decide product rule for visibility after Disconnect: **no auto**, require Reconnect (recommended) — D1

**Acceptance:**

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 0.1.1 | User clicks Disconnect on durable conn | Status disconnected; no scheduler starts; no resume reconnect; no visibility reconnect | Done |
| 0.1.2 | User clicks Reconnect after Disconnect | Connect proceeds; flag cleared; future involuntary drops auto-heal again | Done |
| 0.1.3 | Stall auto-disconnect (involuntary) | Flag **not** set; scheduler / resume still work | Done |
| 0.1.4 | Password cache after Disconnect | Cleared (existing `Close()` behavior) | Done |
| 0.1.5 | Password cache after stall | Preserved (`CloseInvoluntary`) | Done |

**Files (likely):** `conncontroller.go`, `jobcontroller.go`, `visibilityreconnect.tsx`, `wshserver.go` (`ConnDisconnectCommand` / `ConnConnectCommand`)

---

### UX-0.2 — Job-level status when conn is up but session is not

**Problem:** After partial job reconnect failure, conn icon can be green while the durable terminal rejects input (`job is not connected`). UI lies.

**Scope:**

- [x] Surface per-block durable job connection state to the frontend (existing `block:jobstatus` / `termDurableStatus`)
- [x] Overlay states when `conn.status === connected` but job is not healthy:
  - **Reconnecting session** — spinner, auto, no false "ready"
  - **Session reconnect failed** — error + Retry session (grace ~20s then failed)
  - **Session gone** (`JobManagerGone`) — clear copy + **Start new durable session** CTA (not just Reconnect host)
- [x] Do not show normal terminal as fully interactive until job route + stream are active (overlay sits above block)

**Acceptance:**

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 0.2.1 | Conn reconnects, job still reconnecting | Overlay: "Reconnecting session…" — typing blocked or clearly queued | Done (overlay) |
| 0.2.2 | Job retries exhaust, conn still up | Overlay: failure + Retry; green conn alone is insufficient | Done (20s grace → failed + Retry) |
| 0.2.3 | `JobManagerGone` after remote reboot | "Remote session ended" + Start new session; not a silent dead PTY | Done (no auto-start — D6) |
| 0.2.4 | Job + stream healthy | Overlay gone; input works | Done |

**Related:** Phase 2E convergence invariant in [[reconnection.md]]; Layer 3 "Connected-but-no-stream" in `decisions.md`.

---

### UX-0.3 — Attention-bound recovery while the dead tab is visible

**Problem:** After scheduler give-up (15m silent) or early stop (`connection-refused`), recovery requires tab switch, window focus, or manual Reconnect. If the user **stares at** the disconnected tab while VPN/SSH returns, nothing happens — breaks server-reboot and delayed-VPN cases.

**Design options (pick one primary; can combine):**

| Option | Description |
|--------|-------------|
| **A. Visible-tab slow heartbeat** | While active tab has a disconnected/error conn (and suppress flag clear), retry every 30–60s |
| **B. Network-online trigger** | On OS/network online (or Electron equivalent), fire `ConnEnsure` for disconnected conns on active tab / all durable conns |
| **C. Hybrid** | Heartbeat only when overlay visible + network-online immediate kick |

**Recommended:** **C** — attention-bounded (visible) + event-driven online. **Implemented as hybrid (D4/D5).**

**Scope:**

- [x] Frontend: slow retry loop tied to **active tab visibility** (30s default; 10s after dial-error network failures)
- [x] Network online hook (`window` `online` event; degrade gracefully)
- [x] Respect UX-0.1 suppress flag and `auth-failed` / host-key permanent stops
- [x] For interactive-auth without cache: heartbeat may call `EnsureConnection` → prompt only if still visible (user present) — D5

**Acceptance:**

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 0.3.1 | Scheduler gave up; user stays on tab; network returns | Reconnect within one heartbeat interval (or on online event) without click | Done |
| 0.3.2 | `connection-refused` early-stop; SSH returns 2 min later; user watching | Same as 0.3.1 | Done |
| 0.3.3 | User on different tab | No aggressive retry storm for hidden tabs (background scheduler rules unchanged) | Done (doc hidden pauses heartbeat) |
| 0.3.4 | User Disconnect suppress set | Heartbeat / online does **not** reconnect | Done |
| 0.3.5 | Auth-failed | No silent storm; prompt path only | Done (backend + suppress) |

---

### UX-0.4 — Permanent failures stop silent retry with clear copy

**Problem:** Host key change, permanent auth policy failures, and similar errors are not first-class. Risk of opaque retry or wrong classification.

**Scope:**

- [x] Classify host-key / known_hosts failures (and similar non-retryable handshake errors) via `remote.IsPermanentConnError`
- [x] Scheduler + attention-bound retry: **stop** on these codes; sets `SuppressAutoReconnect`
- [x] Overlay: dedicated message (not generic dial-error) with guidance copy
- [x] Never auto-accept host key changes (unchanged — still requires user confirm path)

**Acceptance:**

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 0.4.1 | Host key changed | Auto-retry stops; overlay explains; no silent connect | Done |
| 0.4.2 | Wrong password (auth-failed) | Re-prompt; no background scheduler storm | Done (existing + keep) |
| 0.4.3 | Transient dial timeout | Retry continues (existing behavior) | Done |

---

### UX-0.5 — Cancel auto-retry + password Cancel semantics

**Problem:**

1. Retrying overlay has no Cancel / Stop auto-retry (spec'd in [[reconnect-ui-overlay.md]], not implemented).
2. Password Cancel can race with visibility: user cancels, then focus/tab event re-prompts immediately — "I can't cancel."

**Scope:**

- [x] **Stop auto-retry** control on countdown / retrying / disconnected-with-scheduler overlays → `ConnStopAutoRetryCommand` → `PauseAutoReconnect` + `StopReconnectScheduler`
- [x] Distinguish from Disconnect: Stop retry keeps cache; Disconnect clears (D2)
- [x] Password Cancel: sets `SuppressAutoReconnect` sticky until manual Reconnect (D3 — not timed cool-down)
- [x] Document chosen Cancel vs visibility rule: Cancel → suppress; visibility/heartbeat no-op until Reconnect (`ConnConnectCommand`)

**Acceptance:**

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| 0.5.1 | Click Stop auto-retry during countdown | No further scheduler attempts; overlay shows static disconnected + Reconnect | Done |
| 0.5.2 | Click Cancel on password prompt | Prompt closes; no immediate re-prompt on same focus cycle | Done (suppress on user-cancelled) |
| 0.5.3 | After Cancel, user clicks Reconnect | Prompt allowed again | Done (Connect clears suppress) |
| 0.5.4 | Stop auto-retry does not clear password cache | Subsequent Reconnect can still use cache if still present | Done |

---

## P1 — Clarity

### UX-1.1 — Post-give-up and early-stop overlay copy

**Problem:** After max duration or `connection-refused` stop, retry fields clear → generic "Disconnected" with no explanation.

**Scope:**

- [ ] Persist last give-up reason on `ConnStatus` (or keep last `ReconnectError` + `ReconnectGaveUp: true` + attempt count)
- [ ] Copy examples:
  - "Auto-retry paused after 15 minutes. Last error: … Will try again when the network returns or you click Reconnect."
  - "SSH refused the connection. Auto-retry paused. Will try again when you return or the service is back."

**Acceptance:** User can distinguish "still retrying" vs "paused" vs "needs password" without reading logs.

---

### UX-1.2 — Interactive-auth idle overlay

**Problem:** Password connections without cache show static Disconnected; looks like the app gave up forever.

**Scope:**

- [ ] When `!CanAutoReconnect` and status disconnected/error (and not suppress):  
  "Sign-in required — click Reconnect or focus this tab to enter credentials."
- [ ] Do not show fake countdown

**Acceptance:** Interactive vs autonomous states are visually distinct.

---

### UX-1.3 — Stalled overlay: heal-first actions

**Problem:** Stalled overlay primary action is Disconnect (clears cache). User may not know auto-heal is imminent.

**Scope:**

- [ ] Copy: "Connection stalled (no activity for Ns). Recovering…"
- [ ] Primary: **Reconnect now** (force involuntary close + reconnect) or wait for auto
- [ ] Secondary: Disconnect (explicit, clears auth)

**Acceptance:** Primary path preserves cache and recovers; Disconnect remains available but secondary.

---

### UX-1.4 — Wrong-password prompt feedback

**Scope:**

- [ ] On `auth-failed`, prompt re-shows with field cleared and explicit "Incorrect password" (or server message if safe)
- [ ] Do not show only a generic conn error behind a blank prompt

**Acceptance:** User knows the credential was rejected, not that the network died.

---

### UX-1.5 — Session gone CTA (ties to UX-0.2)

**Scope:**

- [ ] Distinct copy for remote reboot / job manager gone vs temporary disconnect
- [ ] CTA: **Start new durable session** (same connection, new job) vs Reconnect host only
- [ ] Optional note: tmux sessions on remote may still exist (point to future tmux restore work)

**Acceptance:** Weekly server-reboot story has a clear one-click path to a working shell.

---

### UX-1.6 — Multi-connection password queue UX

**Problem:** Backend serializes prompts; second handshake may timeout while waiting; no "1 of N" UI.

**Scope:**

- [ ] When multiple conns need auth on one window: show queue indicator ("Signing in to host A (1 of 3)…")
- [ ] Waiting conns: "Waiting to sign in…" not a premature dial failure if caused by queue wait
- [ ] Raise or decouple handshake timeout from queue wait (backend), or re-queue failed-waiting conns

**Acceptance:** Multi-host tab after wake never looks randomly broken after the first password succeeds.

---

### UX-1.7 — Disk drain / catch-up indicator

**Problem:** Disk-backed history replays with no UX; long agent output can flood the terminal.

**Scope:**

- [ ] Brief overlay or status: "Catching up on output from while disconnected…"
- [ ] Optional scrollback gap marker (if not already user-visible)
- [ ] Consider rate-limit / chunked write to xterm for very large drains (perf)

**Acceptance:** User understands burst after reconnect; no multi-second silent freeze.

---

### UX-1.8 — Passphrase vs password prompt strings

**Scope:**

- [ ] Key passphrase prompts say "Key passphrase" (not "Password") when `PassphrasePrompted` path is used
- [ ] Keyboard-interactive uses server-provided prompts when available

**Acceptance:** Auth method matches UI language.

---

## P2 — Polish

### UX-2.1 — Overlay hysteresis for brief blips

- [ ] Delay full disconnect chrome ~1–2s when `CanAutoReconnect` (backend may still disconnect immediately)
- [ ] Or: subtle badge first, full overlay after threshold

**Acceptance:** Sub-second Wi‑Fi flap does not flash red overlay if healed in time.

#### Design consideration (discuss when implementing) — context-aware / urgency-weighted hysteresis

> Not decided. Capture for design discussion when this item is picked up. Flat time delay is the minimum; context may improve perceived reliability on flaky links (e.g. train Wi‑Fi) without hiding failures when the user expects responsiveness.

**Motivation:** Whether a short disconnect is noticeable depends on what the user was doing at the time—not only how long the link was down.

| Context at disconnect | User expectation | Overlay aggressiveness |
|----------------------|------------------|------------------------|
| Idle / reading unchanged scrollback | Low — nothing was happening | Soft: longer hide delay; maybe no full chrome if healed fast |
| Waiting on output (command running, agent streaming) | Medium–high | Faster status if stream stalls |
| Actively typing / expecting echo | High — system should respond | Minimal hysteresis; show reconnect state quickly |
| Explicit interaction failed (paste, RPC, widget load) | High | Surface immediately |

**Idea:** Gate chrome with urgency, not only duration:

```
show_overlay = f(duration_down, user_urgency, output_expectation)
```

rather than only `duration_down > 1500ms`.

**Possible urgency signals** (several already exist or are adjacent in reconnect/stall code):

| Signal | Effect on urgency |
|--------|-------------------|
| Keystroke / paste in last ~2–5s | High |
| Focused block + recent input with no echo | High |
| Active stream (recent bytes, agent running) | Medium–high |
| Idle focused, no input, no recent output change | Low |
| Background tab | Lower |

**Sketch policy (for discussion, not committed):**

```
on disconnect:
  urgency = computeUrgency()
  hideBudget = high → 0–300ms | medium → ~1s | low → ~2–3s
  if reconnected within hideBudget && urgency still low → never show full overlay
  else → show reconnect chrome

on keystroke (or other engagement) while disconnected:
  urgency = high
  show overlay immediately  // cancel soft hide
```

**Constraints to preserve:**

- Backend reconnect stays max-speed — context only gates **chrome**, not whether we reconnect.
- Soft hide must **cancel** if the user becomes engaged while still down (typing into silence is worse than a brief banner).
- “Reading” is best-effort (no input + no output), not true gaze detection.
- Agents / hot streams before drop may warrant medium urgency so catch-up is not a surprise (ties to UX-1.7).

**Discuss / decide when implementing:**

- [ ] Flat time hysteresis only vs urgency-weighted budgets
- [ ] Which signals are reliable enough for v1
- [ ] Interaction with UX-2.2 (flap-stable chrome) — one combined “perceived stability” layer?
- [ ] Acceptance cases: idle train blip (no flash) vs typing during flap (immediate feedback)

---

### UX-2.2 — Flap-stable overlay chrome

- [ ] If ≥N attempts within 30s, hold single "Network unstable — retrying…" state instead of cycling three overlays

**Acceptance:** Flapping network does not strobe UI.

---

### UX-2.3 — Visibility triggers expansion

- [ ] Add `document.visibilitychange` → visible as reconnect trigger (in addition to `window` focus)
- [ ] On visibility scan, include connections from **all** block views on the tab (term + preview + SCM + process), not only `view === "term"`

**Acceptance:** SCM-only focus on a tab can heal the shared connection; sleep resume with app front is reliable across platforms.

---

### UX-2.4 — Linux / Windows resume parity

- [ ] Validate `powerMonitor` resume (or equivalent) on Linux and Windows
- [ ] Document platform gaps; add fallbacks (visibility + stall) where resume is missing
- [ ] Manual QA matrix per OS

**Acceptance:** Sleep/wake story documented and acceptable on each supported OS.

---

### UX-2.5 — Agent / ssh-agent after sleep

- [ ] Detect agent failure after prior `authPromptNone` (agent was used)
- [ ] Surface "SSH agent unavailable — unlock keychain or restart agent" rather than opaque auth-failed loop

**Acceptance:** macOS keychain lock after sleep is understandable.

---

### UX-2.6 — Accessibility

- [ ] `aria-live` polite region for conn status changes
- [ ] Focus management: password prompt receives focus; Cancel/Reconnect reachable by keyboard
- [ ] Do not trap focus incorrectly across multi-prompt queue

---

### UX-2.7 — Battery / multi-host background backoff

- [ ] When many hosts retry in background, stagger attempts
- [ ] Optional longer interval on battery (if detectable)

**Acceptance:** 10 durable hosts offline do not hammer the network every 3s forever within the silent cap.

---

### UX-2.8 — Port-forward status after reconnect

- [ ] Confirm forwards re-establish on reconnect (existing port-forward work)
- [ ] Surface forward bind failures on reconnect in badge/tooltip

**Acceptance:** Remote-dev ports either work after heal or show a clear error.

---

## P3 — Spec hygiene & QA

### UX-3.1 — Reconcile reconnection.md "current behavior"

- [ ] Update constants table (15m silent, early terminate rules)
- [ ] Fix decision tree still claiming tab-switch GAP
- [ ] Mark Known Gaps G1–G6 fixed/open accurately
- [ ] Archive superseded heuristic (`HasConnected`) notes into a changelog section

---

### UX-3.2 — Scenario QA matrix (manual)

Run and record before calling reconnection "production-ready":

| ID | Scenario | Platform | Pass? |
|----|----------|----------|-------|
| Q1 | Wi‑Fi flap &lt;5s, key auth | macOS/Linux | |
| Q2 | Sleep/wake, key auth, app front | macOS | |
| Q3 | Sleep/wake, key auth, app background then focus | macOS | |
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

---

### UX-3.3 — Optional diagnostics panel

- [ ] Dev/support-only: last N reconnect attempts per conn (time, error, trigger: scheduler / resume / visibility / manual)
- [ ] No cloud telemetry required (local log or in-app debug)

---

## Suggested implementation order

```
UX-0.1 sticky suppress  ─┐
UX-0.5 cancel semantics ─┼─ foundation (intent & control)
                         │
UX-0.2 job-level overlay ── honesty (stop lying)
                         │
UX-0.3 attention recovery ── heal while watching (reboot/VPN)
UX-0.4 permanent failures ─ safety
                         │
UX-1.x copy & stalled/prompt polish
UX-1.7 drain indicator
                         │
UX-2.x hysteresis, visibility expand, platform QA
UX-3.x docs + matrix sign-off
```

Ship gate recommendation: **all P0 + UX-1.1, 1.2, 1.5 + QA matrix Q1–Q12** before calling reconnection production-ready for the remote-first USP.

---

## Scenario coverage map

| Scenario | Primary backlog items |
|----------|----------------------|
| Brief blip | UX-2.1, UX-2.2 |
| Sleep/wake | UX-0.3, UX-2.3, UX-2.4, UX-2.5 |
| Flapping network | UX-2.2, UX-2.7 |
| Stall zombie | UX-1.3 |
| Long offline / give-up | UX-0.3, UX-1.1 |
| Server reboot / refused | UX-0.3, UX-0.2, UX-1.5 |
| Visibility return | UX-2.3 (expand), existing Phase 2I |
| Password / passphrase | UX-0.5, UX-1.2, UX-1.4, UX-1.6, UX-1.8 |
| Conn up / job down | UX-0.2 |
| Disk history drain | UX-1.7 |
| User Disconnect | UX-0.1 |
| Host key change | UX-0.4 |
| Multi-window auth | UX-1.6 (partial), future if needed |
| Port forwards | UX-2.8 |

---

## Open product decisions (resolve during P0)

| # | Question | Recommendation |
|---|----------|----------------|
| D1 | After user Disconnect, may visibility reconnect? | **No** — require explicit Reconnect |
| D2 | Stop auto-retry vs Disconnect — cache? | Stop keeps cache; Disconnect clears |
| D3 | Password Cancel sticky duration | Until manual Reconnect (not timed), or 60s cool-down |
| D4 | Attention heartbeat interval | 30s default; 10s when last error was network-unreachable |
| D5 | Heartbeat for interactive without cache | Yes if tab visible (user present → prompt OK) |
| D6 | `JobManagerGone` auto-start new shell? | **No** by default; one-click CTA only (preserve durable semantics) |

Record final choices in [[decisions.md]] when implemented.

---

## References

- [[reconnection-design.md]] — what/why
- [[reconnection.md]] — implementation phases 2A–2M
- [[visibility-driven-reconnect.md]] — Changes 1–6 (implemented 2026-07-23)
- [[reconnect-ui-overlay.md]] — overlay states (Cancel still open)
- [[disk-backed-stream-history.md]] — remote freeze + history
- `.pi/todos.md` — fork task list (link this backlog under reconnection / UX)
