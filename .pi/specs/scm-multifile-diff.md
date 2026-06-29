# Multi-File Diff View (Review Mode) Specification

**Date:** 2026-06-28
**Status:** Ready
**Branch:** `feature/source-control-widget`
**Depends on:** SCM widget MVP (already done — file list, staged/unstaged, single-file diff, stage/unstage hunks, commit, push)

## [S1] Problem

The SCM widget currently only shows one file's diff at a time. For reviewing changes made by AI agents, the user must click each file individually, wait for the diff to load, review it, click the next file, repeat. With 10+ changed files this is slow and breaks the review flow. The user needs to scan ALL changes across ALL files in one continuous scrollable view, with quick per-file stage/revert actions.

## [S2] Solution Overview

Add a **Review Mode** to the SCM widget that renders all changed files in a single vertically-scrollable diff panel. A narrow file jump-list sidebar replaces the full file tree. The existing single-file view becomes "Single Mode" — the widget toggles between them.

```
┌─ Review: 3 files (+47/-12) ────────────── [Exit Review] ──┐
│ ┌─ Files ───┐ ┌─ Diff ───────────────────────────────────┐ │
│ │           │ │                                           │ │
│ │ ● src/a.ts│ │  ── src/a.ts ───────────────── [Stage ▸]  │ │
│ │   M +12/-3│ │  ┌────────────────────────────────────┐  │ │
│ │           │ │  │  1  import { foo } from "./old";    │  │ │
│ │ ○ src/b.ts│ │  │  2  + import { bar } from "./new";  │  │ │
│ │   A +47   │ │  │  3    const x = 42;                │  │ │
│ │           │ │  │  4  - const y = 99;                │  │ │
│ │ ○ README  │ │  │  5    export { x, bar };           │  │ │
│ │   M +5/-0 │ │  └────────────────────────────────────┘  │ │
│ │           │ │                                           │ │
│ │           │ │  ── src/b.ts ───────────────── [Stage ▸]  │ │
│ │           │ │  ┌────────────────────────────────────┐  │ │
│ │           │ │  │  1  + export function agent() {};   │  │ │
│ │           │ │  │  2  + export function review() {};  │  │ │
│ │           │ │  │  ...                                │  │ │
│ │           │ │  └────────────────────────────────────┘  │ │
│ │           │ │                                           │ │
│ │           │ │  ── README.md ────────────── [Stage ▸]    │ │
│ │           │ │  ┌────────────────────────────────────┐  │ │
│ │           │ │  │  (markdown preview with diff)       │  │ │
│ │           │ │  └────────────────────────────────────┘  │ │
│ └───────────┘ └──────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

The key UX insight: **one continuous scroll**, not tabs. Scroll through all file diffs without lifting a finger.

## [S3] Mode Architecture

The SCM widget gains two layout modes, controlled by a new `reviewModeAtom: PrimitiveAtom<boolean>`:

| Mode | Layout | When |
|------|--------|------|
| **Single** (current) | File tree left, diff panel right | Default. Clicking one file |
| **Review** | Jump list left (~200px), unified diff scroll right | "Review All" button, middle-click file, Cmd/Ctrl+click selection |

Toggling modes preserves file selection and scroll position where possible.

## [S4] Entry Points

| Trigger | Behavior |
|---------|----------|
| **"Review All" button** in SCM header | Enter review mode with all changed files (staged + unstaged + untracked) |
| **"Review Staged" button** | Review mode with staged files only |
| **"Review Unstaged" button** | Review mode with unstaged files only |
| **Middle-click** a file in the tree | Enter review mode with only that file (quick expand) |
| **Cmd/Ctrl+click** N files → contextual "Review Selected (N)" button | Review mode with selected files |
| **Click a commit** (future P5) | Review mode with all files in that commit |
| **Keyboard: `Ctrl+Shift+R`** | Review all changes |

When entering review mode:
1. `reviewModeAtom` → `true`
2. `reviewFilesAtom` ← array of `GitFileChange` to display
3. Diff panel switches from single `MonacoDiffViewer` to scrollable list of `MonacoDiffViewer` instances (one per file)

## [S5] Component Tree

```
SourceControlView (sourcecontrol.tsx)
├─ SCM Header (branch, pull/push, "Review All" button)
├─ [reviewModeAtom = false] Single Mode Layout (current)
│   ├─ FileTree (left panel)
│   └─ DiffPanel (right panel)
│       └─ MonacoDiffViewer (single file)
│
└─ [reviewModeAtom = true] Review Mode Layout (new)
    ├─ JumpList (narrow left panel, ~200px)
    │   └─ JumpListItem (per file, with status badge + change count)
    └─ UnifiedDiffScroll (right panel, scrollable)
        └─ FileDiffSection (per file, collapsible)
            ├─ FileDiffHeader (file path, status badge, [Stage] [Revert] [Collapse])
            └─ MonacoDiffViewer (with DiffGutter for per-hunk actions)
