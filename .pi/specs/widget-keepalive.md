# Widget Keep-Alive (State Persistence Across Toggle)

**Date:** 2026-07-08
**Status:** Draft

## Problem

When a user toggles the SCM (source control) or file widget, the widget is fully destroyed and recreated from scratch. Clicking the widget icon again creates a brand-new block with a fresh ViewModel — all state is lost:

- SCM: `viewModeAtom` resets to `side-by-side`, `selectedFileAtom` resets to `null`, `diffCacheAtom` is empty, `commitMessageAtom` is blank, `stagingAtom`/`committingAtom`/`pushingAtom` are false, the poll timer restarts from scratch (showing a loading spinner).
- Preview: `showHiddenFiles`, `directoryDropdownOpen`, `markdownShowToc`, scroll position, `refreshVersion` all reset.

The toggle path in `widgets.tsx:toggleWidgetVisibility()` calls `layoutModel.closeNode(leaf.id)`, which issues a `DeleteNode` tree action and calls `onNodeDelete` → `services.ObjectService.DeleteBlock(data.blockId)` — the block object is deleted server-side. On reopen, `handleWidgetSelect` calls `env.createBlock(blockDef)`, which creates a new block with a fresh block ID. `BlockInner`'s `useEffect` cleanup (`block.tsx:279`) calls `viewModel.dispose()`, and `blockComponentModelMap` drops the model.

### What the user feels

- **Loading flash on every open:** SCM's `loadingAtom` starts `true` and `fetchStatus()` runs on construction. On a slow remote connection, the user sees a blank/spinner for 1-3 seconds before git status appears.
- **Lost diff cache:** Re-selecting a previously-viewed file refetches the diff (another spinner).
- **In-flight operations dropped:** If the user toggles the SCM widget mid-stage or mid-commit, the in-flight RPC completes on the backend but the local `stagingAtom`/`committingAtom` resets to false. The UI shows "not staging" while git state is mid-transition — a correctness issue, not just a speed issue.
- **Lost view state:** Side-by-side vs inline diff mode, expanded/collapsed file sections, filter text, commit message draft — all gone.

### Current toggle path

```
widgets.tsx:handleWidgetSelect(widget)
  │
  ├─ if TOGGLE_WIDGETS includes viewType:
  │    └─ toggleWidgetVisibility(viewType)
  │         └─ layoutModel.closeNode(leaf.id)
  │              └─ DeleteNode tree action
  │                   └─ onNodeDelete → ObjectService.DeleteBlock(blockId)
  │                        └─ block deleted server-side
  │
  ├─ BlockInner useEffect cleanup:
  │    └─ unregisterBlockComponentModel(blockId)
  │    └─ viewModel.dispose()
  │         └─ SCM: stopPolling(), selectedFileUnsub()
  │
  └─ (on reopen) createBlock(blockDef) → new blockId → new ViewModel → fresh state
```

`TOGGLE_WIDGETS = ["preview", "sourcecontrol", "sysinfo", "processviewer"]` (`widgets.tsx:61`)

## Solution

Replace the destroy-and-recreate toggle with a **hide-and-keep-alive** toggle for `TOGGLE_WIDGETS`. When toggling a widget closed:

1. **Do not delete the block** — remove it from the layout tree but keep the block object and ViewModel alive in a registry.
2. **Call `viewModel.onHide()`** (new lifecycle method) — the ViewModel pauses/reduces its poll interval.
3. **Keep the ViewModel in memory** — `blockComponentModelMap` retains it keyed by block ID.

When toggling the widget open again:

1. **Find the existing hidden block** — if a hidden block of the same view type exists for the same connection, reuse it.
2. **Re-insert it into the layout** — add the layout node back.
3. **Call `viewModel.onShow()`** (new lifecycle method) — the ViewModel triggers an immediate refresh (to catch up on any changes while hidden) and restores the fast poll interval.

### Poll backoff while hidden

- SCM: `pollInterval` changes from `3000ms` (active) to `30000ms` (hidden)
- On `onShow()`: trigger immediate `fetchStatus()`, restore `pollInterval` to `3000ms`
- Preview: no polling (fetch-on-demand), so `onHide()`/`onShow()` only manage lifecycle state

### Refresh on show

