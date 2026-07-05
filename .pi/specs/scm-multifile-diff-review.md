# Multi-File Diff View — Implementation Review

**Date:** 2026-06-29
**Spec:** `.pi/specs/scm-multifile-diff.md`
**Files reviewed:** `review-mode.tsx`, `jump-list.tsx`, `file-diff-section.tsx`, `review-header.tsx`, `sourcecontrol-model.ts`, `sourcecontrol.tsx`, `types.ts`, tests

## Critical Bugs

### 1. `reviewStatsAtom` always reports `+0/-0`

**Files:** `sourcecontrol.tsx:592-594`, `sourcecontrol-model.ts:565-567`, `review-header.tsx:20-24`

Files are created from status with `additions: 0, deletions: 0` hardcoded. No code extracts line counts from fetched diffs and writes them back to `reviewFilesAtom`. The stats bar is permanently broken — it will always display `+0/-0` regardless of actual changes.

**Fix:** After `fetchDiffCached` returns, compute `additions`/`deletions` from `diff.hunks` and update `reviewFilesAtom`.

### 2. `shouldMount` never set to `false` — Monaco instances accumulate

**File:** `file-diff-section.tsx:39-46`

The `IntersectionObserver` callback only calls `setShouldMount(true)`. There is no `else` branch. Once a `FileDiffSection` mounts Monaco, it stays mounted forever. With 20+ files, all 20 Monaco instances accumulate — exactly the performance problem S8 was designed to prevent.

**Fix:** Add the missing `else { setShouldMount(false); }` with a debounce/threshold to avoid flicker on fast scrolling. Also call `editor.getModel()?.dispose()` on unmount (see gap #4).

### 3. `diffCacheAtom` keyed by path only, ignores staging state

**File:** `sourcecontrol-model.ts:513-525`

`fetchDiffCached` accepts `staged` and `untracked` parameters but uses only `path` as the cache key. After a user stages a file:
- The cached diff (showing unstaged changes) is returned as the staged diff
- `FileDiffSection` never re-fetches because the local `diff` state is non-null (`!diff` guard on line 59)
- The UI shows stale diff content

**Fix:** Include `staged`/`untracked` in the cache key (e.g., `"a.ts|unstaged"`). Invalidate or clear cache entries after stage/status updates. Reset local `diff` state in `FileDiffSection` when `file.staged` changes.

## Significant Issues

### 4. Escape key doesn't work from the jump list sidebar

**File:** `review-mode.tsx:57-85`

The keydown listener is attached to `scrollRef` (the right diff panel). The jump list is a sibling element — keydown events from it do not bubble to `scrollRef`. Pressing Escape while focused on the sidebar does nothing.

**Fix:** Attach the keydown handler to the outer container div (which has `tabIndex={0}` on line 88) instead of `scrollRef`.

### 5. `Ctrl+Shift+R` is global, not scoped to SCM widget

**File:** `sourcecontrol.tsx:617-626`

The listener is on `window`, meaning it fires in every tab/page regardless of whether the SCM widget is visible. It also only checks `e.ctrlKey`, not `e.metaKey` (Cmd on macOS). A `Ctrl+Shift+R` typed in a terminal or editor also triggers review mode. The spec says "Anywhere in **SCM**."

**Fix:** Either check that the active widget is SCM, or scope the listener to the SCM container element.

### 6. `updateReviewFilesFromStatus` zeros out change counts

**File:** `sourcecontrol-model.ts:559-575`

Files are reconstructed with `additions: 0, deletions: 0` on every status poll (every 3s). Even after fixing bug #1, this method would overwrite populated counts with zeros.

**Fix:** Preserve `additions`/`deletions` from the existing review files when matching by path.

### 7. `Ctrl+Shift+R` listener re-registers on every status poll

**File:** `sourcecontrol.tsx:617-626`

The `useEffect` depends on `handleReviewAll`, which depends on `status`. Every 3-second status poll creates a new `handleReviewAll` callback, which tears down and re-adds the global `keydown` listener.

**Fix:** Read `status` from the store inside the handler instead of closing over it, or use a stable ref.

### 8. No file-level revert in review mode

**Files:** `file-diff-section.tsx:119-126`, spec S6/S9/S10

The header only has a stage/unstage toggle button. The spec mentions revert actions, a revert button in `FileDiffSection`, and `R` key binding. The only revert path in review mode is per-hunk via `DiffGutter`, which requires a visible diff and Monaco instance.

**Fix:** Add a revert button to the file header and bind the `R` key. Wire to `model.revertHunk` with all hunks or add a new `stageFileFromReview` variant for revert.

## Completeness Gaps

| # | Spec Item | Status |
|---|-----------|--------|
| 1 | S9: `F7` / `Shift+F7` cross-file hunk navigation | Not implemented |
| 2 | S9: `R` key in header to revert file | Not implemented |
| 3 | S8: Monaco `resize()` on mount and collapse toggle | Not implemented |
| 4 | S8: Model disposal on unmount (`editor.getModel()?.dispose()`) | Not implemented |
| 5 | S10: Reduced-opacity overlay (~0.6) after stage | Not implemented |
| 6 | S4: Middle-click file to enter review mode | Not implemented |
| 7 | S4: Cmd/Ctrl+click multi-select → "Review Selected (N)" | Not implemented |

## Test Coverage

33 tests pass (26 model + 7 type). Coverage summary:

- **Covered:** `enterReview`, `exitReview`, `toggleFileCollapse`, `jumpToFile`, `reviewStatsAtom`, `updateReviewFilesFromStatus`, `stageFileFromReview`, `fetchDiffCached`
- **Missing:** Integration/UI tests (keyboard navigation, IntersectionObserver behavior, Monaco lifecycle, scroll position preservation)
- **Masked:** All tests pre-set `additions`/`deletions` values, so the stats bar bug (critical #1) is invisible in tests

## Minor Notes

- `review-mode.scss` (listed in S12) was not created — Tailwind utility classes are used instead (acceptable)
- `diffCacheAtom` is present in the implementation but omitted from the S7 model state list in the spec (acceptable)
- `JumpList` spec prop `onExit` is omitted; exit is handled at the `ReviewMode` level (acceptable)
- `FileDiffSection` spec props `onRevert` and `connection` are replaced by passing the full `model` object (acceptable)
