// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { planUploadChunks } from "./preview-model-upload";

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
