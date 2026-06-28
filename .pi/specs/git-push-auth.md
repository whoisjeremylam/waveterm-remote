# Git Push Authentication Specification

**Date:** 2026-06-28
**Status:** Draft
**Branch:** `feature/source-control-widget`

## [S1] Problem

The SCM widget's push button fails when credentials are required. Users see a console error but have no way to enter credentials through the UI. The backend detects auth errors but the frontend just logs them.

## [S2] Solution Overview

Implement a complete git push authentication flow that:
1. Detects auth errors from git push operations
2. Checks WaveTerm's secret store for stored credentials
3. Shows a credential dialog when credentials are needed or invalid
4. Allows users to save/update credentials in the secret store

## [S3] Secret Store Integration

### Secret Naming Convention

Secret names use underscore-encoding to comply with the secret store's
`^[A-Za-z][A-Za-z0-9_]*$` validation pattern. Colons, dots, and slashes are
replaced with underscores.

| Scope | Pattern | Example |
|-------|---------|---------|
| Repo-specific | `git_<protocol>_<host>_<owner>_<repo>` | `git_https_github_com_user_private-repo` |
| Host-wide | `git_<protocol>_<host>` | `git_https_github_com` |

### Secret Format

Secrets store both username and password as JSON:
```json
{"username": "john", "password": "ghp_xxxx"}
```

### Lookup Priority

1. **First**: Check repo-specific secret (`git_https_github_com_user_repo`)
2. **Fallback**: Check host-wide secret (`git_https_github_com`)

## [S4] Push Auth Flow

```
User clicks Push
       │
       ▼
┌──────────────────┐
│ Git push attempt │
└──────────────────┘
       │
       ▼
   Success? ──────────────────────────────────────────────────── Yes ──► Done
       │
       No (auth error)
       │
       ▼
┌──────────────────────────────────────┐
│ Check secret store (priority order): │
│ 1. git_<protocol>_<host>_<owner>_<repo> │
│ 2. git_<protocol>_<host>               │
└──────────────────────────────────────┘
       │
       ▼
  Found? ────────────────────────────────────────────── No ──► Show Dialog
       │                                                 │      (New Credentials)
       Yes                                               │           │
       │                                                 │           ▼
       ▼                                                 │    ┌─────────────┐
┌──────────────────┐                                      │    │  Username:  │
│ Retry with stored│                                      │    │  Token:     │
│ credentials      │                                      │    │  Scope:     │
└──────────────────┘                                      │    │  Save: ☑    │
       │                                                 │    └─────────────┘
       ▼                                                 │           │
   Success? ──────────────── Yes ─────────────────────────┼──► Done
       │                                                 │
       No                                                │
       │                                                 │
       ▼                                                 │
┌──────────────────────────┐                              │
│ Show Dialog              │                              │
│ "Stored credentials      │                              │
│  failed. Enter new       │                              │
│  credentials:"           │                              │
│                          │                              │
│  Username: [pre-filled]  │                              │
│  Token:    [__________]  │                              │
│  Update stored: ☑        │                              │
└──────────────────────────┘                              │
       │                                                 │
       ▼                                                 │
┌──────────────────┐                                      │
│ Retry with new   │                                      │
│ credentials      │                                      │
└──────────────────┘                                      │
       │                                                 │
       ▼                                                 │
   Success? ── Yes ──► Done                              │
       │        (Update secret if "Update stored" ☑)     │
       │                                                 │
       No                                                │
       │                                                 │
       ▼                                                 │
┌──────────────────────────┐                              │
│ Show error:              │                              │
│ "Authentication failed.  │                              │
│  Check credentials and   │                              │
│  try again."             │                              │
│                          │                              │
│  [Retry]  [Cancel]       │                              │
└──────────────────────────┘                              │
       │                                                 │
       ▼                                                 │
   [Retry] ──────────────────────────────────────────────┘
```

## [S5] Summary of Cases

| Case | Stored? | Valid? | Dialog Shown? | Action |
|------|---------|--------|---------------|--------|
| **New credentials** | No | - | Yes (empty) | Save if checkbox checked |
| **Reuse - works** | Yes | Yes | No (silent retry) | None |
| **Reuse - fails** | Yes | No | Yes (pre-filled user, empty token) | Update if checkbox checked |

## [S6] Dialog Variants

### New credentials
```
┌─────────────────────────────────────────────────┐
│  Authentication Required                         │
│                                                  │
│  git push to https://github.com/user/repo        │
│                                                  │
│  Username:  [________________]                   │
│  Token:     [________________]  (masked)         │
│                                                  │
│  Save to:  (●) This repository (user/repo)       │
│            ( ) All repos on github.com            │
│                                                  │
│        [Cancel]  [Authenticate]                  │
└─────────────────────────────────────────────────┘
```

