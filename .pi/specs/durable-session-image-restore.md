# Durable Session Image Restore

## Problem

When WaveTerm restarts, it restores terminal state from a cache file using `SerializeAddon.serialize()`. This produces a plain ANSI escape-sequence string representing text and SGR attributes. Image cell markers (`imageId`/`tileId` in `ExtendedAttrsImage`) are invisible to the serializer because:

1. `SerializeAddon` uses the public `IBufferCell` interface which does not expose `extended` attrs
2. Image pixel data (`HTMLCanvasElement`, `ImageBitmap`) is purely in-memory and cannot be serialized to a string
3. The restore path (`terminal.write(ANSI_string)`) never re-emits image protocol sequences (OSC 1337, DCS SIXEL, APC Kitty)

Result: all images disappear after WaveTerm restart.

## Approach: Content-Addressable Image Cache + Sidecar Manifest

Images are stored as individual content-addressed zone files. A lightweight manifest tracks which images are displayed and where. Image pixel data is written immediately on first encounter (no loss window). The manifest is rewritten on the 5s idle cycle to capture current positions (which shift as content scrolls).

```
Image added (immediate, async):
  onImageAdded hook
    └── convert to base64 PNG → hash → write to cache:term:img:<hash> (once per unique image)

Capture (every 5s idle):
  processAndCacheData()
    ├── serializeAddon.serialize()      →  cache:term:full (existing)
    └── exportManifest()
          └── walk buffer → positions → rewrite cache:term:images (manifest, ~KB)

Restore (on restart):
  loadInitialTerminalData()
    ├── fetchWaveFile("cache:term:full")    →  doTerminalWrite() (existing)
    ├── fetchWaveFile("cache:term:images")  →  manifest
    │     └── for each image: fetchWaveFile("cache:term:img:<hash>") → importImages()
    └── fetchWaveFile("term")               →  doTerminalWrite() (existing)
```

**Why split the writes**: The ANSI state (`cache:term:full`) is a monolithic string that must be re-serialized from the entire buffer each time — can't incrementally update. Image assets are independent files that can be written once and referenced by hash. Writing assets immediately eliminates the 5s crash-loss window. The manifest is cheap to rewrite (~120 bytes/entry) and needs to capture current buffer positions, which shift as content scrolls.

## Data Format

### Manifest: `cache:term:images`

```json
{
  "version": 1,
  "images": [
    {
      "hash": "a1b2c3d4",
      "row": 15,
      "col": 0,
      "width": 1344,
      "height": 472,
      "layer": "top",
      "zIndex": 0,
      "scrolling": true,
      "cursorPos": "iip"
    }
  ]
}
```

The manifest is small: no inline pixel data. Each entry is ~120 bytes of JSON.

### Image file: `cache:term:img:<hash>`

Raw base64-encoded PNG data. One file per unique image. Content-addressed: same image data always produces the same hash, so identical images are stored once.

### Hash computation

Hash is the first 8 hex characters (32 bits) of a simple hash of the base64 PNG string. Not cryptographic — just fast dedup. Collision probability is negligible for typical terminal usage (a few images).

```typescript
function hashImageData(b64: string): string {
    let hash = 0;
    for (let i = 0; i < b64.length; i++) {
        hash = ((hash << 5) - hash + b64.charCodeAt(i)) | 0;
    }
    // Convert to unsigned hex, pad to 8 chars
    return (hash >>> 0).toString(16).padStart(8, '0');
}
```

## Implementation

### Step 1: Add `exportImages()` and `exportManifest()` to ImageStorage

**File**: `patches/@xterm+addon-image+0.10.0-beta.287.patch` (extend existing patch)

`exportImages()` — called on image addition, returns pixel data for new images only:

```typescript
public exportImages(): ISavedImage[] {
    const images: ISavedImage[] = [];
    const seen = new Set<number>();
    const buffer = this._terminal._core.buffer;
    const rows = buffer.lines.length;

    for (let y = 0; y < rows; y++) {
        const line = buffer.lines.get(y) as IBufferLineExt;
        if (!line) continue;
        for (let x = 0; x < this._terminal.cols; x++) {
            const e = line._extendedAttrs[x] as IExtendedAttrsImage | undefined;
            if (!e || e.imageId === undefined || e.imageId === -1) continue;
            if (seen.has(e.imageId)) continue;

            const spec = this._images.get(e.imageId);
            if (!spec || !spec.orig) continue;

            const b64 = canvasToPngBase64(spec.orig);
            if (!b64) continue;

            seen.add(e.imageId);
            images.push({
                hash: hashImageData(b64),
                data: b64,
                row: y,
                col: x,
                width: spec.orig.width,
                height: spec.orig.height,
                layer: spec.layer,
                zIndex: spec.zIndex,
                scrolling: true,
                cursorPos: 'iip'
            });
        }
    }
    return images;
}
```

