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

- [ ] **Visibility-driven reconnect & auto-reconnect fixes** (spec: [[.pi/specs/visibility-driven-reconnect.md]], design: [[.pi/specs/reconnection-design.md]])
  - [x] Change 1: Fix `needsInteractiveAuth` / `canAutoReconnectLocked` — key-based connections wrongly classified as interactive (add `HasConnected && no password secret` short-circuit)
  - [x] Change 2: Don't clear cached password on stall auto-disconnect (`CloseInvoluntary` for involuntary disconnects)
  - [x] Change 3: Visibility-driven reconnect — fire `ConnEnsureCommand` on tab switch / app focus for disconnected blocks (`frontend/app/tab/visibilityreconnect.tsx`, mounted in `workspace.tsx`)
  - [x] Change 4: Serialize password prompts per-window (backend semaphore in `userinput.go`)
  - [ ] Change 5: Tune scheduler bounds (15min cap for silent-reconnectable) + early-stop on `auth-failed`
  - [x] Change 6: Verify `HandleSystemResume` benefits from Changes 1+2 — stall path now uses `CloseInvoluntary` (Change 2); `needsInteractiveAuth` returns false for key-based (Change 1). Code-complete, pending manual validation.
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

### Features to Add (discuss, spec, scope later)

- **MOSH support** — Research done 2026-05-20. MOSH's main benefits: seamless reconnection (roaming, sleep/wake) and client-side local echo. Not a priority because: (1) no port forwarding (open issue since 2014), (2) no OSC52 clipboard, (3) no scrollback, (4) C++ only, slow development. tsshd (trzsz-ssh) is the more relevant reference — Go-based, full SSH features + UDP roaming, but significant architectural change. Local echo is technically possible with wsh but non-trivial and low-value for typical latency.
- **Vertical tabs** — Tab layout optimized for remote host switching



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
