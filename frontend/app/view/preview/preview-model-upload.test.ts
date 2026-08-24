// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { computeSpeedBps, formatSpeed, planUploadChunks, readChunkAsBase64 } from "./preview-model-upload";

const CHUNK = 2 * 1024 * 1024; // 2MB

describe("planUploadChunks", () => {
    it("empty file -> a single zero-length chunk (so the upload still creates the file)", () => {
        expect(planUploadChunks(0, CHUNK)).toEqual([{ offset: 0, length: 0 }]);
    });

    it("file smaller than chunk -> one chunk covering the whole file", () => {
        expect(planUploadChunks(100, CHUNK)).toEqual([{ offset: 0, length: 100 }]);
    });

    it("exact multiple of chunk size -> N equal chunks with contiguous offsets", () => {
        expect(planUploadChunks(4, 2)).toEqual([
            { offset: 0, length: 2 },
            { offset: 2, length: 2 },
        ]);
        expect(planUploadChunks(2 * CHUNK, CHUNK)).toEqual([
            { offset: 0, length: CHUNK },
            { offset: CHUNK, length: CHUNK },
        ]);
    });

    it("remainder -> final chunk is the leftover bytes", () => {
        expect(planUploadChunks(5, 2)).toEqual([
            { offset: 0, length: 2 },
            { offset: 2, length: 2 },
            { offset: 4, length: 1 },
        ]);
    });

    it("single byte file -> one chunk of length 1", () => {
        expect(planUploadChunks(1, CHUNK)).toEqual([{ offset: 0, length: 1 }]);
    });

    it("chunk offsets are contiguous and lengths sum to the file size", () => {
        const fileSize = 5 * CHUNK + 12345;
        const chunks = planUploadChunks(fileSize, CHUNK);
        expect(chunks.length).toBe(6);
        let total = 0;
        let prevEnd = 0;
        for (const chunk of chunks) {
            expect(chunk.offset).toBe(prevEnd);
            expect(chunk.length).toBeGreaterThan(0);
            prevEnd = chunk.offset + chunk.length;
            total += chunk.length;
        }
        expect(total).toBe(fileSize);
        expect(chunks[5]).toEqual({ offset: 5 * CHUNK, length: 12345 });
    });

    it("rejects a non-positive chunkSize", () => {
        expect(() => planUploadChunks(100, 0)).toThrow();
        expect(() => planUploadChunks(100, -1)).toThrow();
    });

    it("rejects a negative or non-finite fileSize", () => {
        expect(() => planUploadChunks(-1, CHUNK)).toThrow();
        expect(() => planUploadChunks(NaN, CHUNK)).toThrow();
    });
});

describe("readChunkAsBase64", () => {
    it("reads and base64-encodes a whole-file chunk", async () => {
        const blob = new Blob([new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])]); // "Hello"
        expect(await readChunkAsBase64(blob, 0, 5)).toBe("SGVsbG8=");
    });

    it("reads a partial chunk at a non-zero offset", async () => {
        const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]);
        expect(await readChunkAsBase64(blob, 2, 3)).toBe("AwQF"); // bytes [3, 4, 5]
    });

    it("a zero-length chunk yields an empty base64 string", async () => {
        const blob = new Blob([new Uint8Array(0)]);
        expect(await readChunkAsBase64(blob, 0, 0)).toBe("");
    });

    it("slices the blob with the exact offset and end", async () => {
        const inner = new Blob([new Uint8Array([10, 20, 30, 40])]);
        const calls: Array<[number, number]> = [];
        const mockBlob = {
            slice(start: number, end: number) {
                calls.push([start, end]);
                return inner.slice(start, end);
            },
        } as unknown as Blob;
        await readChunkAsBase64(mockBlob, 1, 2);
        expect(calls).toEqual([[1, 3]]);
    });
});

describe("computeSpeedBps", () => {
    it("computes bytes per second over the elapsed interval", () => {
        expect(computeSpeedBps(1024, 0, 1000)).toBe(1024);
        expect(computeSpeedBps(100, 1000, 2000)).toBe(100);
    });

    it("returns 0 for zero bytes sent", () => {
        expect(computeSpeedBps(0, 0, 1000)).toBe(0);
    });

    it("returns 0 for zero or negative elapsed time", () => {
        expect(computeSpeedBps(100, 1000, 1000)).toBe(0);
        expect(computeSpeedBps(100, 1000, 500)).toBe(0);
    });

    it("returns 0 for invalid inputs", () => {
        expect(computeSpeedBps(NaN, 0, 1000)).toBe(0);
        expect(computeSpeedBps(-5, 0, 1000)).toBe(0);
    });
});

describe("formatSpeed", () => {
    it("renders zero as 0 B/s", () => {
        expect(formatSpeed(0)).toBe("0 B/s");
    });

    it("renders invalid and negative input as a dash", () => {
        expect(formatSpeed(NaN)).toBe("-");
        expect(formatSpeed(Infinity)).toBe("-");
        expect(formatSpeed(-1)).toBe("-");
    });

    it("keeps sub-1024 rates in bytes", () => {
        expect(formatSpeed(500)).toBe("500 B/s");
    });

    it("scales through kB, MB, and GB with three significant figures", () => {
        expect(formatSpeed(1024)).toBe("1 kB/s");
        expect(formatSpeed(8.2 * 1024 * 1024)).toBe("8.2 MB/s");
        expect(formatSpeed(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB/s");
    });
});