### Failed stored credentials
```
┌─────────────────────────────────────────────────┐
│  Authentication Failed                           │
│                                                  │
│  Stored credentials for github.com were rejected.│
│  Enter new credentials:                          │
│                                                  │
│  Username:  [john]  (pre-filled from stored)     │
│  Token:     [________________]  (masked)         │
│                                                  │
│  ☑ Update stored credentials                     │
│                                                  │
│        [Cancel]  [Authenticate]                  │
└─────────────────────────────────────────────────┘
```

## [S7] Backend Design

### New RPC Command: `git/lookupcredentials`

**Request:**
```go
type CommandGitLookupCredentialsData struct {
    Remote string `json:"remote"`  // e.g., "https://github.com/user/repo"
}
```

**Response:**
```go
type GitCredentials struct {
    Username string `json:"username"`
    Password string `json:"password"`
    Found    bool   `json:"found"`
    Scope    string `json:"scope"`  // "repo" or "host"
}
```

**Behavior:**
1. Parse protocol, host, owner, repo from remote URL
2. Check repo-specific secret first (`git:https:github.com/user/repo`)
3. Fall back to host-wide secret (`git:https:github.com`)
4. Parse JSON value to extract username/password
5. Return credentials with scope indicator

### Modified: `GitPushCommand`

Add to response:
```go
type GitPushResponse struct {
    Success    bool   `json:"success"`
    Output     string `json:"output"`
    AuthNeeded bool   `json:"authNeeded"`
    AuthError  string `json:"authError"`
    AuthHost   string `json:"authHost"`   // parsed from error or remote
    AuthRemote string `json:"authRemote"` // full remote URL
}
```

## [S8] Frontend Design

### New Atoms in `SourceControlViewModel`

```typescript
showAuthDialog: PrimitiveAtom<boolean>
authError: PrimitiveAtom<string | null>
authHost: PrimitiveAtom<string>
authRemote: PrimitiveAtom<string>
authPreFilledUsername: PrimitiveAtom<string>
authIsRetry: PrimitiveAtom<boolean>  // true if stored credentials failed
```

### Push Flow in Model

```typescript
async push(username?: string, password?: string): Promise<GitPushResponse> {
    // 1. Attempt push with provided credentials (or empty)
    const result = await rpc.GitPushCommand(...)
    
    // 2. If auth needed and no credentials provided
    if (result.authNeeded && !username) {
        // Check secret store
        const stored = await rpc.GitLookupCredentials(result.authRemote)
        
        if (stored.found) {
            // Retry silently with stored credentials
            return this.push(stored.username, stored.password)
        } else {
            // Show dialog
            this.showAuthDialog(result.authHost, result.authRemote, "", false, "repo")
            return null  // dialog will retry
        }
    }
    
    // 3. If auth failed with provided credentials (retry case)
    if (!result.success && result.authNeeded) {
        const stored = await rpc.GitLookupCredentials(result.authRemote)
        this.showAuthDialog(result.authHost, result.authRemote, username, true, stored.scope)
        return null
    }
    
    return result
}
```

### New Component: `GitAuthDialog`

Props:
- `host: string` - git host (github.com)
- `remote: string` - full remote URL
- `preFilledUsername?: string` - username from failed stored credentials
- `isRetry: boolean` - whether this is a retry after failed stored credentials
- `onSubmit: (username, password, saveScope) => void`
- `onCancel: () => void`

## [S9] Files to Modify

| File | Changes |
|------|---------|
| `pkg/wshrpc/wshrpctypes.go` | Add `GitCredentials`, `CommandGitLookupCredentialsData`, update `GitPushResponse` |
| `pkg/wshrpc/wshremote/git.go` | Implement `GitLookupCredentials`, update `GitPushCommand` |
| `frontend/app/view/sourcecontrol/sourcecontrol-model.ts` | Add auth atoms, update `push()` flow |
| `frontend/app/view/sourcecontrol/sourcecontrol.tsx` | Add `GitAuthDialog` component |
| `frontend/types/gotypes.d.ts` | Update TypeScript types |

## [S10] Testing

1. Push to private repo without credentials → dialog appears
2. Enter correct credentials with "Save" checked → push succeeds, secret stored
3. Push again → silent retry (no dialog)
4. Revoke token, push again → dialog appears with "Stored credentials failed"
5. Enter new credentials → push succeeds, secret updated
6. Cancel dialog → push cancelled gracefully
7. Repo-specific secret takes priority over host-wide secret
8. Host-wide secret used as fallback when no repo-specific secret exists
