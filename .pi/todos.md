# Active Tasks

## Phase 1: Dev Environment ✅

- [x] Install Task (build runner)
- [x] Install Go 1.25+
- [x] Run `task init` to install dependencies
- [x] Run `task dev` — confirm app launches
- [x] Run `task start` — confirm standalone build works
- [x] Set up macOS CI workflow

## Phase 2: Feature Planning

- [ ] Finalize list of features to ADD
- [x] Finalize list of features to REMOVE or DIMINISH
- [ ] Prioritize implementation order

### Features to Remove / Disable

> "Remove" means **disable and hide from the UI** — don't delete code initially. Makes it easy to re-enable if needed and keeps the fork closer to upstream.

- **All Wave AI features** — AI widgets, AI chat, AI presets, context-aware assistant, AI-related UI elements and settings

## Dependency Maintenance

- [x] **Upstream dependency bumps** (issue #12) — completed 2026-05-29
  - [x] Merge 3 upstream commits (`a5ac0962`, `81f7b1a5`, `c0687de2`)
    - `google.golang.org/api` 0.275.0 → 0.277.0
    - `qs` 6.14.2 → 6.15.2, `express` 4.22.1 → 4.22.2
    - Resolved merge conflict: `docs/docs/waveai-modes.mdx` (keep deletion)
  - [x] Bump `golang.org/x/crypto` 0.50.0 → 0.52.0 (CVE-2026-39827 SSH memory leak, CVE-2026-46598 ed25519 panic)
  - [x] `go mod tidy` cleaned up transitive deps (`x/net`, `x/sys`, `x/term`, `x/text`)
  - [x] `task build:server` passes

## Phase 3: Implementation

### High Priority — Bugfix

- [x] **Durable session auto-reconnect unreliable** (draft: [[.pi/draft-issue-autoconnect-bugs.md]]) — P0 bugs fixed 2026-05-23
  - [x] Bug #1 (P0): Route-level cooldown consumed before connection check — moved `lastAutoReconnectAttempt.Set` into `attemptAutoReconnect` after `IsConnected` passes
  - [x] Bug #2 (P0): connStates reconciliation race — replaced `processed bool` with generation counters (`actualGen` / `procGen`); `reconcileConn` now sends follow-up signal if `actualGen != procGen` at finish
  - [x] Bug #3 (P0): singleflight caches transient reconnect failures — split `reconnectGroup` into `reconnectConnGroup` and `reconnectRouteGroup`; route-level `attemptAutoReconnect` now calls `ReconnectJobRoute` instead of sharing the connection-level cache
  - [x] Decision 2026-05-23: Server reboot / `wsh` death → manual reconnect (do NOT auto-restart fresh shell). Auto-restart would change durable-session semantics from "resume existing shell" to "keep shell open at all costs," creating context-loss confusion and `wsh` re-install loops.
  - GitHub issue (problem): https://github.com/whoisjeremylam/waveterm-remote/issues/7
  - GitHub issue (implementation): https://github.com/whoisjeremylam/waveterm-remote/issues/8
  - Branch: `fix/auto-reconnect-detection-gaps`
  - [x] Phase 1 (Gap C): Auto-disconnect on stall — `ConnMonitor` detects stall but doesn't set `Status=Disconnected`
    - Commit `b4c4dbea`: Add configurable `ConnStallDisconnectThreshold` to `ConnKeywords`
    - Trigger `conn.Close()` when stall exceeds threshold (removed `!isUrgent()` guard per spec review)
    - Commit `a157b234`: Add `AttemptReconnect` helper + reconnect scheduler in `onConnectionDown` (fixes GAP-1)
    - This makes sleep/Wi-Fi/VPN interruptions self-healing via existing `onConnectionUp`
  - [x] Phase 2 (Gap A): Implement `NotifySystemResumeCommand` — commit `a157b234` + Phase 2 additions
    - `emain.ts` already hooks `powerMonitor.on('resume')` → calls `NotifySystemResumeCommand`
    - `wshserver.go`: `NotifySystemResumeCommand` now calls `jobcontroller.HandleSystemResume(ctx)` instead of no-op
    - `jobcontroller.go`: `HandleSystemResume` iterates all connections, finds those with durable jobs, forces disconnect on stalled zombies, spawns `AttemptReconnect()` goroutines for immediate reconnect
    - Fast-path: bypasses 30s scheduler tick, attempts reconnect within ~1-2s of system wake
  - [x] Phase 3 (Gap B): Aggressive scheduler enhancement — implemented as Option B
    - `isNetworkUnreachableError()` detects dial tcp i/o timeout, no route, DNS failure
    - On network-unreachable error: switch to 5s interval for 2 minutes
    - When user switches back to good Wi-Fi, next 5s tick reconnects automatically
    - After 2 minutes aggressive: returns to 30s interval for remaining scheduler window
    - If still no network after total 5 min: scheduler gives up (manual reconnect required)
    - No native modules, zero build risk, cross-platform automatically
  - Edge cases (P2): respect manual disconnect, reconnect UI indicator

- [x] **wsh startup timeout fix (Layer 1+2) + stream-restart diagnostic logging** — 2026-07-12
  - Symptom: durable terminals unresponsive after sleep/wake; Cmd+Shift+R doesn't help; app restart fixes it. "always disable wsh" overlay appeared in one instance.
  - Layer 1: Decouple wsh startup timeout from connect context (`connectInternal` passes 30s `wshCtx` to `tryEnableWsh`, independent of the 5s connect context)
  - Layer 2: Fail the connection on technical wsh failure (only `Disabled`/`UserDeclined` continue without wsh; technical `WshError` returns error → `Connect` sets `Status_Error` → scheduler retries)
  - Diagnostic logging: `jobStreamHealth` map, `runOutputLoop` start/exit/bytes, `doReconnectJob` skip path with stream health, `handleRouteEvent` route-up without stream restart, `restartStreaming` success/failure, `connectInternal`/`startConnServerWithRetry` timing
  - See [[decisions.md#2026-07-12-wsh-startup-timeout-fix-layer-12--stream-restart-diagnostic-logging]] for the Layer 3 hypothesis (failure mode B: Connected-but-no-stream)
  - Branch: `fix/wsh-startup-timeout`

- [x] **Phase 2G: Resume-from-sleep renderer unpause** — 2026-07-21 (commit `b6f7487a`, on `origin/main`)
  - Symptom: After laptop sleep/wake, a durable remote terminal block shows "connected" but typing produces no visible output. Keystrokes ARE sent (visible after app restart). Backend reconnection is fully successful; the bug is in the frontend xterm.js renderer pause state (`_isPaused` stuck `true` after sleep/wake because Chromium's `IntersectionObserver` does not re-fire).
  - Fix: In `refreshAfterVisibilityChange` (`termwrap.ts`), reset `_isPaused = false` before calling `renderRows` via the normal `RenderService.refreshRows` path. Future `terminal.write()` calls render normally.
  - See [[reconnection.md#phase-2g-resume-from-sleep-renderer-unpause-2026-07-21]].

- [x] **Phase 2H: Output-loop goroutine leak on reconnect** — 2026-07-21 (commit `6f04028a`, on `origin/main`)
  - Symptom: `runOutputLoop` goroutines never exited on reconnect (85 started, 0 finished, 0 superseded in the log). Each `restartStreaming` created a new `streamclient.Reader` but left the old reader blocked on `Read()` forever.
  - Fix: Added `jobReaders` (`ds.MakeSyncMap[*streamclient.Reader]`) to track the active reader per job. In `restartStreaming`, after setting `jobStreamIds` to the new streamId, close the previous reader. The old loop's `Read()` returns `io.ErrClosedPipe`, the supersession check sees the new streamId, and the loop exits cleanly.
  - See [[reconnection.md#phase-2h-output-loop-goroutine-leak-on-reconnect-2026-07-21]].

- [x] **Disk-backed stream history & backpressure break** — 2026-07-23 (commits `cf039928`, `953a4961`, `b8090029`)
  - Symptom: Dropping network connectivity to a remote durable connection froze pi (PTY backpressure cascade: `readLoop` blocks on `WriteAvailable` → PTY kernel buffer fills → pi's `write()` blocks). `ClientDisconnected` was never called during a network outage.
  - Fix Part A: `DataSender.SendData` returns `error` with 5s `SendDataTimeout` → `handleSendFailure` → `ClientDisconnected` + `activateDiskBuffering` (switches to 2MB async CirBuf + disk file).
  - Fix Part B: On reconnect, `ClientConnected` starts `drainDiskToCirBuf` to replay buffered PTY output from the disk file. No data lost during the outage.
  - Spec: [[disk-backed-stream-history.md]]. See [[reconnection.md#phase-2m-disk-backed-stream-history--backpressure-break-2026-07-23]].
- [x] **Visibility-driven reconnect & auto-reconnect fixes** (spec: [[.pi/specs/visibility-driven-reconnect.md]], design: [[.pi/specs/reconnection-design.md]]) — 2026-07-23
  - [~] Change 1: Fix `needsInteractiveAuth` / `canAutoReconnectLocked` — **superseded by main's runtime `authPromptState`/`CanReconnectWithoutPrompt` model** (commit 634bdc27), which is more comprehensive (handles passphrase-encrypted keys, auth-failed state, config fallback). The feature branch's `HasConnected` heuristic is NOT adopted.
  - [x] Change 2: Don't clear cached password on stall auto-disconnect (`CloseInvoluntary` for involuntary disconnects) — adopted (commit `402acb77`, tests `8f9c0a67`). See [[reconnection.md#phase-2k-involuntary-disconnect-preserves-cached-password-2026-07-23]].
  - [x] Change 3: Visibility-driven reconnect — fire `ConnEnsureCommand` on tab switch / app focus for disconnected blocks (`frontend/app/tab/visibilityreconnect.tsx`, mounted in `workspace.tsx`) — commit `d519f484`. See [[reconnection.md#phase-2i-visibility-driven-reconnect-2026-07-23]].
  - [x] Change 4: Serialize password prompts per-window (backend semaphore in `userinput.go`) — commit `98bbd632`. See [[reconnection.md#phase-2j-per-window-password-prompt-serialization-2026-07-23]].
  - [x] Change 5: Tune scheduler bounds (15min cap for silent-reconnectable via `ConnReconnectMaxDurationSilent`) + early-stop on `auth-failed` and `connection-refused` — commit `fd78d03a`. See [[reconnection.md#phase-2l-scheduler-tuning-silent-cap--early-terminate-2026-07-23]].
  - [x] Change 6: `HandleSystemResume` stall path uses `CloseInvoluntary` (Change 2). Code-complete, pending manual validation.
  - Root cause: `needsInteractiveAuth` infers interactive auth from SSH default flags (password/kbd-interactive enabled when nil), not from whether the connection has authenticated via key before. Key-based connections never auto-reconnect on wake; `disconnectOnStall` → `Close()` clears the cached password ~10s after wake.

- [x] **Tmux mouse integration lost on durable session reconnect** — FIXED 2026-05-19
  - Bug: tmux mouse mode (click to switch windows, wheel scrollback, click-drag select) works in new sessions but NOT in reconnected durable sessions after full WaveTerm restart
  - Repro: close WaveTerm completely → restart → durable sessions reconnect → tmux mouse integration disabled
  - Expected: durable sessions should re-enable tmux mouse integration on reconnect, same as new sessions
  - Root cause: xterm.js internal DEC private mode state lost on reconnect; only cached terminal data was replayed, not mode negotiation sequences
  - Fix commits: `af669bcb` (original DEC mode restore), `01f5073d` (multi-param CSI tracking, clear-all reset, stale cache purge, replay whitelist)
  - Tests: `f839f8ab` (14 Vitest unit tests with mocked xterm.js)
  - GitHub comment posted to issue #2 with full analysis
  - README fork notes updated with bug fix reference
- [x] **Crash on tab close after SSH session exit** — Fixed 2026-05-14
  - Root cause found: double `DestroyBlockController` race in `CloseTab` (explicit goroutine + `DeleteTab` → `BlockCloseEvent` handler)
  - Fix: removed redundant goroutine in `CloseTab`; added `sync.Once` to `ShellProc.Close()` as defense-in-depth
  - Added trace logging to `CloseTab`, `DestroyBlockController`, `ShellController.Stop`, `DurableShellController.Stop`, `handleBlockCloseEvent`
  - Tests: fixed 2 panicking tests (channel double-close bug in test code), all 14 tests pass under `-race`
  - Spec: [[.pi/specs/bug-tabclose-crash.md]]
  - [x] **Post-confirm cleanup:** Removed trace logging 2026-05-14

### Features

- [x] Remove telemetry (spec: [[.pi/specs/remove-telemetry.md]])
  - [x] Phase A: Remove call sites
  - [x] Phase B: Remove frontend telemetry
  - [x] Phase C: Delete unused packages
  - [x] Phase D: Clean up docs
- [x] Remove Wave AI features (spec: [[.pi/specs/remove-waveai.md]])
  - [x] Phase A: Disable UI (frontend) — completed 2026-05-16
    - [x] Fix blank screen: invalid nested `<Panel>` in `workspace.tsx` (removed inner PanelGroup but left VTabBar `<Panel>` orphaned inside outer `<Panel>`)
    - [x] Remove sparkle/Claude icon from terminal block header (`getShellIntegrationIconButton` → no-op stub)
    - [x] Minor: update misleading AI text in `builder-previewtab.tsx` EmptyStateView — fixed 2026-05-16
  - [x] Phase B: Remove backend wiring (Go) — 2026-05-15
  - [x] Phase C: Clean up docs & schemas — 2026-05-16
  - [x] Phase D: Delete unused code — completed 2026-05-16
    - [x] Remove builder AI dependencies (A.15: `AIPanel`, `WaveAIModel`, `formatFileSize`, `builder-focusmanager.ts`)
    - [x] Move `formatFileSize` to shared utility (`@/util/util`) — completed in commit bd355fad
    - [x] Delete `pkg/aiusechat/` (entire directory, ~12K lines, dead package)
    - [x] Delete `frontend/app/aipanel/` (17 files, orphaned after builder deps removed)
    - [x] Delete `frontend/app/view/waveai/`, `frontend/app/view/aifilediff/`, `frontend/app/view/waveconfig/waveaivisual.tsx`
    - [x] Delete `frontend/app/onboarding/fakechat.tsx`, preview files
    - [x] Clean Go structs: `SettingsType`, `MetaTSType`, `ObjRTInfo`, `FullConfigType`, `AIModeConfigType`, etc.
    - [x] Delete default configs: `waveai.json`, `presets/ai.json`, clean `settings.json`
    - [x] Regenerate auto-generated TS types (`gotypes.d.ts`, `waveevent.d.ts`, `wshclientapi.ts`) and Go metaconsts
  - [x] Document Claude Code shell integration analysis for future pi agent reuse (`.pi/decisions.md`)
- [x] SSH port forwarding (`LocalForward` / `RemoteForward`) (spec: [[.pi/specs/portforwarding.md]]) — completed 2026-06-04
  - [x] Modify `pkg/wconfig/settingsconfig.go`
  - [x] Modify `pkg/remote/sshclient.go` (parse + return merged keywords)
  - [x] Modify `pkg/remote/conncontroller/conncontroller.go` (runtime forwarding)
  - [x] Update call sites for new `ConnectToClient` signature
  - [x] Add tests
  - [x] Update documentation (`docs/docs/connections.mdx`)
- [x] **Port forwarding UI status indicators** (spec: [[.pi/specs/portforwarding-ui.md]]) — completed 2026-06-07
  - [x] Add `ForwardingRules []string` to `ConnStatus` struct (no new RPC needed)
  - [x] Populate in `DeriveConnStatus()` from `LocalForwardListeners`/`RemoteForwardListeners`
  - [x] Create `port-forward-status.tsx` component (plug icon + badge + tooltip)
  - [x] Wire into `blockframe-header.tsx` between DurableSessionFlyover and badge
  - [x] Go build passes, Go tests pass, TypeScript compiles cleanly
- [x] **Image rendering support** — `@xterm/addon-image` for Sixel, IIP, Kitty (branch: `feat/image-rendering-support`)
  - [x] Install and load ImageAddon in termwrap.ts (after WebGL renderer)
  - [x] Bridge public parser OSC 1337 to ImageAddon's IIP handler (prototype patch survives Reinit Wave)
  - [x] Fix IIP detection: upgrade to `@xterm/addon-image@0.10.0-beta.287` + `@xterm/xterm@6.1.0-beta.287`
  - [x] Fix TIFF rendering: chafa outputs TIFF for IIP, Chromium `createImageBitmap()` doesn't support TIFF — decode TIFF in termwrap.ts using JS base64 decoder + self-contained TIFF decoder (uncompressed + LZW)
  - [x] patch-package infrastructure for addon-image (TIFF detection in `IIPMetrics.ts`)
  - [x] Fix Sixel bottom-edge overlap: pre-scale Sixel images to cell-aligned dimensions in `SixelHandler.unhook()` before calling `addImage()` (same approach as IIP's `_resize()` + `Math.floor`)
  - [x] Pi extension published: `@whoisjeremylam/pi-waveterm-images@1.0.1` (enables kitty protocol via `setCapabilities()`)
  - [ ] Clean up: strip debug logging, remove `iip-debug-tests.js`, squash debug commits
  - [ ] Kitty image sizing: Kitty handler doesn't resize bitmaps to cell grid (unlike IIP's `_resize`), causing overflow past allocated cells
  - [ ] Kitty protocol not rendering: APC data flows (hundreds of chunks) but nothing renders — likely WaveTerm's binary data handler intercepts APC sequences before parser dispatches to Kitty handler
  - [ ] Durable session image restore: sidecar approach — spec at [[.pi/specs/durable-session-image-restore.md]]
    - [x] Add `exportImages()`/`importImages()` to ImageStorage via patch
    - [x] Add `SaveTerminalImages` RPC + `cache:term:images` file
    - [x] Modify `processAndCacheData()` and `loadInitialTerminalData()` in termwrap.ts
    - [ ] Atomic manifest write: crash during WriteFile could leave truncated JSON, losing all images. Fix: write to temp file then rename. Depends on filestore API supporting rename.
- [x] **Remote file paste** — image paste + drag-drop for remote sessions (completed 2026-06-23)
  - Primary use case: pasting screenshots and dragging files when using pi or Claude Code's TUI over SSH
  - Cherry-picked from `feature/remote-image-paste` branch
  - Sub-tasks:
    - [x] Go backend: `RemoteWriteTempFileCommand` RPC + types + client
    - [x] Frontend: `createRemoteTempFileFromBlob()` utility
    - [x] Frontend: Wire image paste (`termwrap.ts` `pasteHandler`) to use remote upload for SSH sessions
    - [x] Frontend: Wire drag-drop (`termwrap.ts` `dropHandler`) to use remote upload for SSH sessions
    - [x] Frontend: Extract generic `BlockOverlay` component from `ConnStatusOverlay` pattern
    - [x] Frontend: Add `uploadState` atom to `TermViewModel` and `UploadOverlay` component
    - [x] Frontend: Add input suppression (`handleTermData` guard) during upload
    - [x] Frontend: Mount `UploadOverlay` in `blockframe.tsx`
    - [ ] Tests
  - Known issues:
    - [ ] **Multi-file drag-drop UX:** Each file in a batch triggers its own upload overlay cycle (on/off/on/off). Should show a single overlay with file count or progress across all files.
    - [ ] **No upload progress:** Overlay shows spinner + filename but no bytes transferred or percentage. On slow connections the user has no feedback on how long the upload will take.
    - [ ] **50MB file size limit:** Hardcoded in `termutil.ts`. Base64 encoding adds ~33% overhead, so a 50MB file becomes ~67MB in the RPC payload. Increasing the limit risks renderer memory pressure (~3x file size peak).
    - [ ] **No temp file cleanup:** Remote temp files written to `/tmp/waveterm-*` are never deleted. Large files accumulate until remote reboots or manual cleanup.
    - [ ] **Base64-in-JSON transport:** Entire file is base64-encoded into a single JSON field. Not efficient for large files — a streaming/chunked approach would be better but is a larger architectural change.
    - [ ] **`ConnStatusOverlay` not refactored to use `BlockOverlay`:** Both use identical CSS classes but `ConnStatusOverlay` duplicates the styling instead of composing `BlockOverlay`. Low priority — cosmetic only.

- [ ] **System widgets follow terminal focus** (spec: [[.pi/specs/widget-follow-focus.md]])
  - When opening Process Viewer, File Browser, etc., inherit connection from focused terminal
  - [x] Add `getFocusedTerminalConnection()` helper in `global.ts` (completed in `ui-improvements`)
  - [ ] Add `createWidgetBlock()` wrapper that injects connection meta
  - [ ] Update widgets bar (`widgets.tsx`) to use `createWidgetBlock`
  - [ ] Add `inheritconnection` field to widget config schema
  - [ ] Verify non-terminal widgets (Settings, Help) are unaffected
  - [ ] Add tests

- [ ] Paste screenshots into terminal (local sessions — polish)
  - [ ] Consider implementing paste-as-image in Pi directly for tighter integration (avoid SCP+filename pattern, inject binary data or use OSC52/terminal-native paste)

## Phase 4: SCM Widget — AI Agent Change Review Workflow

**Primary use case:** Reviewing changes made by AI agents on remote machines. The SCM widget is the audit/review/approval dashboard, not a general-purpose git GUI.

### Analysis Complete (2026-06-25)

Full VS Code SCM diff view feature analysis done on `~/project/vscode`. Source files examined:
- `src/vs/workbench/contrib/scm/browser/scmViewPane.ts` (main panel)
- `src/vs/editor/browser/widget/diffEditor/diffEditorWidget.ts` (diff editor)
- `src/vs/editor/browser/widget/diffEditor/commands.ts` (diff commands)
- `src/vs/workbench/contrib/multiDiffEditor/browser/multiDiffEditor.ts` (multi-file diff)
- `extensions/git/src/commands.ts` (git commands)

### ✅ Already Done

- [x] **File list with status badges** — M/A/D/R/U with icon + color (MVP)
- [x] **Read-only diffs** — Side-by-side and inline via Monaco (MVP)
- [x] **Stage/Unstage individual files** — `git.stage`, `git.unstage`
- [x] **Stage/Unstage individual hunks** — Per-hunk actions from gutter toolbar
- [x] **Stage all / Unstage all** — `git.stageAll`, `git.unstageAll`
- [x] **Discard/revert changes** — `git.revertChange` per-file, per-hunk from gutter
- [x] **Commit message input** — Ctrl+Enter, auto-growing height
- [x] **Push with auth** — Credential dialog, secret store, GIT_ASKPASS fallback
- [x] **Directory dropdown** — Shared component with Files widget
- [x] **Word-level diff highlighting** — Inherited from Monaco

### P1 — Review Prerequisites (multi-file diff unlocks everything)

- [ ] **Multi-file diff view** — All changed files in a single scrollable editor. Prereq for commit inspection, review mode, and graph view. Middle-click on a file in SCM panel triggers this. VSCode ref: `multiDiffEditor.ts`, `git.openAllChanges`
- [ ] **Next/prev change navigation** — `F7` / `Shift+F7` to jump between diff regions. Essential for fast scanning across files in multi-diff mode

### P2 — Review Mode (better views for AI output review)

- [ ] **Unified "Changes" view** — Single flat list (not separate staged/unstaged sections) with per-file status badges (M/A/D/R). Per-hunk stage/revert actions inline. Sections toggleable as a setting for users who prefer groups
- [ ] **Summary stats in header** — "3 files, +47/-12" at a glance on open
- [ ] **File preview mode** — Toggle between Diff (current side-by-side/inline diff) and Preview (read-only syntax-highlighted full file content via Monaco). Essential for reviewing AI-written files where the diff is 100% green additions (new files) or the "before" is irrelevant to the review. Per-file button: [Diff | Preview]
- [ ] **Markdown rendered preview** — When previewing a `.md` file, render it (not diff). Reuse/improve the markdown viewer from the Files widget, or use a standalone renderer. The current Files widget preview isn't great — worth a dedicated improvement

### P3 — Change Provenance

- [ ] **Env var placeholders** — `WAVETERM_AGENT_NAME`, `WAVETERM_AGENT_MODEL`, `WAVETERM_AGENT_SESSION`. Set by agent harness, picked up by `wsh` on connect
- [ ] **Display in SCM** — Show agent name/model/session in file rows (for uncommitted changes from that connection), commit author/message (for committed changes)

### P4 — Pull/Push (explicit, not opaque)

- [ ] **Pull button with incoming count** — `git fetch` + show "Pull (3)". Badge on button shows how many commits are incoming
- [ ] **Fetch** — `git.fetch`
- [ ] **Branch ahead/behind** — Show `↓3 ↑2` in branch display. VSCode-style tracking against origin
- [ ] **Sync Changes** — Convenience button that runs pull then push. Lower priority than explicit buttons since it obscures what's happening

### P5 — Commit List + Graph

- [ ] **Simple commit list (default)** — Flat timeline like `git log --oneline --decorate`. Colored branch/tag labels, expandable to show changed files. No DAG lanes by default. Depends on multi-file diff (P1) for click-to-inspect
- [ ] **`git/log` RPC** — Backend command returning structured commit log (hash, message, author, date, parents, refs)
- [ ] **Graph mode toggle** — Minimal lane rendering (one thin line per branch, merge dots). Highlighted branch, rest dimmed. Closer to `git log --graph` with light styling than a full canvas DAG. Same data source as simple list
- [ ] **Filter/search** — By author, date range, message text, agent name

### P6 — Should Have

- [ ] **Commit amend** — `git.commitAmend`
- [ ] **Open file from diff** — `git.openFile`
- [ ] **Branch management** — `git.checkout`, `git.branch`, `git.deleteBranch`
- [ ] **Collapse unchanged regions** — `diffEditor.hideUnchangedRegions.enabled`
- [ ] **Compact mode** — `diffEditor.compactMode`

### P7 — Nice-to-Have

- [ ] **Stash operations** — `git.stash`, `git.stashPop`, `git.stashApply`
- [ ] **Merge/Rebase** — `git.merge`, `git.rebase` (with abort)
- [ ] **Gutter decorations** — Line-level insert/delete icons, configurable width
- [ ] **Overview ruler** — Change locations in editor scrollbar
- [ ] **Diff algorithm selection** — `legacy`, `advanced`, `advanced-external`
- [ ] **True inline diff** — `diffEditor.experimental.useTrueInlineView`

### VS Code Settings Reference (for future implementation)

- `scm.defaultViewMode`: `tree` or `list` (tree = hierarchical folders, list = flat)
- `scm.defaultViewSortKey`: `path`, `name`, or `status`
- `scm.countBadge`: `all`, `focused`, or `off`
- `scm.compactFolders`: Compress single-child folders in tree view
- `scm.autoReveal`: Auto-reveal active file in SCM view
- `scm.diffDecorations`: Where to show decorations (`all`, `gutter`, `overview`, `minimap`, `none`)
- `diffEditor.renderSideBySide`: Side-by-side vs inline
- `diffEditor.hideUnchangedRegions.enabled`: Auto-collapse unchanged regions
- `diffEditor.ignoreTrimWhitespace`: Ignore whitespace changes
- `diffEditor.diffAlgorithm`: `legacy` or `advanced`

### Key Keyboard Shortcuts (VS Code)

- `F7` / `Shift+F7`: Next/previous difference in diff editor
- `Ctrl+Enter`: Commit (accept input)
- `Up/Down Arrow`: Navigate commit history in input
- `Alt+F5` / `Alt+Shift+F5`: Next/previous file change in multi-diff

### Key Source Files (VS Code)

- `src/vs/workbench/contrib/scm/browser/scmViewPane.ts` — Main SCM panel tree view
- `src/vs/workbench/contrib/scm/browser/scmInput.ts` — Commit message input widget
- `src/vs/editor/browser/widget/diffEditor/diffEditorWidget.ts` — Core diff editor
- `src/vs/editor/browser/widget/diffEditor/commands.ts` — Diff editor commands
- `src/vs/workbench/contrib/multiDiffEditor/browser/multiDiffEditor.ts` — Multi-file diff
- `extensions/git/src/commands.ts` — All git commands

## Backlog / Ideas

### Reconnection UX (production readiness)

Spec: [[.pi/specs/reconnection-ux-backlog.md]]

Backend reconnection is largely done; remaining work is user-visible recovery, honesty, and edge scenarios.

**P0 — Trust & recovery**
- [ ] UX-0.1 Sticky suppress after user Disconnect
- [ ] UX-0.2 Job-level status when conn up / session down
- [ ] UX-0.3 Attention-bound recovery while dead tab is visible
- [ ] UX-0.4 Permanent failures (host key, etc.) stop silent retry
- [ ] UX-0.5 Cancel auto-retry + password Cancel semantics

**P1 — Clarity** (see full spec for acceptance criteria)
- [ ] UX-1.1 Post-give-up / early-stop overlay copy
- [ ] UX-1.2 Interactive-auth idle overlay
- [ ] UX-1.3 Stalled overlay heal-first actions
- [ ] UX-1.4 Wrong-password prompt feedback
- [ ] UX-1.5 Session gone CTA
- [ ] UX-1.6 Multi-connection password queue UX
- [ ] UX-1.7 Disk drain / catch-up indicator
- [ ] UX-1.8 Passphrase vs password prompt strings

**Ship gate:** all P0 + UX-1.1, 1.2, 1.5 + QA matrix Q1–Q12 in the backlog spec.

### Agent Orchestration API

- [ ] **wsh Agent API** — Agent orchestration via wsh commands (spec: [[.pi/specs/wsh-agent-api.md]])
  - Scope guardrail: "anything a human could do via the UI or keyboard"
  - Phase 1: `--json` output on existing read commands (`block list`, `connection list`, `tab list`)
  - Phase 2: New read commands (`block get` with scrollback, `config get`)
  - Phase 3: Write commands (`block create` with options, `block send-keys`, `block focus`, `config set`)
  - Phase 4: Agent helpers (`agent spawn`, `agent help`)
  - Discovery: `WAVE_TERMINAL=1` env var + `wsh agent help`
  - Security: no new auth surface — agent inherits user's permissions

### Forwarding Enhancements

- DynamicForward (SOCKS proxy) — out of scope for v1, needs SOCKS5 handler
- `wsh ssh -L` / `-R` CLI flags
- UI status indicator for active port forwards

### Session Persistence (Tmux + Wsh Overlap)

> Jeremy's note 2026-05-23: "I frequently lose all sessions when the server automatically restarts each week (part of a backup). I have to recreate tmux sessions manually."

- **Tmux session auto-restore on reconnect** — After server reboot + reconnect, automatically recreate tmux sessions (restore layout, windows, sessions). Currently lost because `wsh` / job manager dies and WaveTerm only reconnects the raw shell.
- **Tab name sync with tmux session name** — WaveTerm tab label follows tmux session name for visibility.
- **Bring tmux features into wsh** — Tmux provides persistence, session multiplexing, and screen visibility (for agents). Consider which tmux features overlap with WaveTerm durable sessions and where wsh could natively replicate them (session restore, window splitting, scrollback capture).

### UX Improvements

- **New block default connection** — Currently clicking '+' defaults to local; for remote-first workflow, should default to SSH/remote or at least not require manual switching
- **SSH config as source of truth** — Connection management currently pushes users to JSON/settings UI instead of naturally leveraging `~/.ssh/config` as the primary management interface

### File Transfer

- **Drag and drop file transfer** — Drag files into the file browser to upload; drag from file browser to download

### General

- Remove checks to `dl.waveterm.dev` (e.g., update checks, download URLs)
- Evaluate which other local-first widgets to remove/diminish

### tmux CWD Tracking

- [x] Implement `wsh setmeta` cwd push in shell integration (spec: [[specs/tmux-cwd-tracking.md]]) — implemented 2026-07-08
  - [x] Modify `bash_bashrc.sh`: `_waveterm_si_osc7` (wsh setmeta when blocked) + `_waveterm_si_precmd` (call osc7 when blocked)
  - [x] Modify `zsh_zshrc.sh`: `_waveterm_si_osc7` (wsh setmeta when blocked)
  - [x] Modify `fish_wavefish.sh`: `_waveterm_si_osc7` (wsh setmeta when blocked)
  - [x] Modify `pwsh_wavepwsh.sh`: `_waveterm_si_osc7` (wsh setmeta when blocked) + `_waveterm_si_prompt` (call osc7 when blocked)
  - [x] Go build passes (`./golang-1.26.2/bin/go build ./...`), shellutil tests pass
  - [ ] Manual test: tmux + `cd` + verify `cmd:cwd` updates via `wsh getmeta -b this`
  - [ ] Manual test: screen + `cd` + verify `cmd:cwd` updates
  - [ ] Manual test: non-tmux regression (OSC 7 still works)
  - [ ] Manual test: SCM widget shows correct repo under tmux

### Widget Keep-Alive

- [x] Implement widget hide/show (spec: [[specs/widget-keepalive.md]]) — implemented 2026-07-08
  - [x] Add `onHide()`/`onShow()` to ViewModel interface (`custom.d.ts`)
  - [x] Add `hiddenBlockModels` registry + `hiddenBlockIds` set to `global.ts`
  - [x] Add `hideNode()` / `insertExistingNode()` to `layoutModel.ts`
  - [x] Modify `cleanupOrphanedBlocks` in `layoutModel.ts` to skip hidden blocks
  - [x] Modify `toggleWidgetVisibility` in `widgets.tsx` to hide instead of close
  - [x] Modify `handleWidgetSelect` to reuse hidden blocks
  - [x] Modify `BlockInner`/`SubBlockInner` cleanup in `block.tsx` to skip dispose when hidden
  - [x] Implement `onHide()`/`onShow()` in `SourceControlViewModel` (poll backoff 3s→30s)
  - [x] Implement `onHide()`/`onShow()` in `PreviewModel` (refresh on show)
  - [x] Implement `onHide()`/`onShow()` in `ProcessViewerViewModel` (stop/restart polling)
  - [ ] Test: toggle preserves view mode, selected file, diff cache, commit message
  - [ ] Test: in-flight stage/commit survives toggle
  - [ ] Test: poll backoff while hidden (30s, not 3s)
  - [ ] Test: refresh on show catches up on changes
  - [ ] Test: true block deletion (X button) still disposes ViewModel
  - [ ] Test: multiple connections (hide SCM for conn A, open for conn B → new block, not reuse)

## New-Tab Connection Dropdown (typeahead + frecency)

Spec: [[.pi/specs/newtab-connect-dropdown.md]]

### Backend
- [ ] Add `ConnectCount int64` to `ConnController` struct (`pkg/remote/conncontroller/conncontroller.go`)
- [ ] Increment `ConnectCount` on successful connect (~line 938) and persist via `wconfig.SetConnectionsConfigValue("conn:connectcount")`
- [ ] Load `ConnectCount` from `connections.json` at connection init
- [ ] Add `ConnectCount`/`LastConnectTime` to `ConnStatus` (`pkg/wshrpc/wshrpctypes.go`); populate in `DeriveConnStatus`
- [ ] Add `ConnConnectCount`/`ConnLastConnectTime` to `ConnKeywords` (`pkg/wconfig/settingsconfig.go`)
- [ ] Go unit tests: `frecencyScore` table-driven; `DeriveConnStatus` exposes new fields; persistence round-trip

### Frontend
- [ ] Create `frontend/app/modals/conn-suggestions.ts` (shared: `filterConnections` case-insensitive, `sortConnSuggestionItems` frecency, `buildNewTabSuggestions`, `getConnectionsEditItem`, `getNewConnectionSuggestionItem`)
- [ ] Rewrite `frontend/app/tab/connectiondropdown.tsx` → `NewTabConnTypeahead` (input, filter, ↑/↓/Enter/Esc, portal to body, anchor to `+` ref)
- [ ] Add `newTabDropdownOpenAtom` to `frontend/app/store/global-atoms.ts`
- [ ] `frontend/app/store/keymodel.ts`: `Cmd:t` sets `newTabDropdownOpenAtom` instead of `createTab()`
- [ ] `frontend/app/tab/tabbar.tsx`: replace `showConnectionDropdown` state with atom; render `NewTabConnTypeahead`
- [ ] `frontend/app/tab/vtabbar.tsx`: same changes as `tabbar.tsx`
- [ ] `frontend/app/modals/conntypeahead.tsx`: import shared helpers; remove `getDisconnectItem`; case-insensitive filter

### Manual verification
- [ ] Frecency ordering (count × recency) ranks most-used/recent on top
- [ ] `ConnectCount` survives restart (persisted in `connections.json`)
- [ ] Cold start falls back to `display:order` → name (deterministic)
- [ ] Typing filters case-insensitively; Enter selects top match (no accidental New Connection)
- [ ] No-match: New Connection shown but NOT highlighted; explicit ↓ required to select it
- [ ] `Cmd-t` and `+` click both open dropdown with input focused
- [ ] Edit Connections in `+` dropdown opens `connections.json` in current tab
- [ ] Edit Connections + Disconnect removed from block-header dropdown; Reconnect kept
- [ ] Vertical tab bar parity with horizontal tab bar
