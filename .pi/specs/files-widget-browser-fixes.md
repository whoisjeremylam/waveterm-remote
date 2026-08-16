# Files Widget — Browser Fixes & Native Drag-Out

Date: 2026-08-16
Branch: `feat/files-widget`
Status: bugs 1 & 2 implemented (commit `09ab3200`, pending review); bug 3 not implemented
Intended for: `/skill:phased-implement .pi/specs/files-widget-browser-fixes.md`

## Context

Three browser defects were reported:

1. **Refresh does not re-read a previewed file.** The header refresh button
   delegated to a per-view `refreshCallback` that was missing for CSV, a no-op
   for streaming (the media URL never changed), and absent entirely for the
   code-edit view.
2. **Sort order / column sizing lost on navigate-back.** TanStack table state
   was component-local; navigating into a file unmounted the directory view and
   reset sorting and column widths.
3. **Drag from the widget to the OS desktop rubber-bands back (macOS).** The
   row uses react-dnd, which does not populate a native `dataTransfer` payload
   the OS accepts, so Finder rejects the drop and the icon animates back; only
   then does the `handleNativeDragEnd` download fallback fire.

## Status

- Bug 1 (refresh) — **implemented** in commit `09ab3200`; **pending review**.
- Bug 2 (sort/column persistence) — **implemented** in commit `09ab3200`; **pending review**.
- Bug 3 (native drag-out) — **not implemented**; this is the Build Order below.

## Decisions

- **Bug 3 transport: option (a).** Pre-download the remote file to a local temp
  path at drag start, then call Electron `webContents.startDrag({ file, icon })`
  for a true native file drag. (Option (b) URL drag rejected — produces a
  `.webloc` shortcut, not a real file.)
- **In-app vs OS drag disambiguation: modifier key.** Electron `startDrag` and
  react-dnd cannot share the same plain drag gesture: `startDrag` replaces the
  HTML5 drag, and it requires the file to exist locally at drag start, which
  would force a wasteful pre-download for in-app move/copy (which is a
  server-side operation needing no local bytes). Therefore:
  - **Plain drag** = existing in-app move/copy (react-dnd, unchanged), keeping
    the current `handleNativeDragEnd` download fallback for plain OS drops.
  - **Option/Alt-drag** (Option on macOS, Alt on Win/Linux) = native OS export
    via `startFileDrag` (pre-download to temp + `startDrag`).

  This is flagged for user confirmation: if "plain drag = OS export" is
  preferred instead, in-app move/copy must be re-implemented with native drag
  events plus a drag-source registry (larger change, deferred).

## Build Order

1. **Electron IPC for native file drag** — preload + `ElectronApi` type + a main
   handler that downloads a remote URI to a temp file and calls `startDrag`.
2. **Frontend drag-out trigger** — modifier-detected `onDragStart` on the
   directory table row that invokes `startFileDrag`; plain drag stays react-dnd.
3. **Temp-file lifecycle & progress** — progress during pre-download (reuse the
   block upload overlay) and temp-file cleanup on drop/cancel/app-quit.

## Phase scope & test cases

### Phase 1 — Electron IPC for native file drag

Scope:
- `emain/preload.ts`: expose `startFileDrag(remoteUri, fileName, isDir)` →
  `ipcRenderer.send("start-file-drag", { remoteUri, fileName, isDir })`.
- `frontend/types/custom.d.ts`: add `startFileDrag` to the `ElectronApi` type.
- `emain/emain-ipc.ts`: `ipcMain.on("start-file-drag", ...)` handler that:
  - rejects directories (`isDir`) early;
  - streams `GET <web-server>/wave/stream-file?path=<remoteUri>` to a temp file
    under `app.getPath("temp")` (reuse the existing `getWebServerEndpoint`);
  - calls `event.sender.startDrag({ file: tempPath, icon: <file-type icon> })`;
  - registers the temp file for cleanup (app-quit sweep + TTL).

Tests:
- Happy path: a valid remote file URI → temp file created with matching bytes,
  `startDrag` invoked with that path.
- Error path: invalid/unreachable URI → error logged, `startDrag` not called, no
  temp file left behind.
- Directory rejection: `isDir` request → handled without download/startDrag.

### Phase 2 — Frontend drag-out trigger

Scope:
- `frontend/app/view/preview/preview-directory.tsx` `TableRow`: add a native
  `onDragStart` that checks `event.altKey` (Option on macOS) and, when set,
  calls `event.preventDefault()` + `getApi().startFileDrag(dragItem.uri, name,
  isDir)`.
- Leave react-dnd `useDrag` intact so plain drag still moves/copies in-app.

Tests:
- Option/Alt-drag on a file row → `startFileDrag` called with the correct URI;
  the react-dnd drag is suppressed.
- Plain drag on a file row → no `startFileDrag` call; react-dnd in-app drop
  still moves/copies.
- Option/Alt-drag on a directory row → rejected/disabled (Phase 1 rule).

### Phase 3 — Temp-file lifecycle & progress

Scope:
- During pre-download, drive the existing block upload overlay via
  `setBlockUploadState` (from `@/app/store/global`) so large files do not
  appear hung.
- Ensure temp files are cleaned up when the drag ends (drop, cancel) and on app
  quit; repeated drags must not accumulate temp files.

Tests:
- A slow/large drag shows the overlay during download and clears it after.
- Repeated drags do not accumulate temp files (temp dir holds only in-flight
  drags).

## Review notes (bugs 1 & 2 — already committed, must be reviewed)

- Run a TypeScript build/typecheck (CI). The worktree had no `node_modules`, so
  the fixes were only manually type-verified.
- Confirm refresh semantics per view: `refresh()` clears the saved-content
  buffer but leaves unsaved edits (`newFileContent`) intact; verify markdown,
  CSV, streaming (cache-bust), and code-edit each re-read correctly from disk.
- Confirm persistence: sort order, column widths, and column visibility survive
  navigating into a file and back (and block hide/show), and initialize from
  `preview:defaultsort`.
