# Architecture Decisions

## 2026-05-10: Fork Purpose

**Decision:** Fork Wave Terminal to create a remote-development-optimized variant.

**Context:** Most terminals assume local-first workflows. This fork treats remote SSH environments as primary workspaces.

**Consequences:**
- Upstream remains the base; we merge regularly
- Features evaluated against "remote-first" usefulness
- Local-first features may be removed/diminished if they conflict with remote workflow

## 2026-05-10: `.pi/` as Planning Hub

**Decision:** Use `.pi/` directory for all fork planning, specs, and agent context.

**Context:** Keeps planning centralized and agent-accessible without cluttering the root or public docs.

**Files:**
- `.pi/index.md` — entry point
- `.pi/context.md` — project background
- `.pi/todos.md` — active tasks
- `.pi/decisions.md` — this file
- `.pi/specs/` — feature specifications

## 2026-05-10: Port Forwarding — Config-First Approach

**Decision:** Implement `LocalForward`/`RemoteForward` from `~/.ssh/config` and `connections.json`, not CLI flags.

**Context:** SSH config is the standard place developers already define forwarding rules. Making Wave respect them is the least-surprise approach.

**Approach:**
1. Parse `LocalForward`/`RemoteForward` in `findSshConfigKeywords()`
2. Add to `ConnKeywords` struct
3. Return merged keywords from `ConnectToClient()`
4. Start forwarding goroutines in `SSHConn.connectInternal()`
5. Clean up listeners in `closeInternal_withlifecyclelock()`

**Deferred:**
- `DynamicForward` (needs SOCKS5 handler)
- CLI flags on `wsh ssh` (can add later)
- UI status indicator

## 2026-05-14: Tab-Close Crash — Root Cause Found & Fixed

**Decision:** Remove redundant `DestroyBlockController` goroutine from `CloseTab`; add `sync.Once` to `ShellProc.Close()` as defense-in-depth.

**Context:** Investigation confirmed a race where `CloseTab` explicitly launched `DestroyBlockController` in a goroutine while `DeleteTab` → `DeleteBlock` → `BlockCloseEvent` triggered the same destruction again. This caused concurrent double-`Stop` on `ShellController` (with its Lock/Unlock/Relock window) and `DurableShellController` (which has no lock), leading to double `Session.Close()` / double `TerminateAndDetachJob`.

**Fix applied:**
1. `pkg/service/workspaceservice/workspaceservice.go` — removed the explicit `go DestroyBlockController()` loop; `DeleteTab` already triggers cleanup via events.
2. `pkg/shellexec/shellexec.go` — added `closeOnce sync.Once` to `ShellProc` and wrapped `Close()` in `sp.closeOnce.Do`, preventing double `KillGraceful` / double goroutine spawn even if two Stops race.
3. Added trace logging to `CloseTab`, `DestroyBlockController`, `ShellController.Stop`, `DurableShellController.Stop`, `handleBlockCloseEvent` for interactive diagnosis.
4. Fixed 2 test-code panics (manual `close` of channel already closed by mock `KillGraceful`).

**Consequences:**
- `CloseTab` now has a single cleanup path: `DeleteTab` → `DeleteBlock` → event → `DestroyBlockController`
- `ShellProc.Close()` is idempotent; any future code path that calls it twice is safe
- 14 unit tests pass under `-race`

## 2026-05-12: Secret Store — Keep

**Decision:** Keep the secret store infrastructure; it's not AI-specific.

**Context:** The secret store (`pkg/secretstore/`) is an encrypted key-value store backed by the OS keychain. It has three consumers:
1. **AI API tokens** (`ai:apitokensecretname`) — going away with AI removal
2. **SSH password auth** (`ssh:passwordsecretname`) — stays, useful for password-authenticated hosts
3. **Wave App Store** — stays, general-purpose

**Consequences:**
- Remove `ai:apitokensecretname` field from `ConnKeywords` as part of AI cleanup
- Keep `pkg/secretstore/`, `wsh secret` CLI, and `ssh:passwordsecretname` intact
- Lightweight general infrastructure; useful for future features (e.g., file transfer credentials)

