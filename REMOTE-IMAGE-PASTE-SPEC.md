# Spec: Remote File Transfer for WaveTerm

## Problem

When a user pastes an image or drag-drops files into a WaveTerm terminal connected to a remote machine via SSH, the files are saved to **local** temp files and local paths are pasted into the terminal. These paths don't exist on the remote machine, so tools like Pi (and any other terminal application) can't access them.

**Current flow:**
1. User pastes image → `termwrap.ts:677` `pasteHandler()` extracts image
2. `termutil.ts:81` `createTempFileFromBlob()` saves to LOCAL temp path (`/var/folders/.../waveterm_paste_*.png`)
3. Local path is pasted into terminal as text
4. Remote application sees path but can't read it (file doesn't exist on remote)

Same issue for drag-drop: `getApi().getPathForFile(file)` returns a local path.

**Goal:** When connected to a remote machine, transfer files to the **remote** machine and paste the remote path. Works for:
- **Image paste** (Cmd+V with image in clipboard) — transfer image binary to remote
- **Image drag-drop** — transfer image to remote
- **Any file drag-drop** — transfer file to remote (scripts, text files, etc.)
- **Non-remote connections** — unchanged (local temp paths work fine)

## Approach

Add a new Go RPC command `RemoteWriteTempFileCommand` that writes a temp file on the remote machine via the existing SSH RPC routing, then modify the frontend paste/drag-drop handlers to use this command for SSH connections.

The command dispatch is automatic: add a method to `WshRpcRemoteFileInterface`, implement it on `ServerImpl`, and the system auto-registers it by lowercasing the method name (e.g., `RemoteWriteTempFileCommand` → `remotewritetempfile`).

### Compatibility

This is **application-agnostic** — it transfers files and pastes paths. Any terminal application (Pi, vim, htop, bash, etc.) that can read files will benefit. No application-specific integration needed.

## UX: Upload Feedback and Input Suppression

When a file is being uploaded to the remote, the user must not see a frozen terminal. Two mechanisms:

1. **Upload overlay** — A semi-transparent overlay inside the block frame (same pattern as `ConnStatusOverlay`) shows "Uploading file..." with a spinner. Blocks the terminal content visually so the user knows something is happening.
2. **Input suppression** — Keyboard input is dropped during upload so the user can't accidentally send keystrokes before the path is pasted.

The upload is synchronous: the path is only pasted into the terminal after the upload completes. The overlay disappears and the path appears atomically.

### Extensible Overlay Architecture

Rather than hardcoding upload overlays, we extract a generic `BlockOverlay` component from the `ConnStatusOverlay` pattern. This component handles:
- Positioning (absolute, top offset from header, full width)
- Styling (backdrop-blur, rounded corners, shadow, z-index)
- Accepts `children` for content

Both `ConnStatusOverlay` and `UploadOverlay` compose `BlockOverlay`. Future overlays (progress bars, file transfer status, etc.) can also compose it without duplicating positioning logic.

### Upload State

Upload state is tracked per-block via a Jotai atom on the `TermViewModel`:

```typescript
interface BlockUploadState {
    active: boolean;
    fileName: string;       // e.g. "screenshot.png"
    fileSize: number;       // bytes
}
```

- `termwrap.ts` sets the atom when upload starts (`active: true`) and clears it when done (`null`)
- `UploadOverlay` reads the atom and renders when `active` is true
- `handleTermData` checks the atom to suppress input during upload

## Files to Modify

### Backend (Go)

| File | Change |
|------|--------|
| `pkg/wshrpc/wshrpctypes.go` | Add `CommandRemoteWriteTempFileData` struct |
| `pkg/wshrpc/wshrpctypes_file.go` | Add `RemoteWriteTempFileCommand` to `WshRpcRemoteFileInterface` |
| `pkg/wshrpc/wshremote/wshremote_file.go` | Implement `RemoteWriteTempFileCommand` |
| `pkg/wshrpc/wshclient/wshclient.go` | Add client wrapper |

### Frontend (TypeScript)

| File | Change |
|------|--------|
| `frontend/app/store/wshclientapi.ts` | Add `RemoteWriteTempFileCommand` to `RpcApi` class |
| `frontend/app/view/term/termutil.ts` | Add `createRemoteTempFileFromBlob()` utility |
| `frontend/app/view/term/termwrap.ts` | Modify `pasteHandler()` and `dropHandler()` for remote connections; add upload state management; add `handleTermData` input guard |
| `frontend/app/view/term/term-model.ts` | Add `uploadState` atom to `TermViewModel` |
| `frontend/app/block/blockoverlay.tsx` | **New file** — generic `BlockOverlay` component |
| `frontend/app/block/uploadoverlay.tsx` | **New file** — `UploadOverlay` using `BlockOverlay` |
| `frontend/app/block/connstatusoverlay.tsx` | Refactor to use `BlockOverlay` (optional, can be done later) |
| `frontend/app/block/blockframe.tsx` | Mount `UploadOverlay` next to `ConnStatusOverlay` |