`exportManifest()` — called on 5s timer, returns only position metadata (no pixel data):

```typescript
public exportManifest(): ISavedImageMeta[] {
    const images: ISavedImageMeta[] = [];
    const seen = new Set<number>();
    const buffer = this._terminal._core.buffer;
    const rows = buffer.lines.length;

    for (let y = 0; y < rows; y++) {
        const line = buffer.lines.get(y) as IBufferLineExt;
        if (!line) continue;
        for (let x = 0; x < this._terminal.cols; x++) {
            const e = line._extendedAttrs[x] as IExtendedAttrsImage | undefined;
            if (!e || e.imageId === undefined || e.imageId === -1) continue;
            if (seen.has(e.imageId)) continue;

            const spec = this._images.get(e.imageId);
            if (!spec || !spec.orig) continue;

            // Compute hash from orig without materializing full base64
            const b64 = canvasToPngBase64(spec.orig);
            if (!b64) continue;

            seen.add(e.imageId);
            images.push({
                hash: hashImageData(b64),
                row: y,
                col: x,
                width: spec.orig.width,
                height: spec.orig.height,
                layer: spec.layer,
                zIndex: spec.zIndex,
                scrolling: true,
                cursorPos: 'iip'
            });
        }
    }
    return images;
}
```

Interfaces:

```typescript
interface ISavedImage extends ISavedImageMeta {
    data: string;       // base64 PNG (only present for new asset writes)
}

interface ISavedImageMeta {
    hash: string;       // content-address key
    row: number;
    col: number;
    width: number;
    height: number;
    layer: string;
    zIndex: number;
    scrolling: boolean;
    cursorPos: string;
}
```

Note: `exportManifest()` still calls `canvasToPngBase64` to compute the hash. This is the CPU cost — but it avoids storing a separate hash map. If profiling shows this is expensive, a `Map<number, string>` cache of imageId→hash can be added later.

### Step 2: Add `importImages()` to ImageStorage

**File**: `patches/@xterm+addon-image+0.10.0-beta.287.patch` (extend existing patch)

```typescript
public async importImages(images: ISavedImageWithCanvas[]): Promise<void> {
    if (!images || !images.length) return;
    const buffer = this._terminal._core.buffer;
    const savedX = buffer.x;
    const savedY = buffer.y;

    for (const img of images) {
        if (img.row < 0 || img.row >= buffer.lines.length) continue;
        if (!img.canvas) continue;

        const viewportRow = img.row - buffer.ybase;
        if (viewportRow < 0 || viewportRow >= this._terminal.rows) continue;
        buffer.x = img.col;
        buffer.y = viewportRow;

        this.addImage(img.canvas, {
            scrolling: img.scrolling,
            layer: img.layer as any,
            zIndex: img.zIndex,
            cursorPos: img.cursorPos as any
        });
    }

    buffer.x = savedX;
    buffer.y = savedY;
}
```

The import caller is responsible for decoding PNG to canvas before calling `importImages`. This keeps ImageStorage free of async fetch logic.

### Step 3: Backend RPCs

**File**: `pkg/service/blockservice/blockservice.go`

```go
func (*BlockService) SaveTerminalImages_Meta() tsgenmeta.MethodMeta {
    return tsgenmeta.MethodMeta{
        Desc:     "save image manifest for terminal state restore",
        ArgNames: []string{"ctx", "blockId", "manifest"},
    }
}

func (bs *BlockService) SaveTerminalImages(ctx context.Context, blockId string, manifest string) error {
    _, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
    if err != nil {
        return err
    }
    filestore.WFS.MakeFile(ctx, blockId, "cache:term:images", nil, wshrpc.FileOpts{})
    return filestore.WFS.WriteFile(ctx, blockId, "cache:term:images", []byte(manifest))
}

func (*BlockService) SaveImageAsset_Meta() tsgenmeta.MethodMeta {
    return tsgenmeta.MethodMeta{
        Desc:     "save a single image asset (content-addressed)",
        ArgNames: []string{"ctx", "blockId", "name", "data"},
    }
}

func (bs *BlockService) SaveImageAsset(ctx context.Context, blockId string, name string, data string) error {
    _, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
    if err != nil {
        return err
    }
    fileName := "cache:term:img:" + name
    filestore.WFS.MakeFile(ctx, blockId, fileName, nil, wshrpc.FileOpts{})
    return filestore.WFS.WriteFile(ctx, blockId, fileName, []byte(data))
}
```