## 2026-05-15: Claude Code Shell Integration — Analysis for Future Pi Agent Support

**Finding:** Wave Terminal's Claude Code detection is built on top of a generic **shell integration protocol** (OSC 16162) that could be reused for pi coding agent support.

### How Claude Code Integration Works

| Layer | What it does | Relevant file |
|-------|-------------|---------------|
| **Shell integration protocol** | Custom OSC 16162 sequences injected into shell prompt. Sends command-start (`C`), command-done (`D`), shell-ready (`M`) events via base64-encoded payloads. | `frontend/app/view/term/osc-handlers.ts` |
| **Command detection** | `isClaudeCodeCommand(decodedCmd)` checks if normalized command matches `/^claude\b/`. Also detects `opencode` with similar regex. | `frontend/app/view/term/osc-handlers.ts` |
| **State atoms** | `shellIntegrationStatusAtom` (`"ready" \| "running-command" \| null`) and `claudeCodeActiveAtom` (`boolean`) track terminal state per block. | `frontend/app/view/term/termwrap.ts` |
| **Visual indicator** | `getShellIntegrationIconButton()` in `term-model.ts` reads atoms and renders either generic sparkle icon or `TermClaudeIcon` (Anthropic SVG logo) with status tooltip. | `frontend/app/view/term/term-model.ts` |
| **Telemetry gate** | `checkCommandForTelemetry()` filters out `ssh`, editors (`vim/nano/nvim`), `tail -f`, `claude`, and `opencode` from AI telemetry. | `frontend/app/view/term/osc-handlers.ts` |

### What Was Removed Today

- Sparkle icon + Claude logo from terminal block header (`getShellIntegrationIconButton` now returns `null`)
- All tooltips referencing "Wave AI can run commands"
- The `TermClaudeIcon` import from `term-model.ts`

### What Remains (Dead Code, Phase D Cleanup)

- `claudeCodeActiveAtom` in `termwrap.ts` — still set by OSC handlers, never read
- `shellIntegrationStatusAtom` in `termwrap.ts` — still set by OSC handlers, never read
- `isClaudeCodeCommand()` and `ClaudeCodeRegex` in `osc-handlers.ts` — still execute, results unused
- `TermClaudeIcon` component in `term.tsx` — still exported, never imported
- `checkCommandForTelemetry()` in `osc-handlers.ts` — still runs, telemetry already removed

### Reuse Potential for Pi Coding Agent

**The shell integration protocol itself is valuable** — it gives the terminal real-time awareness of:
- When a command starts / finishes
- What the command line is
- Exit codes
- Shell type and version
- Whether the terminal is in an alternate buffer (e.g., `vim`, `less`)

**For pi integration, we could:**
1. Reuse the same OSC 16162 injection into `.bashrc`/`.zshrc`
2. Add a `piActiveAtom` alongside `claudeCodeActiveAtom` with a `/^pi\b/` regex
3. Show a pi icon in the terminal header when pi is the active command
4. Use command-start/finish events to show "pi is running" status in the UI
5. Use the alternate-buffer detection (`getBlockingCommand`) to suppress pi actions while inside `vim`/`less`/`ssh`

**Key insight:** The protocol is generic AI-agent-agnostic infrastructure. The Claude-specific parts are just a regex (`/^claude\b/`) and an SVG icon. Replacing them with pi equivalents would be trivial if we want this later.

**Decision:** Keep the underlying OSC 16162 shell integration infrastructure intact for now. Only the visual indicator (sparkle/Claude icon) and Wave-AI-specific tooltips were removed. If we want pi agent integration later, we can add `piActiveAtom` and a pi icon with minimal changes.

## 2026-05-20: MOSH Research — Not a Priority

**Finding:** MOSH (Mobile Shell) provides seamless reconnection (roaming, sleep/wake) and client-side local echo via UDP-based State Synchronization Protocol. However, it's not a priority for this fork.

**Why not:**
- **No port forwarding** — open issue since 2014, no movement. Port forwarding is a core requirement.
- **No OSC52 clipboard** — remote programs can't put text in local clipboard.
- **No scrollback** — only syncs visible terminal state.
- **No file transfer** (scp/sftp).
- **C++ only** — no Go or JS library implementations of the core protocol.
- **Slow development** — last release 1.4.0 (October 2022).