### Auto-generated

| File | Change |
|------|--------|
| `frontend/types/gotypes.d.ts` | Will be updated by `npm run gen` or `task gen` |

## Detailed Changes

### 1. Go Types — `pkg/wshrpc/wshrpctypes.go`

Add after `CommandWriteTempFileData` (line ~350):

```go
// CommandRemoteWriteTempFileData writes any file to a temp directory on the remote machine.
// Used for transferring images, scripts, or any file from local to remote via drag-drop or paste.
type CommandRemoteWriteTempFileData struct {
    FileName string `json:"filename"`
    Data64   string `json:"data64"`
}
```

### 2. Go Interface — `pkg/wshrpc/wshrpctypes_file.go`

Add to `WshRpcRemoteFileInterface` (line ~39):

```go
RemoteWriteTempFileCommand(ctx context.Context, data CommandRemoteWriteTempFileData) (string, error)
```

### 3. Go Implementation — `pkg/wshrpc/wshremote/wshremote_file.go`

Add new function (model after `RemoteWriteFileCommand` at line 480, and local `WriteTempFileCommand`):

```go
func (*ServerImpl) RemoteWriteTempFileCommand(ctx context.Context, data wshrpc.CommandRemoteWriteTempFileData) (string, error) {
    if data.FileName == "" {
        return "", fmt.Errorf("filename is required")
    }
    name := filepath.Base(data.FileName)
    if name == "" || name == "." || name == ".." {
        return "", fmt.Errorf("invalid filename")
    }
    tempDir, err := os.MkdirTemp("", "waveterm-")
    if err != nil {
        return "", fmt.Errorf("error creating temp directory: %w", err)
    }
    decoded, err := base64.StdEncoding.DecodeString(data.Data64)
    if err != nil {
        return "", fmt.Errorf("error decoding base64 data: %w", err)
    }
    tempPath := filepath.Join(tempDir, name)
    err = os.WriteFile(tempPath, decoded, 0600)
    if err != nil {
        return "", fmt.Errorf("error writing temp file: %w", err)
    }
    return tempPath, nil
}
```

### 4. Go Client — `pkg/wshrpc/wshclient/wshclient.go`

Add near `RemoteWriteFileCommand` (line ~751):

```go
// command "remotewritetempfile", wshserver.RemoteWriteTempFileCommand
func RemoteWriteTempFileCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteWriteTempFileData, opts *wshrpc.RpcOpts) (string, error) {
    resp, err := sendRpcRequestCallHelper[string](w, "remotewritetempfile", data, opts)
    return resp, err
}
```

### 5. Frontend RPC API — `frontend/app/store/wshclientapi.ts`

Add near `RemoteWriteFileCommand` (line ~757):

```typescript
// command "remotewritetempfile" [call]
RemoteWriteTempFileCommand(client: WshClient, data: CommandRemoteWriteTempFileData, opts?: RpcOpts): Promise<string> {
    if (this.mockClient) return this.mockClient.mockWshRpcCall(client, "remotewritetempfile", data, opts);
    return client.wshRpcCall("remotewritetempfile", data, opts);
}
```

### 6. Frontend Utility — `frontend/app/view/term/termutil.ts`

Add new function after `createTempFileFromBlob` (line ~114):

```typescript
export async function createRemoteTempFileFromBlob(blob: Blob): Promise<string> {
    if (blob.size > 5 * 1024 * 1024) {
        throw new Error("Image too large (>5MB)");
    }
    if (!blob.type.startsWith("image/") || !MIME_TO_EXT[blob.type]) {
        throw new Error(`Unsupported or invalid image type: ${blob.type}`);
    }
    const ext = MIME_TO_EXT[blob.type];
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const filename = `waveterm_paste_${timestamp}_${random}.${ext}`;

    const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
    });

    const base64Data = base64.fromByteArray(new Uint8Array(arrayBuffer));

    // Write to remote temp file via SSH RPC
    const tempPath = await RpcApi.RemoteWriteTempFileCommand(TabRpcClient, {
        filename,
        data64: base64Data,
    });

    return tempPath;
}
```

