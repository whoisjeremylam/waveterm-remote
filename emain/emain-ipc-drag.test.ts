// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, stat } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
    buildStreamFileUrl,
    cleanupAllTempDragFiles,
    cleanupTempDragDir,
    getRegisteredTempDragDirs,
    isDragDirRejected,
    registerTempDragDir,
} from "./drag-temp-files";

describe("buildStreamFileUrl", () => {
    it("builds the stream-file URL with the encoded path query param", () => {
        const remoteUri = "wsh://conn/some/file.txt";
        const url = buildStreamFileUrl(remoteUri);
        expect(url.endsWith("/wave/stream-file?path=" + encodeURIComponent(remoteUri))).toBe(true);
    });

    it("encodes special characters in the remote URI", () => {
        const remoteUri = "wsh://conn/a b/c?d=e&f=g";
        const url = buildStreamFileUrl(remoteUri);
        expect(url.endsWith("/wave/stream-file?path=" + encodeURIComponent(remoteUri))).toBe(true);
        expect(url).not.toContain(" ");
    });
});

describe("isDragDirRejected", () => {
    it("rejects directories and allows files", () => {
        expect(isDragDirRejected(true)).toBe(true);
        expect(isDragDirRejected(false)).toBe(false);
    });
});

describe("temp drag dir registry", () => {
    afterEach(async () => {
        await cleanupAllTempDragFiles();
    });

    it("registers and cleans up a temp dir; second cleanup is a no-op", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "wave-drag-test-"));
        registerTempDragDir(dir);
        expect(getRegisteredTempDragDirs()).toContain(dir);

        await cleanupTempDragDir(dir);
        expect(getRegisteredTempDragDirs()).not.toContain(dir);
        await expect(stat(dir)).rejects.toThrow();

        // idempotent: a second cleanup does not throw
        await cleanupTempDragDir(dir);
        expect(getRegisteredTempDragDirs()).not.toContain(dir);
    });

    it("cleanupAllTempDragFiles removes all registered dirs", async () => {
        const dir1 = await mkdtemp(path.join(os.tmpdir(), "wave-drag-test-"));
        const dir2 = await mkdtemp(path.join(os.tmpdir(), "wave-drag-test-"));
        registerTempDragDir(dir1);
        registerTempDragDir(dir2);
        expect(getRegisteredTempDragDirs()).toHaveLength(2);

        await cleanupAllTempDragFiles();
        expect(getRegisteredTempDragDirs()).toHaveLength(0);
        await expect(stat(dir1)).rejects.toThrow();
        await expect(stat(dir2)).rejects.toThrow();
    });
});