When `onShow()` is called, the ViewModel must trigger an immediate refresh to catch up on changes that occurred while hidden. For SCM, this means calling `fetchStatus()` and `fetchDiffForSelected()`. For Preview, this means incrementing `refreshVersion` to trigger a re-fetch of the current file.

## Scope

- **In scope:** SCM widget (`sourcecontrol`), Preview/file widget (`preview`), sysinfo, processviewer
- **Out of scope:** Terminal blocks, web blocks, launcher, waveconfig, help, tips — these are not in `TOGGLE_WIDGETS` or have no meaningful state to persist

## Current Architecture

### SCM ViewModel lifecycle

```
SourceControlViewModel constructor (sourcecontrol-model.ts:56)
  ├─ Creates fresh atoms: statusAtom, selectedFileAtom, viewModeAtom, diffAtom,
  │  diffCacheAtom, commitMessageAtom, stagingAtom, etc.
  ├─ Starts polling: setTimeout(() => this.startPolling(), 0)
  │    └─ pollInterval = 3000ms
  └─ Subscribes to selectedFileAtom

SourceControlViewModel.dispose() (sourcecontrol-model.ts:647)
  ├─ this.disposed = true
  ├─ this.stopPolling()
  └─ this.selectedFileUnsub()
```

### Block lifecycle

```
BlockInner (block.tsx:268)
  ├─ makeViewModel(blockId, viewType, ...) → new SourceControlViewModel(...)
  ├─ registerBlockComponentModel(blockId, { viewModel })
  └─ useEffect cleanup:
       ├─ unregisterBlockComponentModel(blockId)
       └─ viewModel.dispose()
```

### Toggle

```
widgets.tsx:toggleWidgetVisibility(viewType)
  └─ layoutModel.closeNode(leaf.id)
       └─ DeleteNode → onNodeDelete → DeleteBlock
```

### CWD resolution (relevant for SCM/Preview)

```
SourceControlViewModel.terminalCwd (sourcecontrol-model.ts:128)
  ├─ Priority 1: block meta cmd:cwd (if not blank)
  ├─ Priority 2: getFocusedTerminalCwd() (focus history walk)
  └─ Fallback: "~"

SourceControlViewModel.cwd (sourcecontrol-model.ts:142)
  ├─ Priority 1: userCwdAtom (manual navigation via directory dropdown)
  ├─ Priority 2: terminalCwd (see above)
  └─ Fallback: "~"
```

## Changes

### 1. ViewModel interface — add `onHide()` / `onShow()`

**File:** `frontend/types/custom.d.ts` (ViewModel interface, line 296)

```typescript
interface ViewModel {
    // ... existing fields ...

    // Called when the block is hidden (toggled closed but kept alive).
    // The ViewModel should reduce polling frequency and release transient resources.
    onHide?: () => void;

    // Called when a hidden block is shown again (toggled open).
    // The ViewModel should trigger an immediate refresh and restore active polling.
    onShow?: () => void;

    // ... existing dispose() stays for final teardown ...
}
```

### 2. Hidden block registry

**File:** `frontend/app/store/global.ts`

Add a `hiddenBlockModels` map alongside the existing `blockComponentModelMap`:

```typescript
// Blocks that are hidden (toggled closed) but kept alive.
// Keyed by a composite key: viewType + ":" + connection.
// This allows reusing the hidden block when the user toggles the same widget type
// for the same connection.
const hiddenBlockModels = new Map<string, BlockComponentModel>();

function getHiddenBlockKey(viewType: string, connection: string | undefined): string {
    return `${viewType}:${connection ?? "local"}`;
}

function hideBlockModel(viewType: string, connection: string | undefined, bcm: BlockComponentModel) {
    hiddenBlockModels.set(getHiddenBlockKey(viewType, connection), bcm);
}

function getHiddenBlockModel(viewType: string, connection: string | undefined): BlockComponentModel | undefined {
    return hiddenBlockModels.get(getHiddenBlockKey(viewType, connection));
}

function removeHiddenBlockModel(viewType: string, connection: string | undefined) {
    hiddenBlockModels.delete(getHiddenBlockKey(viewType, connection));
}
```

### 3. Toggle logic — hide instead of close

**File:** `frontend/app/workspace/widgets.tsx`

Replace `toggleWidgetVisibility`:

```typescript
async function toggleWidgetVisibility(viewType: string): Promise<boolean> {
    const layoutModel = getLayoutModelForStaticTab();
    if (!layoutModel) return false;
    const leafs = globalStore.get(layoutModel.leafs);
    if (!leafs) return false;
    for (const leaf of leafs) {
        const blockId = leaf.data?.blockId;
        if (!blockId) continue;
        const blockData = globalStore.get(
            WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId))
        );
        if (blockData?.meta?.view === viewType) {
            // Get the ViewModel before removing from layout
            const bcm = getBlockComponentModel(blockId);
            const viewModel = bcm?.viewModel;
            const connection = blockData?.meta?.connection;

            // Call onHide on the ViewModel
            viewModel?.onHide?.();

            // Remove from layout tree but do NOT delete the block
            // Use a new HideNode action that removes the node but preserves the block
            layoutModel.hideNode(leaf.id);

            // Stash the ViewModel in the hidden registry
            if (viewModel) {
                hideBlockModel(viewType, connection, { viewModel });
            }
            return true;
        }
    }
    return false;
}
```

Modify `handleWidgetSelect` to check for a hidden block before creating a new one:

```typescript
async function handleWidgetSelect(widget: WidgetConfigType, env: WidgetsEnv) {
    const viewType = widget.blockdef?.meta?.view;
    if (TOGGLE_WIDGETS.includes(viewType)) {
        // First try: if a hidden block exists for this view type + connection, reuse it
        const focusedConn = getFocusedTerminalConnection();
        const hiddenBcm = getHiddenBlockModel(viewType, focusedConn);
        if (hiddenBcm?.viewModel) {
            // Re-insert the hidden block into the layout
            // Need the block ID from the hidden model's block
            const blockId = hiddenBcm.viewModel.blockId;
            removeHiddenBlockModel(viewType, focusedConn);
            // Re-insert into layout (new layout node pointing to existing blockId)
            layoutModel.insertExistingNode(blockId, { focused: true });
            hiddenBcm.viewModel.onShow?.();
            return;
        }
        // If no hidden block, check if one is visible (toggle close)
        if (await toggleWidgetVisibility(viewType)) {
            return;
        }
    }
    // No existing or hidden block — create a new one
    const blockDef = { ...widget.blockdef };
    if (!blockDef.meta?.connection) {
        if (focusedConn) {
            blockDef.meta = { ...blockDef.meta, connection: focusedConn };
        }
    }
    env.createBlock(blockDef, widget.magnified);
}
```

### 4. LayoutModel — `hideNode` and `insertExistingNode`

**File:** `frontend/layout/lib/layoutModel.ts`

Add `hideNode` — removes a node from the layout tree without triggering `onNodeDelete` (which would call `DeleteBlock`):

```typescript
async hideNode(nodeId: string) {
    const nodeToDelete = findNode(this.treeState.rootNode, nodeId);
    if (!nodeToDelete) {
        console.error("unable to hide node, cannot find it in tree", nodeId);
        return;
    }
    // If this is the magnified node, unmagnify first
    if (nodeId === this.magnifiedNodeId) {
        this.magnifyNodeToggle(nodeId);
    }
    // Remove from tree WITHOUT calling onNodeDelete
    const deleteAction: LayoutTreeActionType.DeleteNode = {
        type: LayoutTreeActionType.DeleteNode,
        nodeId: nodeId,
    };
    this.treeReducer(deleteAction);
    // Do NOT call this.onNodeDelete — that's the key difference from closeNode
    this.persistToBackend();
}
```

Add `insertExistingNode` — inserts an existing block (by blockId) into the layout as a new leaf:

```typescript
insertExistingNode(blockId: string, opts?: { focused?: boolean }) {
    const insertNodeAction: LayoutTreeInsertNodeAction = {
        type: LayoutTreeActionType.InsertNode,
        node: newLayoutNode(undefined, undefined, undefined, { blockId }),
        focused: opts?.focused ?? true,
    };
    this.treeReducer(insertNodeAction);
}
```

### 5. BlockInner — do not dispose when block is hidden

**File:** `frontend/app/block/block.tsx`

The current `BlockInner` useEffect cleanup disposes the ViewModel when the component unmounts. With keep-alive, the component unmounts (removed from layout) but the ViewModel must survive. The hidden block registry holds a reference to the ViewModel, but `BlockInner`'s cleanup will still fire.

