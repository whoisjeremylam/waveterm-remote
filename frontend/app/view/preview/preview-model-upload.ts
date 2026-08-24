// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure upload-planning helpers, extracted so they can be unit-tested without a
// React/Jotai environment. Kept separate from preview-model.tsx (which owns the
// RPC/UI side) to avoid importing heavyweight dependencies into tests.

// 2MB chunks keep each base64 WS message (~2.67MB) far below the 5MB
// MaxWebSocketSendSize cap in frontend/app/store/ws.ts. Do not raise this
// without re-checking the send cap.
export const UploadChunkSize = 2 * 1024 * 1024;

export type UploadChunk = {
    offset: number;
    length: number;
};

export type UploadProgress = {
    fileName: string;
    sent: number;
    total: number;
};

export type DownloadProgress = {
    fileName: string;
};

// Splits a file into {offset, length} chunk descriptors. The offset/length are
// used on the client to slice the file bytes; they are NOT sent to the server
// (the first chunk is written with FileWriteCommand which truncates, and the
// remaining chunks are appended sequentially with FileAppendCommand — the
// server's O_APPEND flag maintains the correct write position).
//
// An empty file yields a single zero-length chunk so the upload still issues a
// create/truncate write, preserving the previous behavior of writing empty
// files. chunkSize must be a positive integer.
export function planUploadChunks(fileSize: number, chunkSize: number): UploadChunk[] {
    if (!Number.isFinite(fileSize) || fileSize < 0) {
        throw new Error(`planUploadChunks: invalid fileSize ${fileSize}`);
    }
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
        throw new Error(`planUploadChunks: invalid chunkSize ${chunkSize}`);
    }
    if (fileSize === 0) {
        return [{ offset: 0, length: 0 }];
    }
    const chunks: UploadChunk[] = [];
    for (let offset = 0; offset < fileSize; offset += chunkSize) {
        chunks.push({ offset, length: Math.min(chunkSize, fileSize - offset) });
    }
    return chunks;
}
