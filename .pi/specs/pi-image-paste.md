# Spec: Image Paste Extension for Pi TUI

## Problem

When a user pastes an image path (e.g., from WaveTerm's remote file transfer) into Pi's editor, the path appears as plain text. The LLM doesn't see the image unless the user explicitly asks Pi to `read` the file. There's no visual preview and no automatic multimodal attachment.

## Goal

When WaveTerm temp file paths are pasted into Pi's editor:
1. **Confirm**: Show a confirmation dialog — user chooses to attach or dismiss
2. **Preview**: If confirmed, render the image below the editor
3. **Attach**: Include the image in the message payload so the LLM sees it on send

## Architecture: Pi Extension

This is implemented as a **Pi extension** — no changes to Pi core. Pi's extension API provides all needed hooks:

| Hook | Purpose |
|------|---------|
| `onTerminalInput(handler)` | Intercept raw terminal input — detect bracketed paste with WaveTerm paths |
| `ctx.ui.confirm(title, message)` | Show confirmation dialog before attaching |
| `setWidget(key, component, { placement: "belowEditor" })` | Render image previews below the editor |
| `on("input", handler)` → `InputEventResult` | Transform input to attach images before LLM sees it |
| `ctx.isIdle()` | Only activate when Pi is idle (not streaming/tools) |

## Safety Design

The extension is conservative to avoid breaking normal terminal usage:

| Guard | Purpose |
|-------|---------|
| `ctx.isIdle()` check | Don't intercept during streaming or tool execution |
| WaveTerm-specific regex | Only match `/tmp/waveterm-*` paths, not random image paths |
| Confirmation dialog | User must confirm before attaching |
| `consume: true` only on confirm | If dismissed, path is pasted as text normally |

## Reusable Building Blocks in Pi

- `ImageContent` type (`packages/ai/src/types.ts:251-255`) — `{ type: "image", data: string, mimeType: string }`
- `UserMessage.content` supports `(TextContent | ImageContent)[]` — multimodal messages work
- Provider conversions exist for Anthropic, OpenAI, Mistral, Google, Bedrock
- `read.ts:243-274` — image loading, MIME detection, auto-resize pipeline
- `Image` component (`components/image.ts`) — renders images via Kitty/iTerm2 protocol
- `terminal-image.ts` — protocol detection and encoding
- `image-resize.ts` — Photon WASM resize to stay under 4.5MB / 2000x2000

## Extension Structure

```
packages/coding-agent/extensions/image-paste/
├── index.ts          # Extension entry point
├── path-detector.ts  # WaveTerm path regex + extraction
├── image-loader.ts   # File read, MIME detect, resize → ImageContent
└── package.json      # Extension metadata
```

## Detailed Changes

### 1. Extension Entry Point — `index.ts`

```typescript
import { defineExtension, type ExtensionAPI, type InputEvent, type InputEventResult } from "@earendil-works/pi-coding-agent";
import { detectWaveTermPaths, type PasteAttachment } from "./path-detector.ts";
import { loadImageFromPath } from "./image-loader.ts";
import { Image, Box, Text, Component } from "@earendil-works/pi-tui";

export default defineExtension((pi: ExtensionAPI) => {
    let pendingAttachments: PasteAttachment[] = [];

    // ─── Hook 1: Intercept pasted text containing WaveTerm image paths ───
    pi.ui.onTerminalInput(async (data) => {
        // Only activate when Pi is idle
        if (!pi.isIdle()) return undefined;

        // Detect bracketed paste: \x1b[200~...data...\x1b[201~
        const pasteMatch = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
        if (!pasteMatch) return undefined;

        const pastedText = pasteMatch[1];
        const waveTermPaths = detectWaveTermPaths(pastedText);

        if (waveTermPaths.length === 0) return undefined; // Not WaveTerm paths, pass through

        // Show confirmation for first image
        const fileName = waveTermPaths[0].split("/").pop();
        const confirmed = await pi.ui.confirm(
            "Attach Image",
            waveTermPaths.length === 1
                ? `Attach ${fileName} to your message?`
                : `Attach ${waveTermPaths.length} images to your message?`
        );

        if (!confirmed) {
            // User dismissed — paste path as text normally
            return undefined;
        }

        // Load images and attach
        for (const path of waveTermPaths) {
            try {
                const attachment = await loadImageFromPath(path);
                pendingAttachments.push(attachment);
            } catch (err) {
                pi.ui.notify(`Failed to load image: ${path} — ${err.message}`, "warning");
            }
        }

        renderPreviews();
        return { consume: true }; // Don't insert path as text
    });

    // ─── Hook 2: Show image previews below editor ───
    function renderPreviews() {
        if (pendingAttachments.length === 0) {
            pi.ui.setWidget("image-previews", undefined);
            return;
        }

        pi.ui.setWidget("image-previews", (tui, theme) => {
            const children: Component[] = [];

            // Attachment count indicator
            const countText = pendingAttachments.length === 1
                ? `[1 image attached: ${pendingAttachments[0].fileName}]`
                : `[${pendingAttachments.length} images attached]`;
            children.push(new Text(countText, { dim: true }));

            // Render each image preview
            for (const attachment of pendingAttachments) {
                children.push(new Image(attachment.image));
            }

            return new Box({ flexDirection: "column" }, children) as Component & { dispose?(): void };
        }, { placement: "belowEditor" });
    }

    // ─── Hook 3: Transform input to include images ───
    pi.on("input", (event: InputEvent, ctx): InputEventResult | void => {
        if (pendingAttachments.length === 0) return undefined;

        const images = pendingAttachments.map(a => a.image);
        pendingAttachments = [];
        renderPreviews(); // Clear previews

        return {
            action: "transform",
            text: event.text,
            images,
        };
    });
});
```

### 2. Path Detector — `path-detector.ts`

Only matches WaveTerm's temp file paths to avoid false positives.

```typescript
import type { ImageContent } from "@earendil-works/pi-ai";

// Only match WaveTerm temp file paths: /tmp/waveterm-<id>/<filename>
// This prevents false positives on random image paths
const WAVETERM_PATH_REGEX = /\/tmp\/waveterm-[a-z0-9]+\/[\w.-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg)\b/gi;

export interface PasteAttachment {
    image: ImageContent;
    fileName: string;
    originalPath: string;
}

export function detectWaveTermPaths(text: string): string[] {
    const matches = text.match(WAVETERM_PATH_REGEX);
    return matches ? [...new Set(matches)] : []; // Deduplicate
}
```

### 3. Image Loader — `image-loader.ts`

```typescript
import type { ImageContent } from "@earendil-works/pi-ai";
import { readFile } from "fs/promises";
import { basename } from "path";
import type { PasteAttachment } from "./path-detector.ts";

const EXT_TO_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".svg": "image/svg+xml",
};

function detectMimeType(filePath: string): string | null {
    const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
    return EXT_TO_MIME[ext] || null;
}

import { resizeImage } from "../../utils/image-resize.ts";

export async function loadImageFromPath(filePath: string): Promise<PasteAttachment> {
    const mimeType = detectMimeType(filePath);
    if (!mimeType) {
        throw new Error(`Unsupported image format: ${filePath}`);
    }

    const buffer = await readFile(filePath);
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (buffer.length > maxSize) {
        throw new Error(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB > 5MB)`);
    }

    const resized = await resizeImage(buffer, mimeType);

    const image: ImageContent = {
        type: "image",
        data: resized ? resized.data : buffer.toString("base64"),
        mimeType: resized ? resized.mimeType : mimeType,
    };

    return {
        image,
        fileName: basename(filePath),
        originalPath: filePath,
    };
}
```

### 4. Conversation Display (Optional Enhancement)

Currently, sent user messages only render text. To show attached images in chat history, the extension would need Pi core changes or a custom message renderer. This is **optional** for v1 — the LLM sees the images regardless of whether they render in the chat history.

If desired later, use `pi.registerMessageRenderer("user", ...)` to add image rendering to user messages.

## Edge Cases

| Case | Handling |
|------|----------|
| WaveTerm path pasted while Pi is streaming | Pass through as text (extension inactive) |
| WaveTerm path pasted, user dismisses confirm | Path pasted as text, no attachment |
| Non-WaveTerm path pasted | Pass through as text (extension doesn't match) |
| Image file doesn't exist | `notify()` warning, path pasted as text |
| Image too large (>5MB) | Auto-resize via existing pipeline; if still too large, `notify()` warning |
| Multiple WaveTerm paths in one paste | Confirmation shows count, all attach on confirm |
| Sequential pastes | Each paste triggers separate confirmation, previews accumulate |
| User sends with no text, only images | Send images with empty text prompt |
| Non-multimodal model | Attachments silently ignored (existing behavior in `agent-session.ts`) |
| Extension not loaded | No behavior change — plain text paths as before |

## Implementation Order

1. Create extension directory structure
2. Implement `path-detector.ts` — WaveTerm path regex
3. Implement `image-loader.ts` — file read + MIME detect + resize
4. Implement `index.ts` — wire up hooks (terminal input with confirmation, widget, input transform)
5. Test single image paste with confirmation
6. Test dismiss flow — path pasted as text
7. Test multiple image paste
8. Test non-WaveTerm paths pass through unchanged
9. Test idle-only guard (paste during streaming)
10. Test error cases (missing file, large image, bad format)

## Verification

1. Build Pi: `cd packages/coding-agent && npm run build`
2. Load extension in Pi config
3. **Confirm flow**: Paste WaveTerm image path → verify confirmation dialog → confirm → verify preview below editor → send → verify LLM sees image
4. **Dismiss flow**: Paste WaveTerm image path → verify confirmation dialog → dismiss → verify path appears as text
5. **Idle-only**: Start a command, paste during streaming → verify path passes through as text (no dialog)
6. **Non-WaveTerm path**: Paste `/home/user/photo.jpg` → verify path passes through as text (no dialog)
7. **Multiple images**: Paste multiple WaveTerm paths → verify confirmation shows count → confirm → verify all previews
8. **Local regression**: Without extension loaded → verify existing behavior unchanged