**Alternative: tsshd (trzsz-ssh)** — Go-based, supports full SSH features (port forwarding, agent forwarding, X11, scrollback, OSC52) + UDP roaming via QUIC/KCP. More architecturally relevant but would require significant integration effort.

**Local echo with wsh** — Technically possible (Wave Terminal already knows screen state and intercepts keystrokes), but non-trivial (must detect line-editing vs application mode, validate predictions against round-trip timing). Low value for typical homelab latency (<50ms).

## 2026-05-23: Auto-Reconnect P0 Fixed; Server Reboot → Manual Reconnect

**Decision:** After fixing the three P0 auto-reconnect bugs (cooldown race, reconcile race, singleflight deduplication), we explicitly chose **NOT** to implement auto-restart of fresh shells on server reboot or `wsh` death.

**Why manual reconnect:**
- Auto-restart would change durable-session semantics from *"resume my existing remote shell"* to *"keep a shell open at all costs."*
- Context loss (cwd, env, running processes) is confusing for users who think their old session survived.
- Risk of `wsh` re-install loops after server reboot.
- Cleaner to let the user explicitly click Connect and know it's a fresh session.

**What we did:**
- `ReconnectJob` now correctly detects `JobManagerGone` and marks the job done.
- User sees `[session gone]` in the terminal and clicks Connect to start fresh.

