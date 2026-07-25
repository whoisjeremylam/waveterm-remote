# Close Button ('x') Not Working on Web Widgets / Help View

**Date:** 2026-06-09
**Issue:** Clicking the close ('x') button in the top-right corner of web widgets (and the Help view, which is a skinned webview) has no effect.

## Diagnosis

### Code Path Verification

The close button logic was traced from the UI down to the layout model:

1. **UI:** `frontend/app/block/blockframe-header.tsx` — `HeaderEndIcons` renders the close button as an `IconButton` with `click: () => uxCloseBlock(nodeModel.blockId)`.
2. **Click Handler:** `frontend/app/hook/useLongClick.tsx` — Native DOM event listeners attach `mousedown`, `mouseup`, and `click`. For the close button (no `onLongClick`), the flow is:
   - `mousedown` → `startPress` returns early (no long-click handler)
   - `mouseup` → `stopPress` clears null timer
   - `click` → `handleClick` checks `longClickTriggered` (always `false` here) → calls `onClick` → `uxCloseBlock`
3. **Close Logic:** `frontend/app/store/keymodel.ts` — `uxCloseBlock()`:
   - If last block in tab → calls `simpleCloseStaticTab()`
   - Otherwise → gets `layoutModel`, finds node by `blockId`, calls `layoutModel.closeNode(node.id)`
4. **Layout Cleanup:** `frontend/layout/lib/layoutModel.ts` — `closeNode()` removes node from tree or clears ephemeral node, then calls `onNodeDelete` → `ObjectService.DeleteBlock()`.

The React/JavaScript code path is correct. The button is not `disabled`, the closure captures the right `blockId`, and `memo` wrappers do not prevent event attachment.

### Root Cause: Electron Webview Compositing Layer Interference

The issue is **specific to `<webview>` blocks** (web widgets and Help). Other block types (terminal, preview, etc.) do not exhibit this problem.

Electron `<webview>` elements render as **guest views** in a separate webContents process with their own compositing surface. There is a known class of Electron/Chromium bugs where guest-view hit-test regions overlap or misroute mouse events intended for the parent webContents:

- **Electron issue #48084** (closed as "not planned") demonstrates that mouse events inside a `<webview>` can leak into the parent webContents. The reverse behavior — guest views intercepting clicks on nearby parent UI — is consistent with the same underlying compositing problem.
- The webview CSS (`frontend/app/view/webview/webview.scss`) explicitly forces a compositing layer:
  ```scss
  transform: translate3d(0, 0, 0);
  will-change: transform;
  ```
- The block header (`.block-frame-default-header`) has **no explicit stacking context** — it is a flex child with default `position: static` and no `z-index`. In Electron's compositor, the webview's guest-view layer can therefore render above the header and steal pointer events in the header area, particularly near the top-right corner where the close button sits.

### Why the Header Should Not Overlap Visually

The DOM structure is:
```
.block-frame-default-inner (flex-direction: column)
  ├── .block-frame-default-header (max-height: 30px, min-height: 30px)
  └── .block-content (flex-grow: 1, overflow: hidden)
        └── <webview> (height: 100%, width: 100%)
```

Visually the webview is contained within `.block-content` below the header. However, Electron's guest-view compositing does not strictly respect CSS flex boundaries for **hit-testing** — the guest view's input region can extend beyond its layout bounds when transforms or other compositing triggers are present.

## Workarounds

1. **Keyboard shortcut** — Use `Cmd+W` (macOS) or `Ctrl+W` (Windows/Linux) to close the focused block. This routes through `genericClose()` in `keymodel.ts` and bypasses the mouse-event interception entirely.
2. **Context menu** — Right-click the block header and select "Close Block". The context menu (`handleHeaderContextMenu` in `blockframe-header.tsx`) also calls `uxCloseBlock()` and may avoid the webview's hit-test region because the menu renders in a separate overlay.

## Potential Fixes (Untested)

### CSS Stacking Context Fix
Add `position: relative; z-index: 1;` (or higher) to `.block-frame-default-header` in `frontend/app/block/block.scss`. This would force the header into its own compositing layer and explicitly place it above the default layer (z-index 0), potentially causing Electron's compositor to route clicks to the header rather than the webview guest view.

### Remove Webview Transform
Removing `transform: translate3d(0, 0, 0)` and `will-change: transform` from `.webview` in `frontend/app/view/webview/webview.scss` would prevent the webview from creating its own compositing layer, but this may reintroduce subpixel rendering artifacts that the upstream authors were trying to avoid.

## Related Upstream Code

- `frontend/app/view/webview/webview.tsx` — `WebViewModel.giveFocus()` and webview event listeners
- `frontend/app/block/blockframe-header.tsx` — Close button declaration (`closeDecl`)
- `frontend/app/block/block.scss` — `.block-frame-default-header`, `.block-frame-default-inner`, `.block-content`
- `frontend/app/view/webview/webview.scss` — `.webview` compositing rules
- `frontend/app/hook/useLongClick.tsx` — Click/long-click event attachment hook
- `emain/preload-webview.ts` — Webview preload script (runs inside guest page, not parent)
