# Image Rendering Investigation: WaveTerm + @xterm/addon-image

## Goal

Enable inline image rendering in WaveTerm's terminal using `@xterm/addon-image`, which supports Sixel, iTerm2 IIP, and Kitty graphics protocols. This would allow tools like `chafa`, `imgcat`, and `pi-tui` to display images in the terminal.

## Current State

- **Sixel works** - `chafa --format=sixels image.png` renders images successfully
- **IIP (iTerm2) does NOT work** - `chafa --format=iterm2 image.png` sends data but no image renders
- **Kitty not tested yet**

## Architecture

- **WaveTerm**: Electron app, frontend uses `@xterm/xterm@6.1.0-beta.287`
- **@xterm/addon-image@0.10.0-beta.287**: Provides Sixel/IIP/Kitty support
- **xterm.js has TWO parsers**:
  - `terminal.parser` (public API) - what `terminal.write()` dispatches through
  - `terminal._core._inputHandler._parser` (internal parser) - where addon-image registers handlers
  - **These are DIFFERENT objects** (`sameParser: false` confirmed)

## The Bug

When ImageAddon's `activate()` is called by `loadAddon()`, it registers its IIP handler on the **internal parser**:

```javascript
e._core._inputHandler._parser.registerOscHandler(1337, iipHandler)
```

But `terminal.write()` dispatches OSC sequences through the **public parser** (`terminal.parser`), which is a wrapper around a different internal object. The IIP handler never fires because it's on the wrong parser.

Sixel works because it uses a DCS handler, which apparently routes through the internal parser correctly.

## What We Know (Confirmed Facts)

1. ImageAddon loads successfully (`activate` is called)
2. `sameParser: false` - public parser !== internal parser
3. IIP handler IS registered (`_handlers.has('iip')` returns true)
4. Image data flows through `terminal.write()` (300+ chunks, ~1.2MB, BEL terminator present)
5. `storageUsage` stays 0 - IIP handler never fires
6. No image layer is created in DOM (`document.querySelector('.xterm-image-layer')` returns null)
7. The public parser CAN receive OSC 1337 data (confirmed when handler registered directly)
8. `__term.write()` with IIP escape sequences also doesn't trigger the handler

## What We've Tried

### 1. Upgrading to beta versions (SOLVED sixel)
- `@xterm/xterm@6.0.0` + `@xterm/addon-image@0.9.0` - IIP handler never fires
- `@xterm/xterm@6.1.0-beta.287` + `@xterm/addon-image@0.10.0-beta.287` - Same issue, but sixel now works
- The 0.9.0 addon accesses private APIs (`_core._inputHandler._parser`) that changed in xterm 6.0

### 2. Registering bridge handler on public parser AFTER loadAddon (DID NOT WORK)
- Moved prototype patch AFTER `terminal.loadAddon(imageAddon)` call
- Bridge handler never fires because activate already ran without the patch

### 3. Registering bridge per-terminal instance (DID NOT WORK reliably)
- Registered bridge directly on `this.terminal.parser` in TermWrap constructor
- "Reinit Wave" event destroys/recreates terminal, bridge is lost on the new instance

### 4. Prototype patch BEFORE loadAddon (CURRENT APPROACH - NEEDS TESTING)
- Patch `ImageAddon.prototype.activate` BEFORE calling `loadAddon`
- Bridge is registered during activate, before addon's internal state changes

### 5. Swapping internal parser with public parser (FAILED)
- Temporarily set `terminal._core._inputHandler._parser = publicParser` during activate
- Caused infinite recursion: `Maximum call stack size exceeded`
- Public parser's `registerOscHandler` wraps handler and delegates to internal parser

### 6. Re-registering handler object on public parser (FAILED)
- Public parser's `registerOscHandler` expects `(data: string) => boolean`
- IIP handler is an object with `start/put/end` lifecycle methods
- `this._handler is not a function` error when parser tries to call `end()`

## Key Files

| File | Purpose |
|------|---------|
| `frontend/app/view/term/termwrap.ts` | Terminal wrapper, ImageAddon loading, bridge registration |
| `frontend/app/view/term/term.tsx` | Terminal component |
| `node_modules/@xterm/addon-image/lib/addon-image.mjs` | Minified addon source |
| `node_modules/@xterm/xterm/lib/xterm.mjs` | Minified xterm.js source |

## Key Code Paths

### ImageAddon activation (addon-image.mjs)
```javascript
activate(e) {
    // e = terminal instance
    this._renderer = new T(e);           // T = ImageRenderer (DOM layer)
    this._storage = new ie(e, ...);      // ie = ImageStorage
    
    // Sixel handler - WORKS
    e._core._inputHandler._parser.registerDcsHandler({final:"q"}, sixelHandler);
    
    // IIP handler - DOES NOT FIRE
    e._core._inputHandler._parser.registerOscHandler(1337, iipHandler);
    
    // IIP handler class (Ae) has lifecycle:
    // start() - reset state
    // put(data, start, end) - accumulate base64 data
    // end(success) - decode and create image
}
```

### Public parser registration (xterm.js)
```javascript
// terminal.parser.registerOscHandler wraps in OscHandler class
registerOscHandler(id, callback) {
    return this._parser.registerOscHandler(id, new OscHandler(callback));
}
```

## Reinit Wave

WaveTerm has a "Reinit Wave" event during startup that re-initializes the UI. This may destroy/recreate the terminal instance. Need to verify if the terminal object survives or is replaced.

## Open Questions for Research

1. **Why does Sixel work but IIP doesn't?** Both register on the internal parser. DCS vs OSC handling must differ in how they route through the public parser wrapper.

2. **Can we intercept at the write level instead of parser level?** Override `terminal.write()` to detect IIP sequences and handle them before the parser sees them.

3. **Is there a way to make public and internal parsers share handlers?** The public parser wraps `registerOscHandler` in `OscHandler` which wraps in another class. Can we hook into this chain?

4. **Does xterm.js 6.1.0 have a fix for this?** Check if `terminal.parser.registerOscHandler` properly delegates to the same internal parser that `terminal.write()` uses.

5. **Can we patch `terminal.write()` to call the IIP handler directly?** Detect `\x1b]1337;File=` in the data and manually invoke the IIP handler's lifecycle.

## Branch

`feat/image-rendering-support` in `/home/mimo-code/project/waveterm-remote-image-rendering`

## npm package (for pi extension)

Published: `@whoisjeremylam/pi-waveterm-images@1.0.1`
- Detects `TERM_PROGRAM=waveterm`
- Enables kitty protocol via `setCapabilities()`
- Requires the WaveTerm fork with ImageAddon