```

## [S6] New Components

### JumpList (`jump-list.tsx`)

Props:
- `files: GitFileChange[]` — all files in review
- `activeIndex: number` — currently-visible file index (tracked via IntersectionObserver)
- `onJump: (index: number) => void` — scroll to file section
- `onExit: () => void` — exit review mode

Each item shows:
- Status badge (M/A/D/? icon + color)
- File path (truncated to fit 200px)
- Change summary (e.g. "+12/-3")
- Highlight if current scrolling position is on this file

### FileDiffSection (`file-diff-section.tsx`)

Props:
- `file: GitFileChange`
- `isCollapsed: boolean` — initial state
- `onToggleCollapse: () => void`
- `onStage: () => void`
- `onRevert: () => void`
- `diffContent: GitDiffResponse | null` — fetched async
- `connection: string`

Renders:
- Collapsible header bar with file path, status badge, action buttons
- When expanded: `MonacoDiffViewer` + `DiffGutter` (reuse existing)
- When collapsed: one-line summary "── src/a.ts (M, +12/-3) ── [expand] ──"

**Collapse behavior:** Click header bar or press `Space` when focused. Collapsed state is per-file, tracked in a `Map<string, boolean>` atom.

**Lazy loading:** Only fetch + mount `MonacoDiffViewer` when the file section is expanded AND visible (IntersectionObserver). Files off-screen never mount Monaco. This matters for performance with 20+ files.

### ReviewHeader (`review-header.tsx`)

Props:
- `fileCount: number`
- `totalAdditions: number`
- `totalDeletions: number`
- `onExit: () => void`

Shows: "Review: 3 files (+47/-12)" with an [Exit Review] button. Computed from summing all file change counts.

## [S7] New Model State

Add to `SourceControlViewModel` (`sourcecontrol-model.ts`):

```typescript
// Review mode state
reviewModeAtom: PrimitiveAtom<boolean>;
reviewFilesAtom: PrimitiveAtom<GitFileChange[]>;
reviewActiveIndexAtom: PrimitiveAtom<number>;       // Which file section is currently in view
reviewCollapsedAtom: PrimitiveAtom<Map<string, boolean>>;  // Per-file collapse state (keyed by path)

// For intersection observer tracking
reviewFileRefsAtom: PrimitiveAtom<Map<string, HTMLDivElement>>;

