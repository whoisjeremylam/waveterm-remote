# Source Control Widget Specification

**Date:** 2026-06-19
**Status:** Draft
**Branch:** `feature/source-control-widget`

## [S1] Problem

Waveterm-remote lacks a visual interface for version control. Users must use the terminal for all git operations. VSCode's source control panel provides a rich UI for viewing changes, but its implementation is deeply coupled to VSCode's DI/service architecture and cannot be lifted directly.

## [S2] Solution Overview

Build a native source control widget for waveterm that provides:
- Visual file list with status indicators (M/A/D/R/U)
- Staged vs Unstaged sections
- Side-by-side and inline diff viewing via Monaco
- Git operations executed on the remote machine via wsh RPC

**Architecture:**
```
Frontend (React)          Backend (Go)
┌─────────────────┐      ┌─────────────────┐
│ SourceControlView│──────│ git/status      │
│ FileTree (arborist)│     │ git/diff        │
│ DiffViewer (Monaco)│     │ git commands    │
└─────────────────┘      └─────────────────┘
```

## [S3] Backend Design

### New Package: `pkg/git/`

**File:** `pkg/git/git.go`

#### Types

```go
// GitStatusResponse represents the working tree status
type GitStatusResponse struct {
    Branch    string          `json:"branch"`
    Staged    []GitFileChange `json:"staged"`
    Unstaged  []GitFileChange `json:"unstaged"`
    Untracked []GitFileChange `json:"untracked"`
}

// GitFileChange represents a single file change
type GitFileChange struct {
    Path    string `json:"path"`
    Status  string `json:"status"`  // M, A, D, R, C, U
    OldPath string `json:"oldPath"` // for renames
    Icon    string `json:"icon"`    // font-awesome icon
    Color   string `json:"color"`   // CSS color
}

// GitDiffResponse contains the diff for a file
type GitDiffResponse struct {
    Original string `json:"original"`
    Modified string `json:"modified"`
    Language string `json:"language"` // detected from extension
}
```

#### RPC Commands

| Command | Description | Git Command |
|---------|-------------|-------------|
| `git/status` | Get working tree status | `git status --porcelain=v2` |
| `git/diff` | Get diff for a file (staged) | `git diff --cached -- <file>` |
| `git/diff-unstaged` | Get diff for a file (unstaged) | `git diff -- <file>` |
| `git/branch` | Get current branch | `git branch --show-current` |

#### Status Mapping

| Git Status Code | Status | Icon | Color |
|-----------------|--------|------|-------|
| `M` (modified) | Modified | `fa-file-pen` | `#f0a30a` |
| `A` (added) | Added | `fa-file-circle-plus` | `#73c991` |
| `D` (deleted) | Deleted | `fa-file-circle-minus` | `#f14c4c` |
| `R` (renamed) | Renamed | `fa-file-circle-arrow-right` | `#73c991` |
| `C` (copied) | Copied | `fa-file-circle-check` | `#73c991` |
| `?` (untracked) | Untracked | `fa-file-circle-question` | `#73c991` |

#### Language Detection

Map file extensions to Monaco language IDs:
- `.ts`, `.tsx` → `typescript`
- `.js`, `.jsx` → `javascript`
- `.py` → `python`
- `.go` → `go`
- `.rs` → `rust`
- `.json` → `json`
- `.md` → `markdown`
- Default: `plaintext`

## [S4] Frontend Design

### View Registration

**Modified:** `frontend/app/block/blockregistry.ts`
```typescript
import { SourceControlViewModel } from "@/app/view/sourcecontrol/sourcecontrol-model";
BlockRegistry.set("sourcecontrol", SourceControlViewModel);
```

**Modified:** `pkg/wconfig/defaultconfig/widgets.json`
```json
{
    "defwidget@sourcecontrol": {
        "display:order": -6,
        "icon": "code-branch",
        "label": "source\ncontrol",
        "magnified": false,
        "blockdef": {
            "meta": {
                "view": "sourcecontrol"
            }
        }
    }
}
```

### New Files

| File | Purpose |
|------|---------|
| `frontend/app/view/sourcecontrol/sourcecontrol-model.ts` | ViewModel class |
| `frontend/app/view/sourcecontrol/sourcecontrol.tsx` | Main React component |
| `frontend/app/view/sourcecontrol/filetree.tsx` | File tree with arborist |
| `frontend/app/view/sourcecontrol/filerow.tsx` | Individual file row |
| `frontend/app/view/sourcecontrol/diffpanel.tsx` | Monaco diff viewer wrapper |
| `frontend/app/view/sourcecontrol/types.ts` | Shared TypeScript types |
| `pkg/git/git.go` | Git backend |
| `pkg/git/git_test.go` | Tests |

### SourceControlViewModel

