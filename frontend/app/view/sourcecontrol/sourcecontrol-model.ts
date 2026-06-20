// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WaveEnv } from "@/app/waveenv/waveenv";
import { makeConnRoute, isBlank } from "@/util/util";
import * as jotai from "jotai";
import type { SelectedFile } from "./types";

// Forward declaration - will be defined in sourcecontrol.tsx
declare const SourceControlView: ViewComponent;

export class SourceControlViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    env: WaveEnv;

    viewIcon = jotai.atom<string>("code-branch");
    viewName = jotai.atom<string>("Source Control");
    noPadding = jotai.atom<boolean>(true);
    manageConnection = jotai.atom<boolean>(true);

    // State atoms
    statusAtom: jotai.PrimitiveAtom<GitStatusResponse | null>;
    selectedFileAtom: jotai.PrimitiveAtom<SelectedFile | null>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;
    errorAtom: jotai.PrimitiveAtom<string | null>;
    viewModeAtom: jotai.PrimitiveAtom<"side-by-side" | "inline">;
    diffAtom: jotai.PrimitiveAtom<GitDiffResponse | null>;

    // Connection
    connection: jotai.Atom<string>;
    cwd: jotai.Atom<string>;
    connStatus: jotai.Atom<ConnStatus>;

    // Polling
    pollInterval = 3000;
    pollTimer: ReturnType<typeof setInterval> | null = null;
    selectedFileUnsub: (() => void) | null = null;
    disposed = false;

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.viewType = "sourcecontrol";
        this.blockId = blockId;
        this.env = waveEnv;

        // Initialize atoms
        this.statusAtom = jotai.atom<GitStatusResponse | null>(null) as jotai.PrimitiveAtom<GitStatusResponse | null>;
        this.selectedFileAtom = jotai.atom<SelectedFile | null>(null) as jotai.PrimitiveAtom<SelectedFile | null>;
        this.loadingAtom = jotai.atom<boolean>(true) as jotai.PrimitiveAtom<boolean>;
        this.errorAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;
        this.viewModeAtom = jotai.atom<"side-by-side" | "inline">("side-by-side") as jotai.PrimitiveAtom<"side-by-side" | "inline">;
        this.diffAtom = jotai.atom<GitDiffResponse | null>(null) as jotai.PrimitiveAtom<GitDiffResponse | null>;

        // Connection from block metadata
        this.connection = jotai.atom((get) => {
            const connValue = get(this.env.getBlockMetaKeyAtom(blockId, "connection"));
            if (isBlank(connValue as string)) {
                return "local";
            }
            return connValue as string;
        });

        // CWD from block metadata (set by terminal's OSC 7)
        this.cwd = jotai.atom((get) => {
            const cwdValue = get(this.env.getBlockMetaKeyAtom(blockId, "cmd:cwd"));
            if (isBlank(cwdValue as string)) {
                return "~";
            }
            return cwdValue as string;
        });

        this.connStatus = jotai.atom((get) => {
            const connName = get(this.connection);
            const connAtom = this.env.getConnStatusAtom(connName);
            return get(connAtom);
        });

        // Subscribe to selectedFile changes to fetch diff
        this.selectedFileUnsub = globalStore.sub(this.selectedFileAtom, () => {
            const selected = globalStore.get(this.selectedFileAtom);
            if (selected) {
                this.fetchDiffForSelected();
            } else {
                globalStore.set(this.diffAtom, null);
            }
        });

        // Start polling when view is visible
        this.startPolling();
    }

    get viewComponent(): ViewComponent {
        return SourceControlView;
    }

    startPolling() {
        this.fetchStatus();
        this.pollTimer = setInterval(() => {
            this.fetchStatus();
        }, this.pollInterval);
    }

    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async fetchStatus() {
        if (this.disposed) return;

        const cwd = globalStore.get(this.cwd);
        const connStatus = globalStore.get(this.connStatus);

        if (!connStatus?.connected) {
            return;
        }

        const route = makeConnRoute(globalStore.get(this.connection));
        try {
            const resp = await this.env.rpc.GitStatusCommand(
                TabRpcClient,
                { dir: cwd },
                { route }
            );
            if (!this.disposed) {
                globalStore.set(this.statusAtom, resp);
                globalStore.set(this.loadingAtom, false);
                globalStore.set(this.errorAtom, null);
            }
        } catch (e) {
            if (!this.disposed) {
                globalStore.set(this.loadingAtom, false);
                globalStore.set(this.errorAtom, String(e));
            }
        }
    }

    async fetchDiff(dir: string, path: string, staged: boolean): Promise<GitDiffResponse | null> {
        const connStatus = globalStore.get(this.connStatus);
        if (!connStatus?.connected) {
            return null;
        }

        const route = makeConnRoute(globalStore.get(this.connection));
        try {
            return await this.env.rpc.GitDiffCommand(
                TabRpcClient,
                { dir, path, staged },
                { route }
            );
        } catch (e) {
            console.error("Failed to fetch diff:", e);
            return null;
        }
    }

    async fetchDiffForSelected() {
        const selected = globalStore.get(this.selectedFileAtom);
        const cwd = globalStore.get(this.cwd);

        if (!selected) {
            globalStore.set(this.diffAtom, null);
            return;
        }

        const diff = await this.fetchDiff(cwd, selected.path, selected.staged);
        if (!this.disposed) {
            globalStore.set(this.diffAtom, diff);
        }
    }

    refresh() {
        this.fetchStatus();
    }

    dispose() {
        this.disposed = true;
        this.stopPolling();
        if (this.selectedFileUnsub) {
            this.selectedFileUnsub();
            this.selectedFileUnsub = null;
        }
    }
}