// Computed: total additions/deletions across all review files
reviewStatsAtom: Atom<{ additions: number; deletions: number }>;
```

Lifecycle:
- `enterReview(files: GitFileChange[])` — sets `reviewModeAtom = true`, populates `reviewFilesAtom`, resets collapse state
- `exitReview()` — sets `reviewModeAtom = false`, disposes all review-mode Monaco instances, re-renders single mode
- `toggleFileCollapse(path: string)` — toggles entry in `reviewCollapsedAtom`
- `jumpToFile(index: number)` — scrolls the diff panel to that file's section header
- On file stage/revert: update the file's status in `reviewFilesAtom`, keep scroll position

## [S8] Monaco Instance Management

**Problem:** Each file section needs its own `MonacoDiffViewer`. With 20 files, that's 20 Monaco instances — heavy. We must lazy-mount and dispose correctly.

**Strategy:**

1. **Lazy mount via IntersectionObserver:** When a file section enters the viewport, create its `MonacoDiffViewer`. When it exits the viewport (with a 200px buffer), unmount it. This keeps 2-4 active Monaco instances at any time, regardless of total file count.

2. **Diff content caching:** Once a diff is fetched for a file, cache it in a `Map<string, GitDiffResponse>` atom so remounting (from collapse/expand or scroll away-and-back) doesn't re-fetch.

3. **Model disposal:** When a Monaco instance unmounts, dispose its model via `editor.getModel()?.dispose()` to prevent memory leaks. This is already done in the single-file view (`sourcecontrol.tsx:33dbbf0e`).

4. **Container sizing:** Each `MonacoDiffViewer` auto-sizes to fit its diff content (no fixed height). The container uses `resize()` on mount and when collapse state changes.

```typescript
// In FileDiffSection:
const [shouldMount, setShouldMount] = useState(isInitiallyVisible);
const containerRef = useRef<HTMLDivElement>(null);

