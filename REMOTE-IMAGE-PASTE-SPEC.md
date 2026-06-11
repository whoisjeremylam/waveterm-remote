# Spec: Remote Image Paste & Drag-Drop for WaveTerm

## Problem

When a user pastes a screenshot (Cmd+V) or drag-drops an image into a WaveTerm terminal connected to a remote machine via SSH, the image is saved to a **local** temp file and the local path is pasted into the terminal. This path doesn't exist on the remote machine, so tools like Pi can't access the image.

**Current flow:**
1. User pastes image → `termwrap.ts:677` `pasteHandler()` extracts image
2. `termutil.ts:81` `createTempFileFromBlob()` saves to LOCAL temp path (`/var/folders/.../waveterm_paste_*.png`)
3. Local path is pasted into terminal as text
4. Pi sees path but can't read it (file doesn't exist on remote)

**Goal:** When connected to a remote machine, save the image to a temp file on the **remote** machine and paste the remote path. Also extend drag-and-drop for remote image files.

## Approach

Add a new Go RPC command `RemoteWriteTempFileCommand` that writes a temp file on the remote machine via the existing SSH RPC routing, then modify the frontend paste/drag-drop handlers to use this command for SSH connections.

The command dispatch is automatic: add a method to `WshRpcRemoteFileInterface`, implement it on `ServerImpl`, and the system auto-registers it by lowercasing the method name (e.g., `RemoteWriteTempFileCommand` → `remotewritetempfile`).

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
| `frontend/app/view/term/termwrap.ts` | Modify `pasteHandler()` and `dropHandler()` for remote connections |

### Auto-generated

| File | Change |
|------|--------|
| `frontend/types/gotypes.d.ts` | Will be updated by `npm run gen` or `task gen` |

## Detailed Changes

### 1. Go Types — `pkg/wshrpc/wshrpctypes.go`

Add after `CommandWriteTempFileData` (line ~350):

```go
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

Replace the image handling block (lines 686-692):

```typescript
if (data.image && SupportsImageInput) {
    if (!firstImage) {
        await new Promise((r) => setTimeout(r, 150));
    }
    const connName = globalStore.get(getBlockMetaKeyAtom(this.blockId, "connection")) ?? "";
    const isRemote = isSshConnName(connName);
    let tempPath: string;
    if (isRemote) {
        tempPath = await createRemoteTempFileFromBlob(data.image);
    } else {
        tempPath = await createTempFileFromBlob(data.image);
    }
    this.terminal.paste(tempPath + " ");
    firstImage = false;
}
```

**Modify `dropHandler()`** (line ~323):

Replace the drop handler to handle remote image files:

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
        if (isRemote && file.type.startsWith("image/")) {
            // Transfer image to remote via RPC
            try {
                const tempPath = await createRemoteTempFileFromBlob(file);
                parts.push(quoteForPosixShell(tempPath));
            } catch (err) {
                console.error("Failed to transfer image to remote:", err);
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

## Implementation Order

1. `git checkout -b feature/remote-image-paste`
2. Add Go types (`CommandRemoteWriteTempFileData`)
3. Add to `WshRpcRemoteFileInterface`
4. Implement `RemoteWriteTempFileCommand` in `wshremote_file.go`
5. Add client wrapper in `wshclient.go`
6. Run codegen (`npm run gen` or `task gen`) to update `gotypes.d.ts`
7. Add `RemoteWriteTempFileCommand` to frontend `RpcApi`
8. Add `createRemoteTempFileFromBlob()` in `termutil.ts`
9. Modify `pasteHandler()` in `termwrap.ts`
10. Modify `dropHandler()` in `termwrap.ts`

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
4. **Paste test:** Cmd+V into the terminal → verify path starts with remote temp dir (e.g., `/tmp/waveterm-XXXX/...`)
5. On the remote: `file <path>` → should show image type
6. **Drag-drop test:** Drag an image file into remote terminal → verify remote path
7. **Pi integration test:** Paste image, then in Pi: the file should be accessible via `read` tool
8. **Local regression test:** Connect to local terminal → paste image → verify existing behavior unchanged (local temp path)

## Branch

Branch `feature/remote-image-paste` has been created from HEAD.
