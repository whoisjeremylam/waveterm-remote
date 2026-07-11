# tmux CWD Tracking via `wsh setmeta`

**Date:** 2026-07-08
**Status:** Draft

## Problem

When a user runs tmux inside a waveterm durable shell, the shell integration scripts detect `$TMUX` (or `$STY`/`screen*` `$TERM`) and suppress all OSC sequences — including OSC 7, which is how the frontend tracks the current working directory (`cmd:cwd`). As a result, `cmd:cwd` goes stale after the user `cd`s inside tmux, and the SCM widget, file widget, and terminal header all show the wrong directory.

Root cause: `_waveterm_si_blocked()` in each shell integration script gates every integration function (`_waveterm_si_osc7`, `_waveterm_si_precmd`, `_waveterm_si_preexec`, `_waveterm_si_prompt`) with an early `return` when a multiplexer is detected. OSC 7 is absorbed by tmux and never reaches waveterm's pty, so suppressing it was the correct defensive choice — but no alternative cwd-update mechanism was provided.

## Solution

Replace the silent `return` in `_waveterm_si_osc7()` (when blocked) with a `wsh setmeta -b this "cmd:cwd=$PWD"` call. This pushes cwd to the block via waveterm's Unix domain socket RPC, bypassing tmux entirely. The existing `cmd:cwd` meta key is the same one OSC 7 sets, so all existing consumers (`getFocusedTerminalCwd()`, SCM's `terminalCwd`, Preview's `metaFilePath`) work unchanged.

For shells that only update cwd in the prompt function (bash, pwsh — no `chpwd` hook), the prompt/precmd function must also be modified to call `_waveterm_si_osc7` even when blocked (skipping only the OSC 16162 sequences). For shells with a `chpwd`/`on-variable PWD` hook (zsh, fish), the hook already calls `_waveterm_si_osc7` directly, so only `_waveterm_si_osc7` itself needs modification.

## Scope

- **In scope:** CWD tracking under tmux/screen for bash, zsh, fish, and pwsh
- **Out of scope:** OSC 16142 command/exit markers under tmux (separate future work), pane title, `pane_current_command`, widget-state persistence (see `.pi/specs/widget-keepalive.md`), `shell:hascurcwd` rtInfo (unused — set but never read)

## Verification

Verified live in the current session (which runs inside tmux under wsh):

- `WAVETERM_BLOCKID` is present inside tmux panes: `26d15df7-...`
- `wsh` is on PATH inside tmux: `/home/jeremy/.waveterm/bin/wsh`
- `wsh getmeta -b this` works from inside tmux and shows stale `cmd:cwd`
- `wsh setmeta -b this "cmd:cwd=$PWD"` successfully updates `cmd:cwd` from inside tmux
- `wsh setmeta` from a subshell also works (simulating what shell integration would do)

## Current Architecture

```
Shell (bash/zsh/fish/pwsh)
  │
  ├─ _waveterm_si_osc7() → OSC 7 escape sequence → tmux pty
  │    └─ Under tmux: _waveterm_si_blocked() → return (no OSC 7 emitted)
  │
  ├─ _waveterm_si_precmd() → OSC 16162 sequences + OSC 7
  │    └─ Under tmux: _waveterm_si_blocked() → return (nothing emitted)
  │
  tmux (absorbs OSC sequences, does not forward to outer pty)
  │
  waveterm pty (xterm.js)
  │
  handleOsc7Command() → SetMetaCommand(cmd:cwd) ← never fires under tmux
```

### Per-shell cwd-update mechanisms