**File**: `frontend/app/store/services.ts` — add:

```typescript
SaveTerminalImages(blockId: string, manifest: string): Promise<void> {
    return callBackendService(this?.waveEnv, "block", "SaveTerminalImages", Array.from(arguments));
}
SaveImageAsset(blockId: string, name: string, data: string): Promise<void> {
    return callBackendService(this?.waveEnv, "block", "SaveImageAsset", Array.from(arguments));
}
```

### Step 4: Immediate asset write on image addition

**File**: `frontend/app/view/term/termwrap.ts`

Hook into the image addon's `onImageAdded` event during `activateImageAddon()`. When a new image appears, immediately write its asset file (async, fire-and-forget).

```typescript
// In activateImageAddon(), after loadAddon():
this.imageAddon.onImageAdded(() => this.writeNewImageAssets());
```

```typescript
private _writtenImageHashes = new Set<string>();

private async writeNewImageAssets(): Promise<void> {
    if (!this.imageAddon) return;
    try {
        const storage = (this.imageAddon as any)._storage;
        if (!storage?.exportImages) return;

        const images = storage.exportImages();
        for (const img of images) {
            if (this._writtenImageHashes.has(img.hash)) continue;
            this._writtenImageHashes.add(img.hash);
            fireAndForget(() =>
                services.BlockService.SaveImageAsset(this.blockId, img.hash, img.data)
            );
        }
    } catch (e) {
        console.warn("[IIP-FIX] Failed to write image asset:", e);
    }
}
```

The `_writtenImageHashes` set prevents redundant RPC calls for images that were already written. It's per-TermWrap instance and cleared on dispose.

### Step 5: Manifest write on 5s idle timer

**File**: `frontend/app/view/term/termwrap.ts`

Modify `processAndCacheData()` to also export the manifest:

```typescript
processAndCacheData() {
    if (this.dataBytesProcessed < MinDataProcessedForCache) {
        return;
    }
    const serializedOutput = this.serializeAddon.serialize();
    const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
    const decModes = this.serializeDecModes();
    fireAndForget(() =>
        services.BlockService.SaveTerminalState(this.blockId, serializedOutput, "full", this.ptyOffset, termSize, decModes)
    );

    // Write image manifest (positions only, no pixel data)
    this.writeImageManifest();

    this.dataBytesProcessed = 0;
}

private writeImageManifest(): void {
    if (!this.imageAddon) return;
    try {
        const storage = (this.imageAddon as any)._storage;
        if (!storage?.exportManifest) return;

        const manifest = {
            version: 1,
            images: storage.exportManifest()
        };
        fireAndForget(() =>
            services.BlockService.SaveTerminalImages(this.blockId, JSON.stringify(manifest))
        );
    } catch (e) {
        console.warn("[IIP-FIX] Failed to write image manifest:", e);
    }
}
```

### Step 6: Modify `loadInitialTerminalData()` in termwrap.ts

**File**: `frontend/app/view/term/termwrap.ts`

