// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import { getWebServerEndpoint } from "../frontend/util/endpoints";

// Temp directories created for native file drag-out are registered here so they
// can be swept on TTL expiry or application quit. This lifecycle will be extended
// in Phase 4 (drag progress), but the registry + cleanup is shared from the start.
const tempDragDirs = new Set<string>();

export const TEMP_DRAG_DIR_PREFIX = "wave-drag-";
export const TEMP_DRAG_FILE_TTL_MS = 10 * 60 * 1000;

/**
 * Builds the stream URL used to download a remote file for native drag-out.
 * The Go handler (handleStreamFile) only reads the `path` query param, so we do
 * not include a baseName path segment here.
 */
export function buildStreamFileUrl(remoteUri: string): string {
    return getWebServerEndpoint() + "/wave/stream-file?path=" + encodeURIComponent(remoteUri);
}

/**
 * Native drag-out only supports files; directories must be rejected before we
 * download anything or call startDrag.
 */
export function isDragDirRejected(isDir: boolean): boolean {
    return Boolean(isDir);
}

export function registerTempDragDir(dir: string): void {
    tempDragDirs.add(dir);
}

export function getRegisteredTempDragDirs(): string[] {
    return Array.from(tempDragDirs);
}

/**
 * Removes a single temp dir (if still registered) and drops it from the registry.
 * Idempotent: a second call for the same dir is a no-op.
 */
export async function cleanupTempDragDir(dir: string): Promise<void> {
    if (!tempDragDirs.has(dir)) {
        return;
    }
    tempDragDirs.delete(dir);
    await fs.promises.rm(dir, { recursive: true, force: true });
}

/**
 * Removes all registered temp dirs (used on application quit).
 */
export async function cleanupAllTempDragFiles(): Promise<void> {
    const dirs = Array.from(tempDragDirs);
    tempDragDirs.clear();
    await Promise.all(dirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
}

/**
 * Schedules a temp dir for TTL-based cleanup so abandoned drags don't leak files.
 */
export function scheduleTempDragDirCleanup(dir: string, ttlMs: number = TEMP_DRAG_FILE_TTL_MS): void {
    setTimeout(() => {
        cleanupTempDragDir(dir).catch((err) => {
            console.error(`Failed to clean up temp drag dir ${dir}:`, err);
        });
    }, ttlMs);
}