| Shell | cwd update trigger | Function | Gated by `_waveterm_si_blocked`? |
|-------|-------------------|----------|----------------------------------|
| bash | every prompt (`precmd`) | `_waveterm_si_osc7` called from `_waveterm_si_precmd` | Yes — `precmd` returns before calling `_waveterm_si_osc7` |
| zsh | `chpwd` hook + first prompt | `_waveterm_si_osc7` called from `chpwd` hook and `_waveterm_si_precmd` (first prompt only) | `chpwd` calls `_waveterm_si_osc7` directly (no gate); `_waveterm_si_osc7` itself has the gate |
| fish | `on-variable PWD` + first prompt | `_waveterm_si_osc7` called from `_waveterm_si_chpwd` and `_waveterm_si_prompt` (first prompt only) | `chpwd` calls `_waveterm_si_osc7` directly (no gate); `_waveterm_si_osc7` itself has the gate |
| pwsh | every prompt | `_waveterm_si_osc7` called from `_waveterm_si_prompt` | Yes — `_waveterm_si_prompt` returns before calling `_waveterm_si_osc7` |

### Key insight

For zsh and fish, the `chpwd`/`on-variable PWD` hook calls `_waveterm_si_osc7` **directly** (not through the gated precmd/prompt function). So modifying `_waveterm_si_osc7` alone is sufficient — the chpwd hook will call it, and it will route to `wsh setmeta` under tmux. Directory changes are covered.

For bash and pwsh, there is no `chpwd` hook — cwd updates happen only in `precmd`/`prompt`, which gate with `_waveterm_si_blocked && return` at the top. These must be modified to still call `_waveterm_si_osc7` even when blocked (but skip OSC 16142).

## Changes

### 1. `pkg/util/shellutil/shellintegration/bash_bashrc.sh`

**Modify `_waveterm_si_osc7`** — when blocked, push cwd via `wsh setmeta` instead of returning silently:

```bash
_waveterm_si_osc7() {
    if _waveterm_si_blocked; then
        # Under tmux/screen, OSC 7 is absorbed by the multiplexer.
        # Push cwd out-of-band via wsh's Unix socket instead.
        wsh setmeta -b this "cmd:cwd=$PWD" 2>/dev/null
        return
    fi
    local encoded_pwd=$(_waveterm_si_urlencode "$PWD")
    printf '\033]7;file://localhost%s\007' "$encoded_pwd"
}
```

**Modify `_waveterm_si_precmd`** — when blocked, skip OSC 16162 but still call `_waveterm_si_osc7` (which routes to `wsh setmeta`). Bash has no `chpwd` hook, so precmd is the only cwd-update trigger:

```bash
_waveterm_si_precmd() {
    local _waveterm_si_status=$?
    if _waveterm_si_blocked; then
        # Under tmux/screen, skip OSC 16142 sequences (they'd be absorbed)
        # but still update cwd via wsh setmeta (called from _waveterm_si_osc7)
        _waveterm_si_osc7
        return
    fi
    # ... existing non-blocked logic (OSC 16142 M/D/A + OSC 7) unchanged ...
}
```

**`_waveterm_si_preexec`** — no change needed. Under tmux, command markers (OSC 16142 C) are out of scope. The existing `_waveterm_si_blocked && return` stays.

### 2. `pkg/util/shellutil/shellintegration/zsh_zshrc.sh`

**Modify `_waveterm_si_osc7`** — same pattern as bash:

```zsh
_waveterm_si_osc7() {
  if _waveterm_si_blocked; then
    wsh setmeta -b this "cmd:cwd=$PWD" 2>/dev/null
    return
  fi
  local encoded_pwd=$(_waveterm_si_urlencode "$PWD")
  printf '\033]7;file://localhost%s\007' "$encoded_pwd"  # OSC 7 - current directory
}
```

**`_waveterm_si_precmd`** — no change needed. Under tmux, precmd returns early (skipping first-prompt OSC 7 + OSC 16142). The initial `cmd:cwd` is already set at block creation time (`durableshellcontroller.go:236` reads `cmd:cwd` from block meta). Subsequent `cd` changes are handled by the `chpwd` hook, which calls `_waveterm_si_osc7` directly — and with the modification above, that routes to `wsh setmeta`. ✅

**`_waveterm_si_preexec`** — no change needed (command markers out of scope).

