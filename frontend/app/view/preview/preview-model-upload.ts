// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure upload-planning helpers, extracted so they can be unit-tested without a
// React/Jotai environment. Kept separate from preview-model.tsx (which owns the
// RPC/UI side) to avoid importing heavyweight dependencies into tests.

import base64 from "base64-js";

// 3MB chunks keep each base64 WS message (~4MB) below the 5MB
// MaxWebSocketSendSize cap in frontend/app/store/ws.ts, while cutting WAN
// round-trips by a third vs 2MB. Do not raise this without re-checking the
// send cap.
export const UploadChunkSize = 3 * 1024 * 1024;

export type UploadChunk = {
    offset: number;
    length: number;
};

export type UploadProgress = {
    fileName: string;
    sent: number;
    total: number;
    // Average throughput in bytes/second, computed from the upload start time
    // and the current wall-clock time after each chunk lands.
    speedBps: number;
};

export type DownloadProgress = {
    fileName: string;
};

// Thrown by raceWithCancel when a transfer is cancelled. Extends Error (with a
// distinct name) so the upload loop can tell a user-initiated cancel apart from
// a genuine RPC/IO failure via instanceof.
export class CancelledError extends Error {
    constructor(message = "Upload cancelled") {
        super(message);
        this.name = "CancelledError";
    }
}

// A cancellation signal that upload code races against. cancel() flips the
// signal exactly once and resolves the internal deferred; whenCancelled() is
// the promise side of that deferred. The deferred RESOLVES (never rejects) so a
// token that is never raced cannot leak an unhandled promise rejection —
// raceWithCancel turns the resolution into a CancelledError.
export type CancelToken = {
    isCancelled: () => boolean;
    whenCancelled: () => Promise<void>;
    cancel: () => void;
};

export function createCancelToken(): CancelToken {
    let cancelled = false;
    let resolveCancelled: (() => void) | null = null;
    const whenCancelledPromise = new Promise<void>((resolve) => {
        resolveCancelled = resolve;
    });
    return {
        isCancelled: () => cancelled,
        whenCancelled: () => whenCancelledPromise,
        cancel: () => {
            if (cancelled) {
                return;
            }
            cancelled = true;
            resolveCancelled?.();
        },
    };
}

// Races a promise against a cancellation signal.
//
// - If the token is already cancelled, rejects with CancelledError immediately
//   (before awaiting the wrapped promise).
// - If the token flips while the wrapped promise is pending, rejects with
//   CancelledError promptly — the cancel path resolves the token's deferred
//   directly (no busy-polling/timers).
// - Otherwise resolves/rejects exactly as the wrapped promise does.
export async function raceWithCancel<T>(promise: Promise<T>, token: CancelToken): Promise<T> {
    if (token.isCancelled()) {
        throw new CancelledError();
    }
    const cancelSignal = token.whenCancelled().then((): never => {
        throw new CancelledError();
    });
    // If the wrapped promise wins the race, cancelSignal stays pending; if the
    // token is later cancelled with no active race, this no-op handler prevents
    // an unhandled-rejection warning (Promise.race still observes the rejection
    // via its own subscription).
    cancelSignal.catch(() => {});
    return Promise.race([promise, cancelSignal]);
}

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

// Reads exactly one chunk of a Blob/File lazily via Blob.slice(...).arrayBuffer()
// and returns it base64-encoded. Only ~one chunk's worth of bytes is ever
// materialized in memory at a time, regardless of the file's total size (the
// previous whole-file arrayBuffer() approach held ~2–3× the file size).
export async function readChunkAsBase64(blob: Blob, offset: number, length: number): Promise<string> {
    const slice = blob.slice(offset, offset + length);
    const buffer = await slice.arrayBuffer();
    return base64.fromByteArray(new Uint8Array(buffer));
}

// Computes the average upload throughput in bytes/second from the upload start
// time and the current wall-clock time. Returns 0 on invalid input or a
// non-positive elapsed time so NaN/Infinity never leaks into the UI.
export function computeSpeedBps(bytesSent: number, startTimeMs: number, nowTimeMs: number): number {
    if (!Number.isFinite(bytesSent) || bytesSent <= 0) {
        return 0;
    }
    const elapsedMs = nowTimeMs - startTimeMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
        return 0;
    }
    return bytesSent / (elapsedMs / 1000);
}

const speedUnits = ["B/s", "kB/s", "MB/s", "GB/s", "TB/s"];

// Formats a bytes/second throughput as a compact human-readable string
// (e.g. "8.2 MB/s"). Zero yields "0 B/s"; invalid or negative input yields "-".
// Kept separate from getBestUnit (which uses compact lowercase suffixes for
// table cells) so the transfer banner can show full "/s" units.
export function formatSpeed(bytesPerSec: number): string {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) {
        return "-";
    }
    if (bytesPerSec === 0) {
        return "0 B/s";
    }
    const divisor = 1024;
    const idx = Math.min(Math.floor(Math.log(bytesPerSec) / Math.log(divisor)), speedUnits.length - 1);
    const value = bytesPerSec / Math.pow(divisor, idx);
    return `${parseFloat(value.toPrecision(3))} ${speedUnits[idx]}`;
}
