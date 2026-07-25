# Findings: Close 'x' Button Not Working on Web Widget / Help Views

## Symptom

Clicking the close 'x' button in the top-right corner of a block header has no effect when the block contains a `<webview>` — specifically the Web widget and the Help view. The button appears visually but does not close the block.

## Code Path (Correctly Implemented)

The close button wiring is correct end-to-end:

| Step | File | Line | Detail |
|------|------|------|--------|
| 1 | `frontend/app/block/blockframe-header.tsx` | 197–201 | `HeaderEndIcons` renders `<IconButton key="close" decl={closeDecl} />` where `closeDecl.click = () => uxCloseBlock(nodeModel.blockId)` |
| 2 | `frontend/app/store/keymodel.ts` | 144–154 | `uxCloseBlock` finds the node in the layout tree and calls `layoutModel.closeNode(node.id)` |
| 3 | `frontend/layout/lib/layoutModel.ts` | 1257–1285 | `closeNode` dispatches a `DeleteNode` action and fires `onNodeDelete` |

No defects in the close logic itself.

## Root Cause

### `IconButton` relies exclusively on native DOM event listeners

The `IconButton` component (`frontend/app/element/iconbutton.tsx`) does **not** attach an `onClick` prop to the `<button>` element. Instead, all click handling is delegated to the `useLongClick` hook (`frontend/app/hook/useLongClick.tsx`), which uses `element.addEventListener("click", handleClick)` and `element.addEventListener("mousedown", startPress)` — native DOM listeners, not React synthetic events.

The `<button>` in `IconButton` (line 18) has no `onClick`:

```tsx
<button
    ref={ref}
    className={clsx("wave-iconbutton", className, decl.className, { disabled, "no-action": decl.noAction })}
    title={decl.title}
    aria-label={decl.title}
    style={styleVal}
    disabled={disabled}
>
    {/* no onClick prop */}
</button>
```

By contrast, the sibling `ToggleIconButton` (line 61) **does** have `onClick={() => setActive(!active)}` on its button element.

### Electron `<webview>` compositor layer intercepts pointer events

The `<webview>` element renders in a **separate Chromium render process** and is composited on its own layer. At the browser compositor level, the webview's hit-testing region can intercept pointer events (mousedown, click) before they reach the React-rendered DOM tree — even when CSS layout (flex column, fixed header height) indicates no visual overlap between the header and the webview content.

This is a well-documented Electron/Chromium behavior. The native `addEventListener("click", ...)` calls in `useLongClick` attach to the DOM element, but if the compositor routes the pointer event to the webview's render process first, the listener never fires.

### Why only web widget and Help views are affected

Both views are the only ones that render an Electron `<webview>` element:

- **Web widget** — `frontend/app/view/webview/webview.tsx`, renders `<webview>` directly
- **Help view** — `frontend/app/view/helpview/helpview.tsx`, extends `WebViewModel` and renders `<WebView>` via `HelpView`

All other block types (term, preview, waveconfig, tips, etc.) use standard DOM elements and are unaffected.

### Supporting evidence

- **No CSS containment** — The webview and its parent containers (`block-frame-default-inner`, `block-content`) have no `contain`, `isolation`, or `pointer-events` rules that would constrain the webview's hit-testing region
- **No React `onClick` fallback** — With only native listeners, there is no synthetic event path that could bypass the compositor interception
- **`useLongClick` dependency array** — The `useEffect` in `useLongClick` (line 38) depends on `[ref.current, startPress, stopPress, handleClick]` but `handleClick`'s `useCallback` depends on `[longClickTriggered, onClick]`. While `onClick` is in `handleClick`'s deps, the outer `useEffect` does not list `onClick` directly — this means if `onClick` changes without `handleClick` changing (e.g., same function reference, different closure), the listener won't rebind. This is a secondary concern but worth noting.

## Files Involved

| File | Role |
|------|------|
| `frontend/app/element/iconbutton.tsx` | `IconButton` component — missing `onClick` on `<button>` |
| `frontend/app/hook/useLongClick.tsx` | Hook that attaches native event listeners for click/long-click |
| `frontend/app/block/blockframe-header.tsx` | Renders the close button via `HeaderEndIcons` |
| `frontend/app/view/webview/webview.tsx` | Renders the `<webview>` element |
| `frontend/app/view/helpview/helpview.tsx` | Help view — uses `WebViewModel` / `<WebView>` |
| `frontend/app/view/webview/webview.scss` | Webview styles — no containment or pointer-events mitigation |
| `frontend/app/block/block.scss` | Block frame styles — flex column layout, no isolation on inner container |

## Fix Direction

**Primary**: Add `onClick` to the `<button>` element in `IconButton` so there is a React synthetic event path alongside the native listener. React's synthetic event system uses event delegation on the root, which may handle the event differently than direct `addEventListener` calls.

**Alternative**: Apply CSS containment to the webview or its container to constrain its compositor hit-testing region:

```css
.webview {
    contain: strict;
}
```

Or apply `pointer-events: none` to the webview when the header is hovered (requires JS-driven class toggle).

**Long-term**: Consider migrating from `<webview>` tag to `BrowserView`, which offers more control over layering and hit-testing.
