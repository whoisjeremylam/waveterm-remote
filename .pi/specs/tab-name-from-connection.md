# Auto-Name Tabs from Connection Hostname

**Date:** 2026-07-01
**Status:** Ready
**Branch:** `feature/source-control-widget`

## [S1] Problem

When a user creates a new tab with a pre-selected SSH connection (via the "+" dropdown on the tab bar), the tab name defaults to `T1`, `T2`, `T3`... This is uninformative — the user has to manually rename every tab to identify which remote machine it connects to.

## [S2] Solution

When creating a new tab, extract a short human-readable label from the connection name or local hostname. Remote tabs get names like `server`, `db`, `192.168.1.50`. Local tabs get the machine's hostname. Dedup handles collisions with existing tab names.

## [S3] Where

Single file: `pkg/wcore/workspace.go` — `CreateTab()`. No frontend changes, no new RPCs.

## [S4] Extraction Logic

### Remote connections (`connName != ""`)

1. Split on `@`, take the host part (after last `@`)
2. Strip port using `net.SplitHostPort` (handles IPv6 brackets)
3. If domain (contains non-numeric dot-separated segments), take first segment
4. If IP (all-numeric segments), keep full IP
5. `strings.ToLower()` for case normalization

### Local tabs (`connName == ""`)

1. Check `conn:localhostdisplayname` config — if set, use it directly
2. Otherwise call `os.Hostname()`, extract short hostname, lowercase

### Fallback

If extraction yields empty string, fall back to existing `getNextTabName` (`T1`, `T2`, ...).

## [S5] Dedup

Check the extracted name against all existing tab names (including user-renamed). If occupied, append ` (2)`, ` (3)`, etc. Pattern: `^<base>( \(\d+\))?$`.

## [S6] Decisions

| Decision | Choice |
|----------|--------|
| IP addresses | Use full IP (e.g. `192.168.1.50`) |
| SSH config aliases | Use the alias as typed (don't resolve HostName) |
| Dedup scope | All existing tab names, including user-renamed |
| Case | `strings.ToLower()` on all names |
| Local display name | Honor `conn:localhostdisplayname` if set |
| Truncation | No truncation in backend (frontend handles display) |
| `Cmd+t` shortcut | No connName → fallback to `T1`, `T2`, ... |

## [S7] Files Changed

| File | Changes |
|------|---------|
| `pkg/wcore/workspace.go` | Add `getTabNameFromConn()`, `shortHostname()`, `makeUniqueTabName()`. Modify `CreateTab()`. |

## [S8] Testing

1. `user@server.example.com` → `server`
2. `user@server.example.com:2222` → `server`
3. `user@192.168.1.50` → `192.168.1.50`
4. `user@192.168.1.50:2222` → `192.168.1.50`
5. `user@[2001:db8::1]` → `2001:db8::1`
6. `user@[2001:db8::1]:2222` → `2001:db8::1`
7. SSH config alias `user@myalias` → `myalias`
8. No `@` `justhost` → `justhost`
9. Empty host `user@` → fallback to `user@`
10. Local tab → `os.Hostname()` short name
11. Local + `conn:localhostdisplayname` → custom name
12. Dedup: existing `server` → `server (2)`
13. Case: `DESKTOP-ABCDEF` → `desktop-abcdef`