### 3. `pkg/util/shellutil/shellintegration/fish_wavefish.sh`

**Modify `_waveterm_si_osc7`** — same pattern:

```fish
function _waveterm_si_osc7
    if _waveterm_si_blocked
        # Under tmux/screen, push cwd via wsh socket instead of OSC 7
        wsh setmeta -b this "cmd:cwd=$PWD" 2>/dev/null
        return
    end
    # Use fish-native URL encoding
    set -l encoded_pwd (string escape --style=url -- "$PWD")
    printf '\033]7;file://localhost%s\007' $encoded_pwd
end
```

**`_waveterm_si_prompt`** — no change needed. The `_waveterm_si_chpwd` hook (`on-variable PWD`) calls `_waveterm_si_osc7` directly and handles directory changes. Initial cwd is set at block creation. ✅

### 4. `pkg/util/shellutil/shellintegration/pwsh_wavepwsh.sh`

**Modify `_waveterm_si_osc7`**:

```powershell
function Global:_waveterm_si_osc7 {
    if (_waveterm_si_blocked) {
        # Under tmux/screen, push cwd via wsh socket instead of OSC 7
        wsh setmeta -b this "cmd:cwd=$($PWD.Path)" 2>$null
        return
    }

    # Percent-encode the raw path as-is (handles UNC, drive letters, etc.)
    $encoded_pwd = [System.Uri]::EscapeDataString($PWD.Path)

    # OSC 7 - current directory
    Write-Host -NoNewline "`e]7;file://localhost/$encoded_pwd`a"
}
```

**Modify `_waveterm_si_prompt`** — pwsh has no `chpwd` hook, so the prompt is the only cwd-update trigger. When blocked, skip OSC 16142 but still call `_waveterm_si_osc7`:

```powershell
function Global:_waveterm_si_prompt {
    if (_waveterm_si_blocked) {
        # Under tmux/screen, skip OSC 16142 but still update cwd
        _waveterm_si_osc7
        return
    }

    if ($Global:_WAVETERM_SI_FIRSTPROMPT) {
        # ... existing first-prompt logic unchanged ...
    }
    _waveterm_si_osc7
}
```

## How `wsh setmeta` Works

```
Shell (inside tmux)
  │
  ├─ _waveterm_si_osc7() → wsh setmeta -b this "cmd:cwd=$PWD"
  │    │
  │    ├─ reads $WAVETERM_BLOCKID (inherited env var, survives into tmux panes)
  │    ├─ connects to waveterm Unix domain socket (NOT the pty)
  │    └─ sends SetMetaCommand RPC → updates block meta cmd:cwd
  │
  tmux (not involved — socket bypasses the pty entirely)
  │
  waveterm backend → block meta updated → frontend atoms re-render
  ├─ getFocusedTerminalCwd() reads cmd:cwd ✅
  ├─ SCM terminalCwd atom reads cmd:cwd ✅
  └─ Preview metaFilePath falls back to cmd:cwd ✅