useEffect(() => {
    const observer = new IntersectionObserver(
        ([entry]) => {
            if (entry.isIntersecting) {
                setShouldMount(true);
            } else {
                // Delay unmount by 200px scroll distance to avoid flicker
                // on fast scrolling
            }
        },
        { rootMargin: "200px 0px 200px 0px" }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
}, []);
```

## [S9] Keyboard Navigation

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+Shift+R` | Anywhere in SCM | Enter review mode (all files) |
| `Escape` | Review mode | Exit review mode |
| `Alt+↓` | Review mode | Jump to next file section (scroll to next header) |
| `Alt+↑` | Review mode | Jump to previous file section |
| `F7` | Review mode, Monaco focused | Next diff hunk (within current file or cross to next file) |
| `Shift+F7` | Review mode, Monaco focused | Previous diff hunk |
| `Space` | Review mode, file header focused | Toggle collapse/expand |
| `S` | Review mode, file header focused | Stage current file |
| `R` | Review mode, file header focused | Revert current file |

Implementation:
- `Alt+↑/↓` — global keydown handler on the review container. Find current visible file section, compute next, scroll to it.
- `F7` / `Shift+F7` — if the current Monaco instance has no more hunks, advance to the next/previous file section's first Monaco instance and run `GoToNextChange` there.

## [S10] Stage/Revert from Review Mode

When the user stages or reverts a file from within review mode:

1. **Optimistic update:** Immediately change the file's status in `reviewFilesAtom` (e.g., unstaged M → staged M)
2. **Visual feedback:** 
   - The file header button flips (Stage → Unstage / Revert → disabled)
   - The diff content gets a reduced-opacity overlay (~0.6) to indicate "done"
   - The jump list item updates its badge
3. **RPC call:** Fire the actual git stage/revert RPC in the background
4. **On failure:** Revert the optimistic update, show error toast
5. **Scroll position preserved:** The user stays at the same scroll position, can continue reviewing

```typescript
async stageFile(path: string) {
    // Optimistic update
    const prevFiles = store.get(this.reviewFilesAtom);
    store.set(this.reviewFilesAtom, prevFiles.map(f => 
        f.path === path ? { ...f, staged: true } : f
    ));
    
    try {
        await GitStageCommand(...);
    } catch (e) {
        // Rollback
        store.set(this.reviewFilesAtom, prevFiles);
        showErrorToast("Failed to stage " + path);
    }
}
```

## [S11] "Review All" Button Placement

Add a button bar in the SCM widget header (above the commit input / below the branch display):

```
┌─ SCM Header ────────────────────────────────────────────┐
│  main                                              ↓2 ↑1 │
│  [Review All]  [Review Staged]  [Review Unstaged]        │
│  ─────────────────────────────────────────────────────── │
│  Commit message...                            [Commit]   │
└─────────────────────────────────────────────────────────┘
```

Or, using a compact dropdown:
```
│  [▾ Review (3)]     ← dropdown: Review All / Review Staged / Review Unstaged
```

Choose the compact dropdown to save header space.

## [S12] Files to Create / Modify

### New Files

| File | Purpose |
|------|---------|
| `frontend/app/view/sourcecontrol/review-mode.tsx` | Review mode layout container: JumpList + UnifiedDiffScroll |
| `frontend/app/view/sourcecontrol/jump-list.tsx` | Narrow file jump list sidebar |
| `frontend/app/view/sourcecontrol/file-diff-section.tsx` | Single file section with Monaco diff, collapsible header, lazy load |
| `frontend/app/view/sourcecontrol/review-header.tsx` | Review stats bar ("3 files, +47/-12") |
| `frontend/app/view/sourcecontrol/review-mode.scss` | Styles for review mode layout, jump list, file sections |

### Modified Files

| File | Changes |
|------|---------|
| `frontend/app/view/sourcecontrol/sourcecontrol-model.ts` | Add review mode atoms (`reviewModeAtom`, `reviewFilesAtom`, etc.), `enterReview()`, `exitReview()`, keyboard handler |
| `frontend/app/view/sourcecontrol/sourcecontrol.tsx` | Add mode toggle in render: `reviewMode ? <ReviewMode /> : <CurrentLayout />`. Add "Review All" button to header. Wire `Ctrl+Shift+R` |
| `frontend/app/view/sourcecontrol/types.ts` | Add `ReviewModeState` interface if needed |

## [S13] Implementation Order

1. **Model layer** — Add review mode atoms, `enterReview()`, `exitReview()` to `sourcecontrol-model.ts`. Wire `Ctrl+Shift+R` global handler.
2. **Review mode container** — `review-mode.tsx` with basic layout (left sidebar + right scroll area). No Monaco yet, just mock sections.
3. **Jump list** — `jump-list.tsx` with scroll-to-file navigation. Wire IntersectionObserver for active index.
4. **File diff sections** — `file-diff-section.tsx` with collapsible header, lazy Monaco mount, diff caching.
5. **Stage/revert from review** — Optimistic updates, visual feedback, RPC calls.
6. **Keyboard navigation** — `Alt+↑/↓`, cross-file `F7`/`Shift+F7`.
7. **Review All button** — Header dropdown, `Ctrl+Shift+R` shortcut.
8. **Styling** — `review-mode.scss`, polish.

## [S14] Testing

1. Enter review mode with 5 files — all render in scrollable panel
2. Scroll through files — only 2-3 Monaco instances active at once (via console log)
3. Collapse a file section — Monaco unmounts, one-line summary shows
4. Expand a collapsed section — Monaco remounts from cached diff, no re-fetch
5. Stage a file from review mode — status updates, overlay applied, scroll preserved
6. Revert a file from review mode — diff restored, status reverted
7. Click jump list item — scrolls to correct file section
8. `Escape` exits review mode — returns to single mode with file tree
9. `Alt+↓` jumps to next file section
10. `F7` crosses file boundary when current file has no more hunks
11. Review mode with only 1 file — works the same (no degenerate layout)
12. Enter review mode, then `git status` changes externally — polling picks up, review list updates

## [S15] Out of Scope (This Spec)

- Multi-file diff for commits (P5 — requires `git/log` RPC first)
- "Review Selected" from Cmd/Ctrl+click (requires multi-select in file tree, separate feature)
- Markdown rendered preview + inline diff (separate spec, depends on P2)
- File preview mode [Diff | Preview] toggle (separate spec, P2)
- Committed changes review (separate spec, P5)