```typescript
async loadInitialTerminalData(): Promise<void> {
    const startTs = Date.now();
    const zoneId = this.getZoneId();
    const { data: cacheData, fileInfo: cacheFile } = await fetchWaveFile(zoneId, TermCacheFileName);
    let ptyOffset = 0;
    if (cacheFile != null) {
        ptyOffset = cacheFile.meta["ptyoffset"] ?? 0;
        if (cacheData.byteLength > 0) {
            const curTermSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
            const fileTermSize: TermSize = cacheFile.meta["termsize"];
            let didResize = false;
            if (
                fileTermSize != null &&
                (fileTermSize.rows != curTermSize.rows || fileTermSize.cols != curTermSize.cols)
            ) {
                this.terminal.resize(fileTermSize.cols, fileTermSize.rows);
                didResize = true;
            }
            this.doTerminalWrite(cacheData, ptyOffset);
            if (didResize) {
                this.terminal.resize(curTermSize.cols, curTermSize.rows);
            }
        }
        const decModes = cacheFile.meta["decmodes"] as string;
        if (decModes) {
            this.replayDecModes(decModes);
        }

        // Restore images
        await this.restoreImages();
    }
    const { data: mainData, fileInfo: mainFile } = await fetchWaveFile(zoneId, TermFileName, ptyOffset);
    if (mainFile != null) {
        await this.doTerminalWrite(mainData, null);
    }
}

private async restoreImages(): Promise<void> {
    if (!this.imageAddon) return;
    try {
        const zoneId = this.getZoneId();
        const { data: manifestData } = await fetchWaveFile(zoneId, "cache:term:images");
        if (!manifestData || manifestData.byteLength === 0) return;

        const manifest = JSON.parse(new TextDecoder().decode(manifestData));
        if (manifest.version !== 1 || !Array.isArray(manifest.images)) return;

        // Fetch image assets and decode
        const decoded: ISavedImageWithCanvas[] = [];
        for (const entry of manifest.images) {
            const { data: imgData } = await fetchWaveFile(zoneId, "cache:term:img:" + entry.hash);
            if (!imgData || imgData.byteLength === 0) continue;

            const b64 = new TextDecoder().decode(imgData);
            const canvas = await decodePngBase64(b64, entry.width, entry.height);
            if (!canvas) continue;

            decoded.push({ ...entry, canvas });
        }

        const storage = (this.imageAddon as any)._storage;
        if (storage?.importImages && decoded.length > 0) {
            await storage.importImages(decoded);
            console.log(`[IIP-FIX] Restored ${decoded.length} images from cache`);
        }
    } catch (e) {
        console.warn("[IIP-FIX] Failed to restore images:", e);
    }
}
```

Helper (in termwrap.ts or a shared util):

```typescript
async function decodePngBase64(b64: string, w: number, h: number): Promise<HTMLCanvasElement | null> {
    try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/png' });
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')?.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        return canvas;
    } catch {
        return null;
    }
}

function hashImageData(b64: string): string {
    let hash = 0;
    for (let i = 0; i < b64.length; i++) {
        hash = ((hash << 5) - hash + b64.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
```

### Step 7: Store `imageAddon` reference in termwrap

Ensure `this.imageAddon` is accessible as a class property. Verify it's set during `activateImageAddon()`.

## Write Behavior

| Scenario | What gets written |
|----------|-------------------|
| First image appears | Asset file (immediate) + manifest (on 5s timer) |
| Same image, unchanged | Nothing (hash already in `_writtenImageHashes`) |
| New image appears | New asset file (immediate) + updated manifest (on 5s timer) |
| Image scrolls out of buffer | Updated manifest only (entry removed) |
| No images in buffer | Empty manifest |
| WaveTerm crashes within 5s of image add | Asset exists on disk but manifest doesn't reference it yet — orphaned, harmless |
| WaveTerm restart | Nothing written until first image addition or cache cycle |

## Edge Cases

1. **Scrollback eviction**: Images whose rows have been evicted from the buffer (`row >= buffer.lines.length`) are skipped during import
2. **Alternate buffer**: Only normal buffer images are exported (the `_images` map tracks `bufferType`)
3. **Multiple images**: Each unique `imageId` is exported once with its top-left position
4. **Overlapping text**: Images rendered on top of text — text cells are not modified by `addImage`, only `_extendedAttrs` is set
5. **Terminal resize during restore**: Images are imported after cache replay but before main data; terminal may be temporarily resized to match cache dimensions (existing behavior)
6. **PNG decode failure**: `decodePngBase64` catches errors and returns null; failed images are silently skipped
7. **Empty manifest**: If `cache:term:images` doesn't exist or has zero images, import is a no-op
8. **Orphaned image assets**: Old image files that are no longer referenced by any manifest are not cleaned up automatically. Acceptable for typical usage; cleanup can be added later if disk usage is a concern
9. **Hash collision**: Probability negligible for typical usage (a few images per terminal). If collision occurs, the wrong image displays — acceptable tradeoff vs cryptographic hashing overhead

## Test Cases

### Unit Tests

**File**: `frontend/app/view/term/image-restore.test.ts`