**Future direction (Jeremy's idea):** Tmux auto-restore on reconnect — instead of restarting raw shells, recreate tmux sessions/layouts after server reboot. This preserves tmux's own session persistence while giving WaveTerm visibility into the sessions.

---

## 2026-06-01: CPU Spin Bug — Root Cause & Fix Strategy

**Decision:** Fix the `x/crypto/ssh` drain loop bug locally via `go.mod` replace directive, not by reordering cleanup in waveterm.

**Root cause:** `golang.org/x/crypto@v0.52.0` `ssh/mux.go` and `ssh/channel.go` have drain loops that spin forever when `globalResponses`/`ch.msg` channels are closed. Receiving from a closed channel always succeeds immediately (returns zero value), so `default` case is never reached. Tracked as [golang/go#79658](https://github.com/golang/go/issues/79658).

**Upstream fixes:** Commits 4c4d20b (mux.go) and e3e62d9 (channel.go) on May 27, 2026. Not yet in a tagged release (awaiting v0.53.0).

**Why the reorder workaround (issue #22 commit eb2c659a) was rolled back:**
- Only addressed the cleanup goroutine path, not keepalive monitors or `mux.loop()` exiting independently
- Wake-from-sleep pprof showed 37 spinning goroutines + 37 blocked on Mutex.Lock — reorder can't prevent all
- Original close order (client first) is correct: force-closes transport, unblocking pending `writePacket` calls
- With the mux patch, drain loops exit immediately on closed channels regardless of call order

**Implementation:**
- `local_crypto_patch/contents/` — local copy of `x/crypto v0.52.0` with the 2-line drain loop fix applied
- `go.mod` replace directive: `replace golang.org/x/crypto v0.52.0 => ./local_crypto_patch/contents`
- Rollback plan: when `x/crypto >= v0.53.0` released, remove replace, delete `local_crypto_patch/`, `go mod tidy`

**Consequences:**
- 100% CPU (wifi switch) and 900% CPU (wake from sleep) bugs both resolved
- No additional goroutines or timeouts needed in cleanup path
- Original close order restored (client first, then listener)

---

**Priority order:**
1. Fix auto-reconnect bugs in durable sessions (#4) — DONE 2026-05-23
2. SSH port forwarding (spec ready)
3. Remote file paste (image paste + drag-drop for SSH sessions) — primary use case: pi / Claude Code TUI
4. MOSH/tsshd support (backlog, if roaming becomes a real pain point)


---

## 2026-07-08: tmux CWD tracking via `wsh setmeta` (not passthrough, not RPC pull)

**Context:** Inside tmux, shell integration suppresses OSC 7 (cwd tracking) because tmux absorbs escape sequences. `cmd:cwd` goes stale, breaking SCM/file widgets.

**Options considered:**
1. **tmux passthrough** (OSC 7 wrapped in `\ePtmux;...\e\\`) — rejected: requires `allow-passthrough on` in user's tmux config (off by default before tmux 3.3), fragile ESC-doubling, also need to un-gate OSC 16142 markers, version-dependent
2. **Pull RPC** (`TmuxPaneInfoCommand` — frontend queries tmux via wsh) — rejected: needs new wsh RPC (version bump), must probe `$TMUX` in shell env (not wsh env), multi-session disambiguation, only fixes widgets not terminal header
3. **Push via `wsh setmeta`** (shell integration calls `wsh setmeta -b this "cmd:cwd=$PWD"` under tmux) — **CHOSEN**

**Why `wsh setmeta` wins:**
- Uses the existing Unix domain socket RPC — bypasses tmux's pty entirely
- `WAVETERM_BLOCKID` survives into tmux panes (verified live)
- `wsh` is already on PATH in shell integration scripts
- Zero frontend changes, zero new RPC, zero version bump
- Same cadence as OSC 7 (prompt/cd), same consumers (`getFocusedTerminalCwd`, SCM `terminalCwd`, Preview `metaFilePath`)
- Works under screen too (`_waveterm_si_blocked` detects both)

**Decision:** Modify `_waveterm_si_osc7` in all 4 shell scripts (bash, zsh, fish, pwsh) to call `wsh setmeta` when blocked. For bash/pwsh (no chpwd hook), also modify precmd/prompt to call `_waveterm_si_osc7` even when blocked. See [[specs/tmux-cwd-tracking.md]].

## 2026-07-08: Widget keep-alive (hide, not destroy) over serialize-on-toggle

**Context:** Toggling SCM/Preview widgets fully destroys and recreates the block. State is lost (view mode, selected file, diff cache, commit message, in-flight operations).

**Options considered:**
1. **Serialize view-state on dispose, restore on recreate** — rejected: loading flash on every open, in-flight operations (staging/committing) behave incorrectly, diff cache lost
2. **Keep-alive with poll backoff** — **CHOSEN**

**Why keep-alive wins:**
- In-flight operations (staging, committing, pushing) survive — correctness, not just UX
- Diff cache preserved — instant file re-selection
- 30s poll backoff while hidden limits resource cost
- Refresh on show catches up on changes while hidden

**Decision:** Replace `toggleWidgetVisibility`'s `closeNode` (which calls `DeleteBlock`) with `hideNode` (removes from layout, preserves block + ViewModel). Add `onHide()`/`onShow()` to ViewModel interface. See [[specs/widget-keepalive.md]].

## 2026-07-08: tmux CWD tracking — implemented

**Implemented** the `wsh setmeta` approach per [[specs/tmux-cwd-tracking.md]].

**Files modified:**
- `pkg/util/shellutil/shellintegration/bash_bashrc.sh` — `_waveterm_si_osc7` (wsh setmeta when blocked) + `_waveterm_si_precmd` (call osc7 when blocked, skip OSC 16142)
- `pkg/util/shellutil/shellintegration/zsh_zshrc.sh` — `_waveterm_si_osc7` (wsh setmeta when blocked; chpwd hook already calls it directly)
- `pkg/util/shellutil/shellintegration/fish_wavefish.sh` — `_waveterm_si_osc7` (wsh setmeta when blocked; on-variable PWD hook already calls it directly)
- `pkg/util/shellutil/shellintegration/pwsh_wavepwsh.sh` — `_waveterm_si_osc7` (wsh setmeta when blocked) + `_waveterm_si_prompt` (call osc7 when blocked, skip OSC 16142)

**Verification:**
- bash syntax check passes (`bash -n`)
- Go build passes (`go build ./...`) — shell scripts embedded via `//go:embed`
- shellutil tests pass
- zsh/fish/pwsh not installed locally for syntax check, but edits follow existing patterns

**Pending manual testing** (requires running waveterm with the CI-built binary):
- tmux + `cd` → `cmd:cwd` updates via `wsh getmeta -b this`
- screen + `cd` → `cmd:cwd` updates
- non-tmux regression (OSC 7 path unchanged)
- SCM widget shows correct repo under tmux

## 2026-07-08: Widget keep-alive — implemented

**Implemented** the widget keep-alive design per [[specs/widget-keepalive.md]].

**Files modified:**
- `frontend/types/custom.d.ts` — Added `blockId?`, `onHide?()`, `onShow?()` to `ViewModel` interface
- `frontend/app/store/global.ts` — Added `hiddenBlockModels` map + `hiddenBlockIds` set + helper functions (`hideBlockModel`, `getHiddenBlockModel`, `removeHiddenBlockModel`, `isHiddenBlock`, `getHiddenBlockKey`)
- `frontend/layout/lib/layoutModel.ts` — Added `hideNode()` (removes from layout without `DeleteBlock`), `insertExistingNode()` (re-inserts existing block), modified `cleanupOrphanedBlocks` to skip hidden blocks
- `frontend/app/workspace/widgets.tsx` — `toggleWidgetVisibility` now hides (not closes), `handleWidgetSelect` reuses hidden blocks before creating new ones
- `frontend/app/block/block.tsx` — `BlockInner`/`SubBlockInner` cleanup skips `dispose` when `isHiddenBlock(blockId)` is true
- `frontend/app/view/sourcecontrol/sourcecontrol-model.ts` — `onHide()` backs off poll to 30s, `onShow()` restores 3s + immediate `fetchStatus()`
- `frontend/app/view/preview/preview-model.tsx` — `onShow()` bumps `refreshVersion` to trigger re-fetch
- `frontend/app/view/processviewer/processviewer.tsx` — `onHide()` stops polling, `onShow()` restarts polling

**Key design decisions:**
- `hideNode` removes the node from the layout tree but does NOT call `onNodeDelete`/`DeleteBlock` — the block object survives in the backend
- `cleanupOrphanedBlocks` checks `isHiddenBlock(blockId)` to skip hidden blocks (they're in `tab.blockids` but not in the layout tree)
- `BlockInner` cleanup checks `isHiddenBlock(blockId)` — if true, skips `unregisterBlockComponentModel` + `dispose` so the ViewModel survives
- `hiddenBlockModels` keyed by `viewType:connection` — toggling the same widget type for the same connection reuses the hidden block
- `hideBlockModel` is called BEFORE `hideNode` so `isHiddenBlock` returns true when the React cleanup fires
- Tab-close leak: hidden blocks' ViewModels are not disposed if the tab is closed while a widget is hidden (acceptable — 30s poll backoff minimizes resource impact)

## 2026-07-12: wsh startup timeout fix (Layer 1+2) + stream-restart diagnostic logging

### Problem: Durable terminals unresponsive after sleep/wake or network blip

Two failure modes manifest as "terminal stuck, typing doesn't appear, Cmd+Shift+R doesn't help, app restart fixes it":

**Failure mode A — wsh-down zombie (fixed in this change):**
After sleep/wake, the 5s reconnect context (shared across SSH handshake + wsh startup) expires during the wsh retry backoff. `connectInternal` swallowed the wsh failure and marked the conn `Connected` with no route registered. Jobs can't reconnect (`RemoteReconnectToJobManagerCommand` fails — no route), `SendInput` fails, terminal stuck forever (keepalive is pure SSH, reports `Good`). The "always disable wsh" overlay was the tell.

**Failure mode B — Connected-but-no-stream (diagnostic logging added; fix pending):**
wsh/route is up, the job is marked `Connected`, `SendInput` succeeds (typing reaches the remote shell, remote `StreamManager` buffers the echo), but no `runOutputLoop` is pulling the stream — nothing appears locally. Restart re-runs `restartStreaming` → remote replays the buffer → typed text appears.

### Layer 1 fix: Decouple wsh startup timeout from connect context

`connectInternal` now passes a fresh 30s context (`wshStartupTimeout`) to `tryEnableWsh`, independent of the 5s connect context. The 5s context bounds only the SSH handshake (`ConnectToClient`); wsh startup (NewSession, version read, JWT exchange, route registration, retry backoff) gets its own generous timeout.

**File:** `pkg/remote/conncontroller/conncontroller.go` — `connectInternal` (~line 1610)

### Layer 2 fix: Fail the connection on technical wsh failure

`connectInternal` no longer swallows technical wsh failures as "Connected-without-wsh". Only `NoWshCode_Disabled` and `NoWshCode_UserDeclined` (intentional opt-out) continue without wsh. Technical failures (`WshError != nil`) return an error → `Connect` sets `Status_Error` → `closeInternal_withlifecyclelock` cleans up → scheduler retries with a fresh context. This prevents the zombie "Connected-without-route" state.

**File:** `pkg/remote/conncontroller/conncontroller.go` — `connectInternal` wsh result handling (~line 1628)

### Diagnostic logging added (for Layer 3 fix)

Logging was added to confirm which path produces failure mode B (Connected-but-no-stream). All logs use `[job:%s]` or `[conn:%s]` prefixes.

**conncontroller.go:**
- `connectInternal`: logs `ConnectToClient` duration and `tryEnableWsh` duration/result
- `startConnServerWithRetry`: logs ctx remaining time at each attempt (confirms Layer 1 — should show ~30s, not ~5s)

**jobcontroller.go:**
- `jobStreamHealth` map (`streamHealthInfo`): tracks per-job `active`, `startedAt`, `lastReadAt`, `totalBytes`, `streamId`
- `runOutputLoop`: sets `active=true` on start, updates `lastReadAt`/`totalBytes` on each read, sets `active=false` on exit
- `handleRouteEvent`: logs "route up: set Connected via route event (stream active=%v, streamId=%q) — stream NOT restarted here" — confirms Path 2
- `doReconnectJob` skip path: logs "already connected, skipping reconnect (stream active=%v, lastRead=%v, streamId=%q, totalBytes=%d)" — if `active=false` or `lastRead` is stale, that's the smoking gun
- `doReconnectJob` post-restartStreaming: logs success/failure — "restartStreaming failed after successful reconnect: ... (job left Connected without active stream)" confirms Path 1

### Layer 3 hypothesis (pending log confirmation)

Failure mode B has two paths, both leaving the job `Connected` with no active `runOutputLoop`:

**Path 1 — `doReconnectJob` sets `Connected` before `restartStreaming` succeeds:**
`doReconnectJob` calls `SetJobConnStatus(Connected)` then `restartStreaming`. If `restartStreaming` fails (PrepareConnect timeout, StartStream failure, route-not-ready), the job stays `Connected`-no-stream. Every subsequent `doReconnectJob` hits the "already connected, skipping" early return — the stream is never retried.

**Path 2 — `handleRouteUpEvent` sets `Connected` without restarting the stream:**
When the job's route re-registers independently of `doReconnectJob`, `handleRouteEvent` marks the job `Connected` and fires a status event but never calls `restartStreaming`. Later `doReconnectJob` calls skip (already connected).

**Planned Layer 3 fixes (apply after logs confirm which path fires):**
1. Move `SetJobConnStatus(Connected)` to after `restartStreaming` succeeds, or reset to `Disconnected` on failure
2. Make the "already connected, skipping" guard stream-health-aware: if `jobStreamHealth.active == false`, don't skip — restart the stream
3. `handleRouteUpEvent`: either don't mark `Connected` without a stream, or trigger `restartStreaming` when marking `Connected`
4. (Optional) Stream-health watchdog in `runOutputLoop`: if no data for N seconds while `Connected`, trigger `restartStreaming`

### How to read the logs

After a sleep/wake cycle where the terminal is stuck, grep the backend logs for:
```
grep "already connected, skipping reconnect" <log>
grep "route up: set Connected via route event" <log>
grep "restartStreaming failed" <log>
grep "output loop started\|output loop finished" <log>
```
- If "already connected, skipping" shows `active=false` → Path 1 (stream never started or died)
- If "route up: set Connected via route event" fires but no "output loop started" follows → Path 2
- If "restartStreaming failed" appears → Path 1 confirmed (restartStreaming error)
- If "output loop started" appears but no "output loop finished" and no new "started" on reconnect → stream is alive but stalled (watchdog needed)