### 6. Generic Block Overlay — `frontend/app/block/blockoverlay.tsx` (NEW)

Extract the shared positioning/styling from `ConnStatusOverlay` into a reusable component. This is the foundation for all block-level overlays (connection status, upload progress, future file transfer status, etc.).

```tsx
import * as React from "react";

interface BlockOverlayProps {
    children: React.ReactNode;
    className?: string;
}

/**
 * Generic overlay positioned inside a block frame, below the header.
 * Handles absolute positioning, z-index, backdrop-blur, and rounded corners.
 * Compose with specific content (upload status, connection status, etc.).
 *
 * For future extensibility: add props for position, variant (warning/error/info),
 * dismiss button, progress bar, etc. as new overlay types need them.
 */
export const BlockOverlay = React.memo(({ children, className }: BlockOverlayProps) => {
    return (
        <div
            className={`@container absolute top-[calc(var(--header-height)+6px)] left-1.5 right-1.5 z-[var(--zindex-block-mask-inner)] overflow-hidden rounded-md bg-[var(--conn-status-overlay-bg-color)] backdrop-blur-[50px] shadow-lg opacity-90 ${className ?? ""}`}
        >
            <div className="flex items-center gap-3 w-full pt-2.5 pb-2.5 pr-2 pl-3">
                {children}
            </div>
        </div>
    );
});
BlockOverlay.displayName = "BlockOverlay";
```

Note: The CSS classes are identical to `ConnStatusOverlay`'s current classes (e.g., `connstatusoverlay.tsx:92`). This ensures visual consistency. The `BlockOverlay` component is intentionally minimal — it only handles positioning and the shared shell. Content (icons, text, buttons, progress bars) is provided by the consumer.

### 6a. Upload Overlay — `frontend/app/block/uploadoverlay.tsx` (NEW)

```tsx
import { BlockOverlay } from "./blockoverlay";
import * as jotai from "jotai";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { BlockEnv } from "./blockenv";
import { NodeModel } from "@/layout/index";

interface UploadOverlayProps {
    nodeModel: NodeModel;
}

export const UploadOverlay = React.memo(({ nodeModel }: UploadOverlayProps) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const uploadState = jotai.useAtomValue(waveEnv.getBlockUploadStateAtom(nodeModel.blockId));

    if (!uploadState?.active) {
        return null;
    }

    return (
        <BlockOverlay>
            <i className="fa-solid fa-spinner fa-spin text-info text-base shrink-0" title="Uploading"></i>
            <div className="text-[11px] font-semibold leading-4 tracking-[0.11px] text-white min-w-0 flex-1 break-words @max-xxs:hidden">
                Uploading {uploadState.fileName}…
            </div>
            <div className="flex-1 hidden @max-xxs:block"></div>
        </BlockOverlay>
    );
});
UploadOverlay.displayName = "UploadOverlay";
```

**Future extensibility:** When adding real progress (bytes transferred, percentage), change `BlockUploadState` to include `bytesTransferred` and `totalBytes`, and render a progress bar inside `BlockOverlay`. The overlay component and atom shape are designed to support this without architectural changes.

### 6b. Upload State Atom — `frontend/app/view/term/term-model.ts`

Add to `TermViewModel`:

```typescript
uploadState: jotai.PrimitiveAtom<BlockUploadState | null>;
```

Initialize in constructor:

```typescript
this.uploadState = jotai.atom<BlockUploadState | null>(null) as jotai.PrimitiveAtom<BlockUploadState | null>;
```

Also expose via `waveEnv` so the overlay can access it:

```typescript
// In waveenv or global.ts, add a getter:
getBlockUploadStateAtom(blockId: string): jotai.Atom<BlockUploadState | null> {
    // Returns the uploadState atom for the given block's TermViewModel
}
```

The exact wiring depends on how `waveEnv` resolves view model atoms. Alternative: use a global `Map<string, PrimitiveAtom<BlockUploadState | null>>` keyed by blockId, similar to how `getBlockTermDurableAtom` works.

### 6c. Input Suppression — `frontend/app/view/term/termwrap.ts`

Add `uploadActive` flag (alongside existing `pasteActive`):

```typescript
uploadActive: boolean = false;
```

Modify `handleTermData` (line ~497) to gate on upload state:

```typescript
handleTermData(data: string) {
    if (!this.loaded) {
        return;
    }
    if (this.uploadActive) {
        return; // Suppress input during file upload
    }
    this.sendDataHandler?.(data);
    this.multiInputCallback?.(data);
}
```

Set/clear `uploadActive` in paste and drop handlers:

```typescript
// In pasteHandler:
this.uploadActive = true;
globalStore.set(this.viewModel.uploadState, { active: true, fileName: "...", fileSize: ... });
try {
    // ... upload logic ...
} finally {
    this.uploadActive = false;
    globalStore.set(this.viewModel.uploadState, null);
    setTimeout(() => { this.pasteActive = false; }, 30);
}

// Same pattern in dropHandler
```

### 7. Frontend Paste Handler — `frontend/app/view/term/termwrap.ts`

**Add imports** (top of file):

```typescript
import { getBlockMetaKeyAtom } from "@/store/global";
import { isSshConnName } from "@/util/util";
```

And import the new utility in the existing termutil import:

```typescript
import { createRemoteTempFileFromBlob, createTempFileFromBlob, ... } from "./termutil";
```

**Modify `pasteHandler()`** (line ~677):

Replace the image handling block (lines 686-692). Note the upload state management — overlay appears on `uploadActive = true`, disappears on `uploadActive = false`:

```typescript
if (data.image && SupportsImageInput) {
    if (!firstImage) {
        await new Promise((r) => setTimeout(r, 150));
    }
    const connName = globalStore.get(getBlockMetaKeyAtom(this.blockId, "connection")) ?? "";
    const isRemote = isSshConnName(connName);
    if (isRemote) {
        this.uploadActive = true;
        const fileName = `screenshot_${Date.now()}.png`;
        globalStore.set(this.viewModel.uploadState, { active: true, fileName, fileSize: data.image.size });
        try {
            const tempPath = await createRemoteTempFileFromBlob(data.image);
            this.terminal.paste(tempPath + " ");
        } catch (err) {
            console.error("Failed to upload image to remote:", err);
        } finally {
            this.uploadActive = false;
            globalStore.set(this.viewModel.uploadState, null);
        }
    } else {
        const tempPath = await createTempFileFromBlob(data.image);
        this.terminal.paste(tempPath + " ");
    }
    firstImage = false;
}
```

### 7. Frontend Drop Handler — `frontend/app/view/term/termwrap.ts`

**Modify `dropHandler()`** (line ~323):

Transfer **all** files to remote on drag-drop (not just images). Sets upload state so the overlay appears during each file transfer:

```typescript
const dropHandler = async (e: DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) {
        return;
    }
    const connName = globalStore.get(getBlockMetaKeyAtom(this.blockId, "connection")) ?? "";
    const isRemote = isSshConnName(connName);

    const parts: string[] = [];
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        if (isRemote) {
            this.uploadActive = true;
            globalStore.set(this.viewModel.uploadState, { active: true, fileName: file.name, fileSize: file.size });
            try {
                const tempPath = await createRemoteTempFileFromBlob(file);
                parts.push(quoteForPosixShell(tempPath));
            } catch (err) {
                console.error("Failed to transfer file to remote:", err);
            } finally {
                this.uploadActive = false;
                globalStore.set(this.viewModel.uploadState, null);
            }
        } else {
            const filePath = getApi().getPathForFile(file);
            if (filePath) {
                parts.push(quoteForPosixShell(filePath));
            }
        }
    }
    if (parts.length > 0) {
        this.terminal.paste(parts.join(" ") + " ");
    }
};
```

Note: `dropHandler` becomes async. The `addEventListener` call stays the same since async event handlers work fine.

### 8. Frontend Utility — `frontend/app/view/term/termutil.ts`

**Modify `createRemoteTempFileFromBlob()`** to accept any `Blob`, not just images:

```typescript
export async function createRemoteTempFileFromBlob(blob: Blob, fileName?: string): Promise<string> {
    if (blob.size > 50 * 1024 * 1024) {
        throw new Error("File too large (>50MB)");
    }

    // Generate filename if not provided
    if (!fileName) {
        const ext = MIME_TO_EXT[blob.type] || "bin";
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        fileName = `waveterm_paste_${timestamp}_${random}.${ext}`;
    }

    const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
    });

    const base64Data = base64.fromByteArray(new Uint8Array(arrayBuffer));

    // Write to remote temp file via SSH RPC
    const tempPath = await RpcApi.RemoteWriteTempFileCommand(TabRpcClient, {
        filename: fileName,
        data64: base64Data,
    });

    return tempPath;
}
```

Note: Size limit increased from 5MB to 50MB since this now handles any file type. Images still get auto-resized by the existing pipeline before reaching this function.

## Implementation Order

