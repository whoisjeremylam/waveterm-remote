# Duplicate Session (Tab Context Menu)

> Created: 2026-08-14 · Status: planned (not implemented)
> Branch: `odds-and-ends`

## Problem

Remote-first workflow: the user often wants a *second* shell session to the same
host and directory as an existing tab (e.g., run a second long-lived command
against the same project). Today they must open a new tab, pick the connection,
then `cd` back to the directory.

**Feature:** right-click a tab → **"Duplicate Session"** → a new tab with a fresh
shell on the same connection, starting in the same working directory.

## Scope (v1)

- New **"Duplicate Session"** item in the tab context menu.
- Duplicates the **focused terminal block** of the source tab.
- Creates a **new, activated tab** with a **new terminal block** on the **same
  connection**.
- Preserves the **working directory** (`cmd:cwd`).
- Fresh shell (new job / durable session) — never attaches to the source job.
- Hidden/disabled when the tab has no terminal block (nothing to duplicate).

## Design decisions

| Decision | Choice | Notes |
|----------|--------|-------|
| Source of "the session" | Focused terminal block, falling back to focus history | Reuse existing `getFocusedTerminalConnection()` / `getFocusedTerminalCwd()` (already exported from `frontend/app/store/global.ts`) |
| New tab vs same-tab block | **New tab** (activated) | Matches "right-click a tab" |
| Connection | Reuse the same `connection` name | Shared SSH connection, new shell channel/job |
| cwd | Copy `cmd:cwd`; new shell `cd`s on startup | Verify how a fresh block honors `cmd:cwd` (see open questions) |
| Multi-block (split) tabs | Duplicate focused terminal only (v1) | "Duplicate whole layout" = possible follow-up |
| Non-terminal blocks | Ignored | Widgets/previews are not "sessions" |
| Tab name | **Auto-name from connection hostname** (pass empty `tabName`) | Reuses `CreateTab`'s existing naming: short hostname, de-duped (`server`, `server (2)`, …); local tabs use machine hostname |

## Implementation approach

1. **`frontend/app/tab/tabcontextmenu.ts`** — add the menu item to
   `buildTabContextMenu` (near "Copy TabId" / "Close Tab").
2. **On click** — read the source connection + cwd via
   `getFocusedTerminalConnection()` and `getFocusedTerminalCwd()` (import from
   `@/app/store/global`).
3. **Create the tab** — `Services.CreateTab(workspaceId, "", true, connName)`
   (already exists; creates a tab + terminal block wired to `connName`). Pass an
   **empty tab name** so the backend auto-names it from the connection hostname
   with de-dup (`server`, `server (2)`, …) — same behavior as the connection
   dropdown's "new tab".
4. **Preserve cwd** — set the new block's `meta["cmd:cwd"]` and ensure the shell
   starts there (mechanism TBD — see open questions).

## Files (likely)

- `frontend/app/tab/tabcontextmenu.ts` — menu item + handler.
- `frontend/app/store/global.ts` — small `duplicateSession()` helper reusing the
  existing focused-connection/cwd helpers (or inline the logic).
- Backend — probably **no change** (`CreateTab` + block `meta` already exist);
  confirm cwd-on-create behavior.

## Test cases

1. Remote terminal tab → Duplicate → new tab opens on the **same host**, fresh
   shell (separate job: typing in one does not appear in the other).
2. Local terminal tab → Duplicate → new local tab.
3. **cwd**: `cd /some/project` then Duplicate → new shell `pwd` = `/some/project`.
4. Tab with no terminal block (widget/preview only) → item hidden/disabled.
5. Split pane with two terminals → Duplicate → new tab uses the *focused*
   terminal's host/cwd.
6. Durable session → Duplicate → a **new** durable session (different job id),
   not a second view of the same job.

## Open questions (resolve before/while implementing)

1. Confirm **new tab** (not a new block in the same tab).
2. **cwd mechanism:** does the shell controller honor `cmd:cwd` at block creation,
   or must the frontend send an initial `cd` (or set the `file`/`cmd:cwd` meta and
   rely on the shell-integration OSC7)? Verify in `shellcontroller.go` /
   `durableshellcontroller.go`.
3. ~~**Tab naming** for the duplicate~~ — **resolved**: auto-name from connection hostname (empty `tabName`).
4. **Duplicate whole layout** (multi-pane) as a follow-up?