The fix: `BlockInner` should check if the block is being hidden (vs. truly deleted) before disposing. Since `hideNode` does NOT call `DeleteBlock`, the block object still exists in the store. The cleanup should only dispose if the block object is actually gone:

```typescript
// BlockInner useEffect cleanup (block.tsx:278)
useEffect(() => {
    return () => {
        // Check if the block was truly deleted (vs. just hidden)
        const blockData = globalStore.get(
            WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", props.nodeModel.blockId))
        );
        if (blockData == null) {
            // Block was deleted — dispose the ViewModel
            unregisterBlockComponentModel(props.nodeModel.blockId);
            viewModel?.dispose?.();
        }
        // If blockData still exists, the block was hidden, not deleted.
        // The ViewModel is stashed in hiddenBlockModels and should survive.
    };
}, []);
```

### 6. SourceControlViewModel — implement `onHide()` / `onShow()`

**File:** `frontend/app/view/sourcecontrol/sourcecontrol-model.ts`

```typescript
onHide() {
    // Reduce poll interval to 30s while hidden
    this.stopPolling();
    this.pollInterval = 30000;
    this.startPolling();
}

onShow() {
    // Restore fast polling and trigger immediate refresh
    this.stopPolling();
    this.pollInterval = 3000;
    this.startPolling(); // startPolling calls fetchStatus() immediately
}
```

`startPolling()` already calls `fetchStatus()` on invocation, so `onShow()` triggers an immediate refresh + restores the 3s poll. ✅

### 7. PreviewModel — implement `onHide()` / `onShow()`

**File:** `frontend/app/view/preview/preview-model.tsx`

PreviewModel has no polling, but `onShow()` should trigger a refresh:

```typescript
onShow() {
    // Trigger re-fetch of current file/directory
    globalStore.set(this.refreshVersion, globalStore.get(this.refreshVersion) + 1);
}

onHide() {
    // No polling to pause; nothing to do
}
```

### 8. Block disposal — clean up hidden registry

**File:** `frontend/app/store/global.ts`

When a block is truly deleted (not hidden), remove it from the hidden registry:

```typescript
// In unregisterBlockComponentModel or a new cleanup function:
function cleanupHiddenBlock(blockId: string, viewType: string, connection: string | undefined) {
    // If the block was in the hidden registry, remove it
    removeHiddenBlockModel(viewType, connection);
}
```

This should be called from the `onNodeDelete` path (the real `DeleteBlock` path), not from `hideNode`.

## CWD Interaction

The keep-alive design interacts with the tmux cwd fix (see `.pi/specs/tmux-cwd-tracking.md`):

- **On `onShow()`:** The SCM ViewModel's `terminalCwd` atom re-reads `cmd:cwd` from the block meta. If the user `cd`'d while the widget was hidden (and the shell integration pushed the new cwd via `wsh setmeta`), the atom picks up the new value automatically — no special handling needed.
- **Manual navigation override:** If the user manually navigated the SCM directory dropdown before hiding, `userCwdAtom` is set and persists across hide/show (ViewModel is kept alive). On `onShow()`, the SCM widget shows the manually-navigated directory, not the terminal cwd. This is the correct behavior — manual navigation wins, as designed in the existing `this.cwd` atom priority chain.
- **On `onShow()` refresh:** `startPolling()` calls `fetchStatus()`, which reads `this.cwd` (which checks `userCwdAtom` first, then `terminalCwd`). If the user `cd`'d in the terminal while the widget was hidden, and did NOT manually navigate the widget, the SCM widget refreshes git status for the new cwd. ✅

## Files to Modify

| File | Change |
|------|--------|
| `frontend/types/custom.d.ts` | Add `onHide()` / `onShow()` to ViewModel interface |
| `frontend/app/store/global.ts` | Add `hiddenBlockModels` registry, `hideBlockModel`/`getHiddenBlockModel`/`removeHiddenBlockModel` helpers |
| `frontend/app/workspace/widgets.tsx` | Replace `toggleWidgetVisibility` with hide/show logic; modify `handleWidgetSelect` to reuse hidden blocks |
| `frontend/layout/lib/layoutModel.ts` | Add `hideNode()` (remove from tree without `onNodeDelete`) and `insertExistingNode()` (re-insert existing block) |
| `frontend/app/block/block.tsx` | Modify `BlockInner` useEffect cleanup to check if block was deleted vs. hidden before disposing |
| `frontend/app/view/sourcecontrol/sourcecontrol-model.ts` | Implement `onHide()` / `onShow()` with poll backoff |
| `frontend/app/view/preview/preview-model.tsx` | Implement `onHide()` / `onShow()` with refresh trigger |