```typescript
describe('Image Restore (Durable Session)', () => {

    test('exportImages returns empty array when no images exist', () => {
        // Setup: buffer with no image markers
        // Act: call exportImages()
        // Assert: returns []
    });

    test('exportImages captures single image at correct position', () => {
        // Setup: buffer with one image (imageId=1, tileId=0-9 at row 5, col 0)
        // Mock: _images.set(1, { orig: canvas, ... })
        // Act: call exportImages()
        // Assert: returns array with one entry, row=5, col=0, hash is valid hex, data is base64
    });

    test('exportImages captures multiple images with different hashes', () => {
        // Setup: buffer with two different images
        // Act: call exportImages()
        // Assert: returns two entries with different hashes
    });

    test('exportImages deduplicates same image at multiple positions', () => {
        // Setup: buffer with same imageId spanning multiple rows
        // Act: call exportImages()
        // Assert: returns one entry (first tile position)
    });

    test('exportImages skips images scrolled out of buffer', () => {
        // Setup: _images has entry but no cells in buffer reference it
        // Act: call exportImages()
        // Assert: returns []
    });

    test('hashImageData produces consistent hashes', () => {
        // Act: hashImageData("abc123") twice
        // Assert: same result both times
    });

    test('hashImageData produces different hashes for different data', () => {
        // Act: hashImageData("abc"), hashImageData("def")
        // Assert: different results
    });

    test('importImages restores image at correct buffer position', () => {
        // Setup: empty buffer, mock addImage
        // Act: importImages([{ row: 5, col: 0, canvas: canvas, ... }])
        // Assert: addImage called with correct canvas, cursor at (0, 5)
    });

    test('importImages restores multiple images in order', () => {
        // Setup: empty buffer
        // Act: importImages with 3 images at rows 2, 5, 8
        // Assert: addImage called 3 times at correct positions
    });

    test('importImages skips images with row out of buffer range', () => {
        // Setup: buffer with 10 lines
        // Act: importImages([{ row: 100, canvas: ... }])
        // Assert: addImage not called
    });

    test('importImages restores cursor position after import', () => {
        // Setup: buffer with cursor at (10, 3)
        // Act: importImages with image at row 5
        // Assert: cursor returns to (10, 3)
    });

    test('importImages handles null canvas gracefully', () => {
        // Act: importImages([{ canvas: null, ... }])
        // Assert: no error thrown, addImage not called
    });

    test('manifest strips data field from export', () => {
        // Setup: exportImages returns [{ hash, data, row, ... }]
        // Act: map to manifest format
        // Assert: manifest entries have no 'data' field
    });
});
```

### Integration Tests

1. **Full cycle**: Export → write asset + manifest → read back → import → verify images rendered
2. **Dedup**: Export same image twice → only one asset file written
3. **Round-trip with resize**: Export at 80x24, import at 120x40, verify images display correctly

### Manual Test Plan

1. Run `chafa --format=sixels ~/some-image.png` in a terminal block
2. Verify asset file appears immediately (check console log or file store)
3. Wait for cache save (5s idle) — verify manifest is written
4. Run same chafa command again — verify NO new asset file written (dedup via `_writtenImageHashes`)
5. Close WaveTerm completely
6. Restart WaveTerm
7. Verify the image is restored in the terminal
8. Repeat with `chafa --format=iterm2`
9. Test with multiple different images — verify each has its own asset file
10. Test with images that have partially scrolled out of buffer
11. Test with terminal resize between save and restore
12. Kill WaveTerm immediately after image appears (before 5s timer) — verify asset file exists but image is lost (manifest not yet written). On restart, no image restored (expected)
13. Check that only the manifest is rewritten on subsequent cache cycles (not image assets)

## Files Modified

| File | Change |
|------|--------|
| `patches/@xterm+addon-image+0.10.0-beta.287.patch` | Add `exportImages()`, `exportManifest()`, `importImages()`, interfaces, `hashImageData()`, `canvasToPngBase64()` to ImageStorage |
| `frontend/app/view/term/termwrap.ts` | Add `writeNewImageAssets()`, `writeImageManifest()`, `restoreImages()`, `decodePngBase64()`, `hashImageData()`; modify `processAndCacheData()` and `activateImageAddon()` |
| `pkg/service/blockservice/blockservice.go` | Add `SaveTerminalImages` + `SaveImageAsset` RPCs |
| `frontend/app/store/services.ts` | Add `SaveTerminalImages` + `SaveImageAsset` service methods |
| `frontend/app/view/term/image-restore.test.ts` | New test file |

## Regeneration

After modifying the addon patch:
```bash
cd /home/mimo-code/project/waveterm-remote-image-rendering
npx patch-package @xterm/addon-image
```

## Out of Scope

- Kitty protocol image restore (separate `KittyImageStorage` with different data structure; can be added later)
- Image restore across different terminal sizes (images are restored at original pixel dimensions, addImage recomputes cell allocation)
- Orphaned asset cleanup (old assets that are no longer referenced; can be added later if disk usage is a concern)
- Streaming image restore (all images are imported after ANSI replay completes)
