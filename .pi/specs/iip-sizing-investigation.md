# IIP Image Sizing Investigation

## Problem Statement

When running `chafa --format=iterm2 <image>` in WaveTerm's xterm.js terminal, the rendered image is **exactly 1 row too small** compared to the same image rendered via `chafa --format=sixels`.

## Root Cause (Resolved)

A debug TIFF intercept in `frontend/app/view/term/termwrap.ts` hijacked `iipHandler.end()`, decoded TIFF itself, and called `storage.addImage(canvas)` with **raw TIFF pixel dimensions** — completely bypassing the addon's `_resize()` logic. When chafa's internal cell size (8px) differs from the terminal's cell size (9px), `Math.ceil(72/9) = 8` instead of the expected 9.

### The Fix Chain

| Commit | Change | Status |
|--------|--------|--------|
| `ece89781` | Remove `(height - ch)` from `_resize()` auto-sizing | ✅ Correct fix, but code path wasn't reached |
| `789b66ce` | Scale TIFF decode to resized dimensions | ✅ Correct fix, but debug patch bypassed it |
| Pending | Remove debug TIFF intercept from `termwrap.ts` | ✅ Done this session |

The addon-level fixes (`ece89781`, `789b66ce`) are correct but were never executed because the debug patch returned `true` before `origEnd()` was called.

## Remaining Debug Code (Low Severity)

The following debug code remains in `termwrap.ts`. None of it modifies image rendering behavior.

### 1. Window Globals (lines ~205-206)

```typescript
(window as any).__imageAddon = this.imageAddon;
(window as any).__term = this.terminal;
```

**Impact**: Exposes addon and terminal on `window` for console debugging. Reference leak if multiple TermWrap instances are created (old references overwritten). No behavioral side effects on rendering.

### 2. Test Helper Functions (lines ~207-290)

```typescript
window.__testIIP()          // Writes a test IIP sequence with tiny PNG
window.__testIIPHeader()    // Writes minimal IIP header test
window.__testOsc1337()      // Writes empty OSC 1337
window.__testIIPUint8()     // Writes IIP as Uint8Array
window.__testIIPChunked()   // Writes IIP in chunks via setTimeout
window.__testIIPParserState() // Reads parser state, logs OSC handler info
window.__testIIPAll()       // Runs all test helpers in sequence
```

**Impact**: Only invoked manually from browser console. Dead code in normal operation. Each function injects test data into the terminal's input stream. No automatic side effects.

### Code Path (when invoked manually)

```
User calls window.__testIIP() in console
  → Writes ESC]1337;File=inline=1;size=N:<base64>PNG BEL to terminal
  → terminal._core.input() feeds data to parser
  → parser dispatches to IIPHandler via OSC 1337 handler
  → IIPHandler.start() → .put() → .end() processes the image
  → Image rendered to canvas layer
```

## What We've Tried

### Fix 1: Remove `- ch` from `_resize()` (commit `ece89781`)

**Change**: `IIPHandler.ts:226` — `(height - ch) / h` → `height / h`

**Result**: ❌ Did not fix the issue alone — the auto-sizing path wasn't reached because chafa sends explicit `width/height`.

### Fix 2: TIFF decode path scaling (commit `789b66ce`)

**Change**: `IIPHandler.ts:192-216` — TIFF path now scales to `_resize()` dimensions via `drawImage()`.

**Result**: ❌ Did not fix the issue alone — the debug intercept in `termwrap.ts` was bypassing the addon's `end()` entirely.

### Fix 3: Remove debug intercept (this session)

**Change**: Removed `ImageAddon.prototype.activate` monkey-patch and `decodeTiff()` from `termwrap.ts`.

**Result**: ✅ The addon's TIFF path now executes correctly with proper resizing. (Pending user verification.)

## Protocol Comparison

| Aspect | Sixel | IIP (iTerm2) | Kitty |
|--------|-------|-------------|-------|
| Image format | Raw sixel pixels | TIFF (from chafa) | PNG/raw pixels |
| chafa's cell size | Terminal's actual | 8px (fixed internal) | N/A (not working) |
| Resize step | None needed | `_resize()` + TIFF scale | `Math.round(imgCols * cw)` |
| `addImage()` rows | `ceil(rawH / cellH)` = correct | `ceil(resizedH / cellH)` = correct | Computed from cols/rows |

## Files Modified (Current State)

| File | Change | Commit |
|------|--------|--------|
| `patches/@xterm+addon-image+0.10.0-beta.287.patch` | TIFF detection + decode in IIPMetrics.ts | Earlier session |
| Same patch | Remove `(height - ch)` in `_resize()` | `ece89781` |
| Same patch | Scale TIFF decode to resized dimensions | `789b66ce` |
| `frontend/app/view/term/termwrap.ts` | Removed critical debug patches | This session |