## Test Cases

### SCM widget keep-alive

1. **Toggle preserves view mode:**
   - Open SCM widget, switch to inline diff mode
   - Toggle closed (click widget icon)
   - Toggle open (click widget icon)
   - **Expected:** Widget opens in inline diff mode (not reset to side-by-side)

2. **Toggle preserves selected file:**
   - Open SCM widget, select a file in the file list
   - Toggle closed, toggle open
   - **Expected:** Same file is selected, diff is displayed (from diff cache, no spinner)

3. **Toggle preserves commit message:**
   - Open SCM widget, type a commit message (don't commit)
   - Toggle closed, toggle open
   - **Expected:** Commit message text is preserved

4. **Toggle refreshes on show:**
   - Open SCM widget (git status loads)
   - Toggle closed
   - In the terminal, `touch new_file.txt` (create an untracked file)
   - Toggle open
   - **Expected:** Widget immediately fetches status (loading is brief or instant), new file appears in untracked section

5. **In-flight stage survives toggle:**
   - Open SCM widget, stage a file (staging in progress)
   - Toggle closed while staging is in flight
   - Toggle open
   - **Expected:** `stagingAtom` still shows staging in progress (not reset to false); when the RPC completes, staging completes normally

6. **CWD follows terminal while hidden:**
   - Open SCM widget in `/repoA`
   - Toggle closed
   - In terminal, `cd /repoB`
   - Toggle open
   - **Expected:** SCM widget shows git status for `/repoB` (assuming no manual navigation override was set)

7. **Manual navigation persists:**
   - Open SCM widget in `/repoA`
   - Use directory dropdown to navigate to `/repoC` (sets `userCwdAtom`)
   - Toggle closed
   - In terminal, `cd /repoB`
   - Toggle open
   - **Expected:** SCM widget shows git status for `/repoC` (manual navigation wins over terminal cwd)

8. **Poll backoff while hidden:**
   - Open SCM widget
   - Toggle closed
   - Wait 35 seconds
   - Check network activity / git RPC calls
   - **Expected:** Only ~1 git status poll during the 35s window (30s interval), not ~12 (3s interval)

### Preview/file widget keep-alive

9. **Toggle preserves directory navigation:**
   - Open file widget, navigate to `/etc`
   - Toggle closed, toggle open
   - **Expected:** File widget shows `/etc` directory listing

10. **Toggle preserves show-hidden-files:**
    - Open file widget, toggle "show hidden files" on
    - Toggle closed, toggle open
    - **Expected:** Hidden files are still shown

### Edge cases

11. **Multiple SCM widgets for different connections:**
    - Open SCM widget for connection A
    - Open SCM widget for connection B (in a split)
    - Toggle connection A's SCM closed
    - Toggle connection A's SCM open
    - **Expected:** Connection A's SCM widget is reused (not connection B's)

12. **True block deletion still works:**
    - Open SCM widget
    - Close it via the block header X button (not the widget toggle)
    - **Expected:** Block is fully deleted, ViewModel is disposed, `DeleteBlock` is called

13. **Tab switch while hidden:**
    - Open SCM widget in tab 1
    - Toggle closed (hidden)
    - Switch to tab 2
    - **Expected:** Hidden SCM block is still alive in the registry (not GC'd); toggling SCM in tab 2 creates a new block (different tab, different focused connection)

## Out of Scope (Future)

- **Hidden block GC:** If a user hides a widget and never reopens it, the hidden block's ViewModel keeps polling at 30s indefinitely. A future enhancement could GC hidden blocks after a timeout (e.g., 5 minutes). For now, the 30s poll is cheap enough.
- **Multiple hidden blocks per view type:** The current design keys hidden blocks by `viewType + connection`. If a user hides SCM for connection A, then hides SCM for connection B, only the last one is preserved. This is an acceptable limitation for the initial implementation.
- **OSC 16142 command markers under tmux:** See `.pi/specs/tmux-cwd-tracking.md` out-of-scope section.