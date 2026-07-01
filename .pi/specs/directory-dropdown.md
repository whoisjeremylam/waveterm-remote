# Directory Dropdown Component

## Overview

A shared directory navigation dropdown used by both the Files (Preview) and Source Control widgets. Replaces the existing directory dropdown in Files and adds directory navigation to SCM.

## Problem

1. The Files widget has an existing directory dropdown but it's poorly styled
2. The SCM widget has no directory picker — defaults to home directory
3. When SCM opens in a non-git directory, it shows an unfriendly error message
4. No consistent UX for directory navigation across widgets

## Solution

### New DirectoryDropdown Component

A reusable dropdown component that:
- Lists directories from the remote connection (contextual to the connection)
- Single click on a directory = navigate immediately (list updates)
- Click outside = close dropdown, stay on current directory
- Shows `..` to navigate up (hidden at root `/`)
- Does NOT show `.` (current directory)
- Styled to match the connections dropdown

### Styling (match connectiondropdown.scss)

```scss
.directory-dropdown {
    background: var(--modal-bg-color);
    border: 1px solid var(--modal-border-color);
    border-radius: 6px;
    box-shadow: 0px 13px 16px 0px rgba(0, 0, 0, 0.4);
    z-index: var(--zindex-modal-wrapper);
    min-width: 200px;
    max-height: 400px;
    overflow-y: auto;
    padding: 6px;
}

.directory-dropdown-item {
    padding: 6px 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    border-radius: 4px;
    font-size: 11px;

    &:hover {
        background: var(--highlight-bg-color);
    }
}
```

### Component Props

```typescript
type DirectoryDropdownProps = {
    currentPath: string;           // Current directory path
    connection: string;            // Connection name (empty for local)
    onSelect: (path: string) => void;  // Called when directory is navigated
    onClose: () => void;          // Called when dropdown closes
    anchorRef: React.RefObject<HTMLElement>;  // Anchor for positioning
};
```

## Files Widget Changes

### Current State
- Has a directory search/dropdown in `preview-directory.tsx`
- Uses `directorySearchActive` atom to toggle
- Navigation via `model.goHistory(path)`

### Changes
1. Replace existing dropdown with new `DirectoryDropdown` component
2. Keep the same header display (viewText with path)
3. File list refreshes on directory change (already works via `refreshVersion`)

## SCM Widget Changes

### Current State
- No directory picker
- Defaults to home directory or terminal CWD
- Shows raw error message when not in git repo

### Changes

#### 1. Add CWD to Header
Use the standard `viewText` pattern like Files widget:

```typescript
this.viewText = atom((get) => {
    const cwd = get(this.cwd);
    return [
        {
            elemtype: "text",
            text: cwd || "~",
            className: "preview-filename",
            onClick: () => this.toggleDirectoryDropdown(),
        },
    ];
});
```

#### 2. Add Directory Dropdown
- Position in header, triggered by clicking the path
- Uses the shared `DirectoryDropdown` component
- Updates `cwd` atom when directory changes

#### 3. Improved Error State
Replace the current error display with a friendly, centered message:

```typescript
const ErrorState = memo(({ error, onRetry }: { error: string; onRetry: () => void }) => {
    const isNotGitRepo = error.includes("not a git repository");
    
    return (
        <div className="flex flex-col items-center justify-center h-full text-muted text-sm p-8">
            <i className="fa-solid fa-code-branch text-3xl mb-3 opacity-50" />
            {isNotGitRepo ? (
                <>
                    <span className="text-center mb-2">
                        This directory is not a git repository
                    </span>
                    <span className="text-xs text-muted text-center">
                        Select a directory containing a git repository to view source control status
                    </span>
                </>
            ) : (
                <>
                    <span className="text-center mb-2">{error}</span>
                    <button
                        className="px-3 py-1 text-xs bg-surface rounded hover:bg-hoverbg transition-colors mt-2"
                        onClick={onRetry}
                    >
                        Retry
                    </button>
                </>
            )}
        </div>
    );
});
```

## Implementation Plan

### Phase 1: Create Shared Component
1. Create `frontend/app/element/directorydropdown.tsx`
2. Create `frontend/app/element/directorydropdown.scss`
3. Implement directory listing via `FileListStreamCommand`
4. Handle navigation (single click) and close (click outside)

### Phase 2: Update Files Widget
1. Replace existing dropdown in `preview-directory.tsx`
2. Import and use new `DirectoryDropdown`
3. Ensure file list refreshes on directory change

### Phase 3: Update SCM Widget
1. Add `cwd` atom to `sourcecontrol-model.ts`
2. Add `viewText` atom for header display
3. Add directory dropdown toggle
4. Import and use new `DirectoryDropdown`
5. Improve error state component

## Testing

1. **Files Widget**:
   - Open Files widget
   - Click path in header to open dropdown
   - Navigate through directories
   - Verify file list refreshes
   - Click outside to close dropdown

2. **SCM Widget**:
   - Open SCM widget
   - Default to terminal CWD
   - Click path to open dropdown
   - Navigate to a git repository
   - Verify git status loads
   - Navigate to non-git directory
   - Verify friendly error message
   - Click outside to close dropdown

## Files to Create/Modify

### New Files
- `frontend/app/element/directorydropdown.tsx`
- `frontend/app/element/directorydropdown.scss`

### Modified Files
- `frontend/app/view/preview/preview-directory.tsx` (replace dropdown)
- `frontend/app/view/sourcecontrol/sourcecontrol-model.ts` (add cwd, viewText)
- `frontend/app/view/sourcecontrol/sourcecontrol.tsx` (add dropdown, improve error)