```

### Why this works under tmux

- `wsh setmeta` uses the Unix domain socket (`waveterm.sock`), not the terminal pty
- tmux sits between the shell and waveterm's pty, absorbing OSC sequences — but it has no involvement in the socket
- `WAVETERM_BLOCKID` is set in the shell environment (`blockcontroller.go:588`) and inherited by tmux panes (verified: `$WAVETERM_BLOCKID` is present inside the current tmux session)
- `wsh` is on PATH inside the shell (shell integration scripts add `$WAVETERM_WSHBINDIR` to PATH at the top of each script)
- `2>/dev/null` ensures silent failure if `wsh` is missing or `WAVETERM_BLOCKID` is unset (e.g., user's tmux config strips env vars)

### Performance

`wsh setmeta` spawns a subprocess that does a Unix socket RPC. Typical latency: 1-5ms. For bash/pwsh (fires on every prompt), this adds a small delay to prompt rendering. For zsh/fish (fires on `chpwd`/`on-variable PWD` only), it fires only on directory changes — negligible. The `2>/dev/null` ensures no user-visible errors if `wsh` is unavailable.

### Fallback behavior

If `wsh` is not on PATH, or `WAVETERM_BLOCKID` is not set, or the socket is unavailable, `wsh setmeta` fails silently (`2>/dev/null`). The shell continues normally — `cmd:cwd` simply doesn't update, same as the current behavior. No regression.

## Files to Modify

| File | Change |
|------|--------|
| `pkg/util/shellutil/shellintegration/bash_bashrc.sh` | Modify `_waveterm_si_osc7` (wsh setmeta when blocked) and `_waveterm_si_precmd` (call osc7 when blocked, skip OSC 16142) |
| `pkg/util/shellutil/shellintegration/zsh_zshrc.sh` | Modify `_waveterm_si_osc7` (wsh setmeta when blocked) |
| `pkg/util/shellutil/shellintegration/fish_wavefish.sh` | Modify `_waveterm_si_osc7` (wsh setmeta when blocked) |
| `pkg/util/shellutil/shellintegration/pwsh_wavepwsh.sh` | Modify `_waveterm_si_osc7` (wsh setmeta when blocked) and `_waveterm_si_prompt` (call osc7 when blocked, skip OSC 16142) |

**No frontend changes.** No new RPC. No version bump. No new wsh CLI command.

## Test Cases

### Manual testing (inside a tmux session in a waveterm durable shell)

1. **CWD updates on `cd` (zsh/fish):**
   - Open a durable shell, start tmux
   - `cd /tmp` — verify `wsh getmeta -b this` shows `cmd:cwd: /tmp`
   - `cd /home` — verify `cmd:cwd` updates to `/home`
   - Verify SCM widget and file widget show the correct directory

2. **CWD updates on prompt (bash/pwsh):**
   - Open a durable shell (bash), start tmux
   - `cd /tmp` — verify `cmd:cwd` updates on next prompt
   - `cd /home` — verify `cmd:cwd` updates on next prompt

3. **Non-tmux still works (regression):**
   - Open a durable shell WITHOUT tmux
   - `cd /tmp` — verify `cmd:cwd` updates via OSC 7 (unchanged behavior)
   - Verify SCM/file widgets show correct directory

4. **Screen compatibility:**
   - Start `screen` (not tmux) in a durable shell
   - `cd /tmp` — verify `cmd:cwd` updates via `wsh setmeta` (screen is also detected by `_waveterm_si_blocked`)

5. **Fallback (no wsh on PATH):**
   - Start a shell where `wsh` is not on PATH (e.g., `env -i bash`)
   - `cd /tmp` — verify no errors printed to terminal, `cmd:cwd` doesn't update (graceful degradation)

6. **Widget verification:**
   - Inside tmux, open the SCM widget — it should show the git status for the tmux pane's cwd
   - `cd` to a different repo — SCM widget should update on next poll (3s interval)

### Automated testing

Shell integration scripts are not unit-tested in the current codebase. Manual testing is the primary verification method. The `wsh setmeta` call can be verified in isolation:

```bash
# Inside tmux, verify the command works:
wsh setmeta -b this "cmd:cwd=$(pwd)" && wsh getmeta -b this | grep cmd:cwd
```

## Out of Scope (Future)

- **OSC 16142 command/exit markers under tmux:** Could also be pushed via `wsh setmeta` (e.g., `shell:state`, `shell:lastcmd`), but this is a separate concern and requires more investigation into how the frontend consumes these.
- **`shell:hascurcwd` rtInfo:** Currently set by `handleOsc7Command` when OSC 7 is received, but never read anywhere in the frontend. Not needed for the cwd fix. Could be added via `wsh setmeta` if a future feature needs it.
- **`pane_current_command` / pane title from tmux:** Would require a tmux query RPC (the pull approach discussed in earlier analysis). Not needed for cwd tracking.
- **Widget-state persistence:** See `.pi/specs/widget-keepalive.md`.