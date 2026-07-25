# Web Widget Close Button ("X") Click Failure

## Symptom

When a web widget or help widget is open, clicking the "X" (close) button in the
top-right corner of the block header does nothing. The button renders visually
but clicks do not register.

## Root Cause: Electron `<webview>` Guest View Intercepts Mouse Events

### How the Close Button Works

The close button is rendered inside `BlockFrame_Header` (`blockframe-header.tsx`):

```
HeaderEndIcons → IconButton (decl: { icon: "xmark-large", click: uxCloseBlock })
```

`IconButton` (`iconbutton.tsx`) uses `useLongClick` to attach a native DOM
`click` event listener to the `<button>` element. When clicked, `uxCloseBlock`
(`keymodel.ts`) removes the block from the layout tree via `layoutModel.closeNode`.

### Why It Fails for Web Widgets

The `<webview>` Electron tag renders its content as a **separate guest view
process** embedded via Chromium's out-of-process iframe (guest view) mechanism.
This guest view is visually overlaid on top of the parent DOM, but it also
**captures mouse/pointer events in its bounding region**, including areas that
visually overlap with sibling DOM elements like the block header.

Key observations from the code:

1. **The webview fills the block content area** (`webview.scss`):
   ```scss
   .webview, .webview-container {
       height: 100%;
       width: 100%;
       border: none !important;
       ...
   }
   ```

2. **The block header has no explicit stacking context** (`block.scss`):
   - `.block-frame-default-header` has no `position` or `z-index` declared.
   - Only `.block-header-animation-wrap` has `z-index: var(--zindex-header-hover)`
     (value: 100), but this element is only used for animation and is not the
     header itself.

3. **The `.block-mask` overlay uses `pointer-events: none`** by default
   (`block.scss` line 40), so it doesn't block clicks — but it also doesn't
   help the header receive them.

4. **The webview's error overlay explicitly sets `z-index: 100`**
   (`webview.scss` line 30), which is the *same* value as the header animation
   wrap's z-index. This confirms that z-index is already being used to layer
   webview elements above other block content.

5. **The `<webview>` tag itself has no explicit z-index or position** in its
   React rendering (`webview.tsx`), but the guest view rendering in Electron
   bypasses normal CSS stacking — it creates a separate compositor layer that
   sits on top of the parent's DOM.

### The Electron Guest View Stacking Problem

In Electron's architecture, `<webview>` tags create **BrowserProxyWidget**
guest views that are composited as separate layers. These guest views sit
**visually and event-wise on top of** the parent document's DOM, regardless of
CSS z-index. This is why:

- The header **appears** to be on top (it's rendered in the parent DOM).
- But **clicks** on the header area near/overlapping the webview are swallowed
  by the guest view's event handler.
- The `useLongClick` hook (`useLongClick.tsx`) attaches native DOM events
  (`mousedown`, `mouseup`, `mouseleave`, `click`) to the `<button>` element.
  These never fire if the guest view captures the pointer event first.

### Why It Works for Terminal Blocks

Terminal blocks use `<canvas>` (via xterm.js) which is a regular DOM element
that respects CSS stacking and pointer-events. The header above a terminal
block always receives clicks because there's no guest view intercepting them.

## Potential Fixes

### Option A: Set `position: relative` + `z-index` on the Header

Add explicit stacking context to `.block-frame-default-header`:

```scss
.block-frame-default-header {
    position: relative;
    z-index: 101; // above webview guest view
}
```

**Risk**: This may not work reliably because Electron's guest views are
composited outside the normal CSS stacking context. The guest view layer is
managed by the Chromium compositor, not the parent document's render tree.

### Option B: Use Electron's `setInspectableContent` or Overlay Controls

Add a transparent overlay div above the webview that captures clicks and
delegates them, while the webview sits below it. This would require:

- A `.webview-overlay` div with `position: absolute`, `z-index: high`,
  covering the header area.
- The overlay would need `pointer-events: auto` on the header region and
  `pointer-events: none` on the content region (so the webview still receives
  normal interaction clicks).

### Option C: Use Electron IPC to Detect Header Clicks

Since the webview guest view may swallow clicks, we could:

1. Detect when the mouse enters the header area (via `pointerenter`/`mousemove`).
2. Use Electron's `webContents` API to temporarily disable mouse capture on
   the guest view when the cursor is in the header region.
3. Re-enable capture when the cursor leaves the header.

### Option D: Add an Overlay Above the Webview with Pointer-Events

The most practical fix would be to add a click-capturing overlay that sits
between the header and the webview:

```tsx
// In the WebView component or BlockFrame, add an invisible overlay
// that only captures clicks in the header region
<div className="webview-header-overlay" 
     style={{ position: 'absolute', top: 0, height: '30px', 
              zIndex: 101, pointerEvents: 'auto' }} />
```

### Option E: Force the Header into a Higher Electron Compositor Layer

Electron's `<webview>` guest views are composited as "transparent" layers
positioned at the guest's location. If the header element is promoted to its
own compositor layer (via `will-change: transform` or CSS `transform`), it
*may* stack above the guest view. This is fragile and browser-version-dependent.

## Evidence Path

| File | What to Check |
|------|--------------|
| `frontend/app/block/blockframe-header.tsx` | Close button declaration (line 199-203), `uxCloseBlock` call |
| `frontend/app/element/iconbutton.tsx` | `useLongClick` attaches native DOM `click` to `<button>` |
| `frontend/app/hook/useLongClick.tsx` | Adds `mousedown`/`mouseup`/`click` listeners on the button ref |
| `frontend/app/store/keymodel.ts` | `uxCloseBlock` (line 144) — the actual close logic |
| `frontend/app/view/webview/webview.tsx` | `<webview>` tag rendering (line ~1110), no stacking control |
| `frontend/app/view/webview/webview.scss` | `z-index: 100` on `.webview-error` overlay |
| `frontend/app/block/block.scss` | Header has no `position` or `z-index` |
| `emain/emain-ipc.ts` | `webview-focus` IPC handler — webview captures focus events |
| `emain/preload.ts` | `setWebviewFocus`, `webview-new-window` — Electron guest view IPC |

## Quick Verification

To confirm the diagnosis, in a running waveterm app:

1. Open a web widget (e.g., `web https://example.com`)
2. Right-click the "X" close button — if the context menu shows web page
   options (like "Back", "Reload") instead of the native/browser context menu,
   the guest view is intercepting the event.
3. Try clicking the "X" while the web page is still loading — if it works
   *before* `dom-ready` fires but not after, it confirms the guest view takes
   over event handling once loaded.