```typescript
class SourceControlViewModel implements ViewModel {
    viewType = "sourcecontrol";
    
    // Atoms
    statusAtom: PrimitiveAtom<GitStatusResponse | null>;
    selectedFileAtom: PrimitiveAtom<{ path: string; staged: boolean } | null>;
    loadingAtom: PrimitiveAtom<boolean>;
    errorAtom: PrimitiveAtom<string | null>;
    viewModeAtom: PrimitiveAtom<"side-by-side" | "inline">;
    
    // Derived
    diffAtom: Atom<Promise<GitDiffResponse | null>>;
    
    // Polling
    pollInterval = 3000;
    pollTimer: ReturnType<typeof setInterval> | null = null;
    
    // Connection (from terminal's cwd)
    connection: Atom<string>;
    
    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.viewType = "sourcecontrol";
        this.blockId = blockId;
        this.env = waveEnv;
        // ... initialize atoms
        this.startPolling();
    }
    
    get viewComponent(): ViewComponent {
        return SourceControlView;
    }
    
    dispose() {
        this.stopPolling();
    }
}
```

### UI Layout

```
┌──────────────────────────────────────────────────────────┐
│  Source Control                              main branch  │
├─────────────────────┬────────────────────────────────────┤
│  Search files...    │                                    │
├─────────────────────┤                                    │
│  STAGED (3)         │                                    │
│  ├ M src/utils.ts   │     Monaco DiffEditor             │
│  ├ A src/new.ts     │     (side-by-side or inline)      │
│                     │                                    │
│  UNSTAGED (5)       │                                    │
│  ├ M src/app.ts     │                                    │
│  ├ D src/old.ts     │                                    │
│  ├ M package.json   │                                    │
│  ├ M README.md      │                                    │
│  │                  │                                    │
│  UNTRACKED (2)      │                                    │
│  ├ ? src/test.ts    │                                    │
│  └ ? .env           │                                    │
└─────────────────────┴────────────────────────────────────┘
```

### FileRow Component

```tsx
function FileRow({ file, isSelected, onClick }: FileRowProps) {
    return (
        <div 
            className={clsx("file-row", isSelected && "selected")}
            onClick={onClick}
        >
            <span className="status-badge" style={{ color: file.Color }}>
                {file.Status}
            </span>
            <i className={clsx("fa-solid", file.Icon)} style={{ color: file.Color }} />
            <span className="file-path">{file.Path}</span>
        </div>
    );
}
```

## [S5] Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `react-arborist` | latest | Tree view component |
| `monaco-editor` | ^0.55.1 | Already bundled in waveterm |

### Adding react-arborist

```bash
cd /home/mimo-code/project/waveterm-remote-vcs
npm install react-arborist
```

## [S6] Data Flow

1. **Widget opens** → ViewModel mounts → starts polling `git/status`
2. **Backend** runs `git status --porcelain=v2` in terminal's cwd
3. **Frontend** renders file tree with staged/unstaged sections
4. **User clicks file** → fetches `git/diff` or `git/diff-unstaged`
5. **Backend** runs `git diff [--cached] -- <file>`
6. **Monaco** renders side-by-side diff
7. **Terminal changes directory** → polling restarts with new cwd

## [S7] Error Handling

| Scenario | Handling |
|----------|----------|
| Not a git repo | Show "Not a git repository" message, stop polling |
| Git command fails | Show error toast, keep last good state |
| File deleted | Show "File not found" in diff panel |
| Connection lost | Show "Disconnected" banner, retry on reconnect |

## [S8] Testing

### Backend Tests (`pkg/git/git_test.go`)
- Parse `git status --porcelain=v2` output
- Status code mapping
- Language detection from file extensions
- Edge cases: empty repo, no changes, renamed files

### Frontend Tests
- ViewModel state transitions
- File selection → diff fetching
- Polling start/stop lifecycle
- Error state rendering

## [S9] Implementation Phases

| Phase | Scope | Effort |
|-------|-------|--------|
| **MVP** | File list, staged/unstaged, read-only diffs | ✅ Done |
| **Phase 2** | Stage/unstage files + hunks | ✅ Done |
| **Phase 3** | Commit input box + commit | ✅ Done |
| **Phase 4** | Push auth, directory dropdown | ✅ Done |
| **Phase 5** | Multi-file diff view (P1 prereq) | 2-3 days |
| **Phase 6** | Review mode: unified view, file preview (full content + markdown render), change provenance (P2-P3) | 2-3 days |
| **Phase 7** | Pull/push buttons with counts, branch tracking (P4) | 2-3 days |
| **Phase 8** | Commit list + graph toggle (P5) | 3-5 days |
| **Phase 9** | Amend, branch mgmt, collapse regions (P6) | 3-5 days |
| **Phase 10** | Stash, merge/rebase, decorations (P7) | 1-2 weeks |

## [S10] Resolved Design Decisions

1. **Terminal CWD:** Use focused terminal's cwd via `getBlockMetaKeyAtom(blockId, "cmd:cwd")`. Fall back to "local" if no terminal is focused. Re-poll when terminal's cwd changes.

2. **File open behavior:** Single-click shows diff. Double-click also shows diff (same behavior). Keep simple for MVP.

3. **Auto-refresh:** Stop polling when view is hidden. On refocus, immediately check for git changes, then resume polling every 3 seconds.