1. `git checkout -b feature/remote-image-paste` (already done)
2. Add Go types (`CommandRemoteWriteTempFileData`)
3. Add to `WshRpcRemoteFileInterface`
4. Implement `RemoteWriteTempFileCommand` in `wshremote_file.go`
5. Add client wrapper in `wshclient.go`
6. Run codegen (`npm run gen` or `task gen`) to update `gotypes.d.ts`
7. Add `RemoteWriteTempFileCommand` to frontend `RpcApi`
8. Create `BlockOverlay` component (`blockoverlay.tsx`)
9. Add upload state type and atom to `TermViewModel`
10. Expose `getBlockUploadStateAtom` via `waveEnv`
11. Create `UploadOverlay` component (`uploadoverlay.tsx`)
12. Mount `UploadOverlay` in `blockframe.tsx`
13. Add `uploadActive` flag and `handleTermData` guard in `termwrap.ts`
14. Add `createRemoteTempFileFromBlob()` in `termutil.ts` (accepts any Blob)
15. Modify `pasteHandler()` in `termwrap.ts` — set upload state, use remote upload for SSH
16. Modify `dropHandler()` in `termwrap.ts` — set upload state, use remote upload for SSH
17. Test upload overlay appears and disappears correctly
18. Test input suppression during upload
19. Test local/WSL regression (no overlay, no input suppression)

## Architecture Context

### How Remote RPC Dispatch Works

Commands are dispatched automatically based on method naming conventions:

1. An interface method `RemoteFooCommand` in `WshRpcRemoteFileInterface` generates command name `remotefoo`
2. `wshrpcmeta.go:99` strips the "Command" suffix and lowercases: `RemoteWriteTempFileCommand` → `remotewritetempfile`
3. The Go client calls `sendRpcRequestCallHelper(w, "remotewritetempfile", data, opts)` 
4. The remote `ServerImpl.RemoteWriteTempFileCommand()` handles it automatically
5. No manual registration is needed — the reflection-based system handles it

### How `isSshConnName` Works

Defined in `frontend/util/util.ts:26-28`:
```typescript
function isSshConnName(connName: string): boolean {
    return !isLocalConnName(connName) && !isWslConnName(connName);
}
```
Returns true for any connection that is not local and not WSL. This is the correct check for "are we connected to a remote machine via SSH?"

### How `getBlockMetaKeyAtom` Works

Imported from `@/store/global`, this is a Jotai atom factory that reads block metadata. Usage:
```typescript
const connName = globalStore.get(getBlockMetaKeyAtom(blockId, "connection")) ?? "";
```
The `"connection"` key returns the connection name string (e.g., `"ssh://user@host"` or `""` for local).

### Existing `WriteTempFileCommand` (Local)

Defined in `pkg/wshrpc/wshserver/wshserver.go:432-454`:
- Creates a local temp directory with `os.MkdirTemp("", "waveterm-")`
- Decodes base64 data
- Writes to temp file
- Returns local path

The new `RemoteWriteTempFileCommand` is identical but runs on the remote machine.

### `quoteForPosixShell` Function

Imported from `@/util/util`, this quotes file paths for safe use in POSIX shells (handles spaces, special chars). Used in the existing drop handler.

## Verification

1. `./node_modules/.bin/task init && ./node_modules/.bin/task dev` to build
2. Connect to a remote machine via SSH in WaveTerm
3. Copy an image to clipboard (screenshot)
4. **Image paste test:** Cmd+V into the terminal → verify upload overlay appears → verify path starts with remote temp dir (e.g., `/tmp/waveterm-XXXX/...`) → verify overlay disappears
5. On the remote: `file <path>` → should show image type
6. **Image drag-drop test:** Drag an image file into remote terminal → verify upload overlay → verify remote path
7. **Non-image drag-drop test:** Drag a `.sh` or `.txt` file into remote terminal → verify upload overlay → verify remote path, `cat <path>` shows file content
8. **Input suppression test:** During upload, type on keyboard → verify no keystrokes reach terminal → after upload completes, verify typing works normally
9. **Pi integration test:** Paste image, then in Pi: the file should be accessible via `read` tool
10. **General app test:** Paste/drag file, then in bash: `ls -la <path>` → file exists on remote
11. **Local regression test:** Connect to local terminal → paste image → verify no overlay, existing behavior unchanged (local temp path)
12. **WSL regression test:** Connect to WSL → verify no overlay, existing behavior unchanged
13. **Overlay visual test:** Verify overlay uses same styling as ConnStatusOverlay (backdrop-blur, rounded corners, position below header)

## Branch

Branch `feature/remote-image-paste` has been created from HEAD.
