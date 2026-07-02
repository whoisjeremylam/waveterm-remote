// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { getFocusedTerminalCwd } from "@/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WaveEnv } from "@/app/waveenv/waveenv";
import { makeConnRoute, isBlank } from "@/util/util";
import * as jotai from "jotai";
import { createRef } from "react";
import type { ReviewFile, SelectedFile } from "./types";

import { SourceControlView } from "./sourcecontrol";

export class SourceControlViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    env: WaveEnv;

    viewIcon = jotai.atom<string>("code-branch");
    viewName = jotai.atom<string>("Source Control");
    hideViewName = jotai.atom<boolean>(true);
    noPadding = jotai.atom<boolean>(true);
    manageConnection = jotai.atom<boolean>(true);
    viewText: jotai.Atom<HeaderElem[]>;

    // State atoms
    statusAtom: jotai.PrimitiveAtom<GitStatusResponse | null>;
    selectedFileAtom: jotai.PrimitiveAtom<SelectedFile | null>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;
    errorAtom: jotai.PrimitiveAtom<string | null>;
    viewModeAtom: jotai.PrimitiveAtom<"side-by-side" | "inline">;
    diffAtom: jotai.PrimitiveAtom<GitDiffResponse | null>;
    directoryDropdownOpen: jotai.PrimitiveAtom<boolean>;
    stagingAtom: jotai.PrimitiveAtom<boolean>;
    commitMessageAtom: jotai.PrimitiveAtom<string>;
    committingAtom: jotai.PrimitiveAtom<boolean>;
    pushingAtom: jotai.PrimitiveAtom<boolean>;

    // Auth dialog atoms
    showAuthDialogAtom: jotai.PrimitiveAtom<boolean>;
    authErrorAtom: jotai.PrimitiveAtom<string | null>;
    authHostAtom: jotai.PrimitiveAtom<string>;
    authRemoteAtom: jotai.PrimitiveAtom<string>;
    authPreFilledUsernameAtom: jotai.PrimitiveAtom<string>;
    authIsRetryAtom: jotai.PrimitiveAtom<boolean>;
    authScopeAtom: jotai.PrimitiveAtom<string>;

    // Review mode state
    reviewModeAtom: jotai.PrimitiveAtom<boolean>;
    reviewFilesAtom: jotai.PrimitiveAtom<ReviewFile[]>;
    reviewActiveIndexAtom: jotai.PrimitiveAtom<number>;
    reviewCollapsedAtom: jotai.PrimitiveAtom<Map<string, boolean>>;
    reviewFileRefsAtom: jotai.PrimitiveAtom<Map<string, HTMLDivElement>>;
    diffCacheAtom: jotai.PrimitiveAtom<Map<string, GitDiffResponse>>;
    reviewFilterLabelAtom: jotai.PrimitiveAtom<string>;

    reviewStatsAtom: jotai.Atom<{ additions: number; deletions: number }>;

    // Connection
    connection: jotai.Atom<string>;
    cwd: jotai.PrimitiveAtom<string>;
    terminalCwd: jotai.Atom<string>;
    connStatus: jotai.Atom<ConnStatus>;

    // Polling
    pollInterval = 3000;
    pollTimer: ReturnType<typeof setInterval> | null = null;
    selectedFileUnsub: (() => void) | null = null;
    disposed = false;
    pathRef: React.RefObject<HTMLDivElement>;

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
        this.directoryDropdownOpen = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        this.stagingAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        this.commitMessageAtom = jotai.atom<string>("") as jotai.PrimitiveAtom<string>;
        this.committingAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        this.pushingAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        this.showAuthDialogAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        this.authErrorAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;
        this.authHostAtom = jotai.atom<string>("") as jotai.PrimitiveAtom<string>;
        this.authRemoteAtom = jotai.atom<string>("") as jotai.PrimitiveAtom<string>;
        this.authPreFilledUsernameAtom = jotai.atom<string>("") as jotai.PrimitiveAtom<string>;
        this.authIsRetryAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        this.authScopeAtom = jotai.atom<string>("repo") as jotai.PrimitiveAtom<string>;
        this.pathRef = createRef();

        // Review mode atoms
        this.reviewModeAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        this.reviewFilesAtom = jotai.atom<ReviewFile[]>([]) as jotai.PrimitiveAtom<ReviewFile[]>;
        this.reviewActiveIndexAtom = jotai.atom<number>(0) as jotai.PrimitiveAtom<number>;
        this.reviewCollapsedAtom = jotai.atom<Map<string, boolean>>(new Map()) as jotai.PrimitiveAtom<Map<string, boolean>>;
        this.reviewFileRefsAtom = jotai.atom<Map<string, HTMLDivElement>>(new Map()) as jotai.PrimitiveAtom<Map<string, HTMLDivElement>>;
        this.diffCacheAtom = jotai.atom<Map<string, GitDiffResponse>>(new Map()) as jotai.PrimitiveAtom<Map<string, GitDiffResponse>>;
        this.reviewFilterLabelAtom = jotai.atom<string>("") as jotai.PrimitiveAtom<string>;

        this.reviewStatsAtom = jotai.atom((get) => {
            const files = get(this.reviewFilesAtom);
            let additions = 0;
            let deletions = 0;
            for (const f of files) {
                additions += f.additions;
                deletions += f.deletions;
            }
            return { additions, deletions };
        });

        // Connection from block metadata
        this.connection = jotai.atom((get) => {
            const connValue = get(this.env.getBlockMetaKeyAtom(blockId, "connection"));
            if (isBlank(connValue as string)) {
                return "local";
            }
            return connValue as string;
        });

        // Terminal CWD from focused terminal block (SCM blocks don't have their own cmd:cwd)
        this.terminalCwd = jotai.atom((get) => {
            const cwdValue = get(this.env.getBlockMetaKeyAtom(blockId, "cmd:cwd"));
            if (!isBlank(cwdValue as string)) {
                return cwdValue as string;
            }
            const focusedCwd = getFocusedTerminalCwd();
            return focusedCwd || "~";
        });

        // User-selected CWD (overrides terminal CWD when set)
        const userCwdAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;

        // CWD - writable, user selection takes priority over terminal CWD
        this.cwd = jotai.atom(
            (get) => {
                const userCwd = get(userCwdAtom);
                if (userCwd !== null) {
                    return userCwd;
                }
                const terminalCwd = get(this.terminalCwd);
                return terminalCwd || "~";
            },
            (_get, set, value: string) => {
                set(userCwdAtom, value);
            }
        ) as jotai.PrimitiveAtom<string>;

        // View text for header - shows current directory
        // Memoize to avoid creating new object references when cwd hasn't changed,
        // which would cause unnecessary re-renders of the header.
        let prevCwd: string | undefined;
        let prevViewText: HeaderElem[] | undefined;
        this.viewText = jotai.atom((get) => {
            const cwd = get(this.cwd);
            if (prevCwd === cwd && prevViewText !== undefined) {
                return prevViewText;
            }
            prevCwd = cwd;
            prevViewText = [
                {
                    elemtype: "text",
                    text: cwd,
                    ref: this.pathRef,
                    className: "preview-filename",
                    onClick: () => {
                        const current = globalStore.get(this.directoryDropdownOpen);
                        globalStore.set(this.directoryDropdownOpen, !current);
                    },
                },
            ];
            return prevViewText;
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

        // Defer polling start to avoid running during React render phase
        setTimeout(() => this.startPolling(), 0);
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
                this.updateReviewFilesFromStatus();
            }
        } catch (e) {
            if (!this.disposed) {
                globalStore.set(this.loadingAtom, false);
                globalStore.set(this.errorAtom, String(e));
            }
        }
    }

    async fetchDiff(dir: string, path: string, staged: boolean, untracked: boolean = false, fullFile: boolean = false): Promise<GitDiffResponse | null> {
        const connStatus = globalStore.get(this.connStatus);
        if (!connStatus?.connected) {
            return null;
        }

        const route = makeConnRoute(globalStore.get(this.connection));
        try {
            return await this.env.rpc.GitDiffCommand(
                TabRpcClient,
                { dir, path, staged, untracked, fullFile },
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

        const untracked = selected.untracked ?? false;
        console.log("[SCM] fetchDiffForSelected:", {
            path: selected.path,
            staged: selected.staged,
            untracked,
            cwd,
        });
        const diff = await this.fetchDiff(cwd, selected.path, selected.staged, untracked, true);
        console.log("[SCM] diff result:", diff ? {
            hasOriginal: diff.original.length > 0,
            hasModified: diff.modified.length > 0,
            originalLen: diff.original.length,
            modifiedLen: diff.modified.length,
            language: diff.language,
        } : null);
        if (!this.disposed) {
            globalStore.set(this.diffAtom, diff);
        }
    }

    async stageFiles(paths: string[]) {
        if (paths.length === 0) return;
        const cwd = globalStore.get(this.cwd);
        const route = makeConnRoute(globalStore.get(this.connection));
        console.log("[SCM] stageFiles:", { paths, cwd });
        globalStore.set(this.stagingAtom, true);
        try {
            await this.env.rpc.GitStageCommand(TabRpcClient, { dir: cwd, paths }, { route });
            console.log("[SCM] stageFiles RPC succeeded, fetching status...");
            await this.fetchStatus();
            await this.fetchDiffForSelected();
        } catch (e) {
            console.error("[SCM] stageFiles failed:", e);
            await this.fetchStatus();
        } finally {
            globalStore.set(this.stagingAtom, false);
        }
    }

    async unstageFiles(paths: string[]) {
        if (paths.length === 0) return;
        const cwd = globalStore.get(this.cwd);
        const route = makeConnRoute(globalStore.get(this.connection));
        globalStore.set(this.stagingAtom, true);
        try {
            await this.env.rpc.GitUnstageCommand(TabRpcClient, { dir: cwd, paths }, { route });
            await this.fetchStatus();
            await this.fetchDiffForSelected();
        } catch (e) {
            console.error("Failed to unstage files:", e);
            await this.fetchStatus();
        } finally {
            globalStore.set(this.stagingAtom, false);
        }
    }

    async stageHunk(path: string, hunkIndex: number) {
        const cwd = globalStore.get(this.cwd);
        const route = makeConnRoute(globalStore.get(this.connection));
        globalStore.set(this.stagingAtom, true);
        try {
            await this.env.rpc.GitStageHunkCommand(TabRpcClient, { dir: cwd, path, hunkIndex }, { route });
            await this.fetchStatus();
            await this.fetchDiffForSelected();
        } catch (e) {
            console.error("Failed to stage hunk:", e);
            await this.fetchStatus();
        } finally {
            globalStore.set(this.stagingAtom, false);
        }
    }

    async revertHunk(path: string, hunkIndex: number, staged: boolean) {
        const cwd = globalStore.get(this.cwd);
        const route = makeConnRoute(globalStore.get(this.connection));
        globalStore.set(this.stagingAtom, true);
        try {
            await this.env.rpc.GitRevertHunkCommand(TabRpcClient, { dir: cwd, path, hunkIndex, staged }, { route });
            await this.fetchStatus();
            await this.fetchDiffForSelected();
        } catch (e) {
            console.error("Failed to revert hunk:", e);
            await this.fetchStatus();
        } finally {
            globalStore.set(this.stagingAtom, false);
        }
    }

    async commit(amend: boolean = false): Promise<{ success: boolean; output: string } | null> {
        const cwd = globalStore.get(this.cwd);
        const message = globalStore.get(this.commitMessageAtom);
        if (!message.trim()) {
            return null;
        }
        const route = makeConnRoute(globalStore.get(this.connection));
        globalStore.set(this.committingAtom, true);
        try {
            const result = await this.env.rpc.GitCommitCommand(
                TabRpcClient,
                { dir: cwd, message: message.trim(), amend },
                { route }
            );
            if (result.success) {
                globalStore.set(this.commitMessageAtom, "");
            }
            await this.fetchStatus();
            await this.fetchDiffForSelected();
            return result;
        } catch (e) {
            console.error("Failed to commit:", e);
            await this.fetchStatus();
            return { success: false, output: String(e) };
        } finally {
            globalStore.set(this.committingAtom, false);
        }
    }

    async push(username?: string, password?: string): Promise<GitPushResponse | null> {
        const cwd = globalStore.get(this.cwd);
        const route = makeConnRoute(globalStore.get(this.connection));
        globalStore.set(this.pushingAtom, true);
        try {
            const result = await this.env.rpc.GitPushCommand(
                TabRpcClient,
                { dir: cwd, username, password },
                { route }
            );

            // If auth needed and no credentials provided, check secret store
            if (result.authNeeded && !username) {
                const stored = await this.lookupCredentials(result.authRemote);
                if (stored.found) {
                    // Retry silently with stored credentials
                    globalStore.set(this.pushingAtom, false);
                    return this.push(stored.username, stored.password);
                } else {
                    // Show dialog for new credentials
                    this.showAuthDialog(result.authHost, result.authRemote, "", false, "repo");
                    return null;
                }
            }

            // If auth failed with provided credentials (retry case)
            if (!result.success && result.authNeeded) {
                // Determine the original scope from where credentials were found
                const stored = await this.lookupCredentials(result.authRemote);
                this.showAuthDialog(result.authHost, result.authRemote, username || "", true, stored.scope || "repo");
                return null;
            }

            return result;
        } catch (e) {
            console.error("Failed to push:", e);
            return { success: false, output: String(e), authNeeded: false, authError: "", authHost: "", authRemote: "" };
        } finally {
            globalStore.set(this.pushingAtom, false);
        }
    }

    async lookupCredentials(remote: string): Promise<GitCredentials> {
        const route = makeConnRoute(globalStore.get(this.connection));
        try {
            return await this.env.rpc.GitLookupCredentialsCommand(
                TabRpcClient,
                { remote },
                { route }
            );
        } catch (e) {
            console.error("Failed to lookup credentials:", e);
            return { username: "", password: "", found: false, scope: "" };
        }
    }

    async saveCredentials(remote: string, username: string, password: string, scope: string): Promise<void> {
        const route = makeConnRoute(globalStore.get(this.connection));
        try {
            await this.env.rpc.GitSaveCredentialsCommand(
                TabRpcClient,
                { remote, username, password, scope },
                { route }
            );
        } catch (e) {
            console.error("Failed to save credentials:", e);
            globalStore.set(this.authErrorAtom, "Failed to save credentials. Check the secret store.");
        }
    }

    showAuthDialog(host: string, remote: string, preFilledUsername: string, isRetry: boolean, scope: string) {
        globalStore.set(this.authHostAtom, host);
        globalStore.set(this.authRemoteAtom, remote);
        globalStore.set(this.authPreFilledUsernameAtom, preFilledUsername);
        globalStore.set(this.authIsRetryAtom, isRetry);
        globalStore.set(this.authScopeAtom, scope);
        globalStore.set(this.authErrorAtom, isRetry ? "Stored credentials were rejected." : null);
        globalStore.set(this.showAuthDialogAtom, true);
    }

    hideAuthDialog() {
        globalStore.set(this.showAuthDialogAtom, false);
        globalStore.set(this.authErrorAtom, null);
        globalStore.set(this.authHostAtom, "");
        globalStore.set(this.authRemoteAtom, "");
        globalStore.set(this.authPreFilledUsernameAtom, "");
        globalStore.set(this.authIsRetryAtom, false);
    }

    enterReview(files: ReviewFile[], filterLabel: string = "") {
        globalStore.set(this.reviewFilesAtom, files);
        globalStore.set(this.reviewActiveIndexAtom, 0);
        globalStore.set(this.reviewCollapsedAtom, new Map());
        globalStore.set(this.reviewFilterLabelAtom, filterLabel);
        globalStore.set(this.reviewModeAtom, true);
    }

    exitReview() {
        globalStore.set(this.reviewModeAtom, false);
        globalStore.set(this.reviewFilesAtom, []);
        globalStore.set(this.reviewActiveIndexAtom, 0);
        globalStore.set(this.diffCacheAtom, new Map());
    }

    toggleFileCollapse(path: string) {
        const collapsed = globalStore.get(this.reviewCollapsedAtom);
        const next = new Map(collapsed);
        next.set(path, !next.get(path));
        globalStore.set(this.reviewCollapsedAtom, next);
    }

    jumpToFile(index: number) {
        const files = globalStore.get(this.reviewFilesAtom);
        if (index < 0 || index >= files.length) return;
        globalStore.set(this.reviewActiveIndexAtom, index);
        const refs = globalStore.get(this.reviewFileRefsAtom);
        const el = refs.get(files[index].path);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    getDiffCacheKey(path: string, staged: boolean, untracked: boolean): string {
        return `${path}|${staged ? "staged" : "unstaged"}|${untracked ? "untracked" : ""}`;
    }

    async fetchDiffCached(path: string, staged: boolean, untracked: boolean): Promise<GitDiffResponse | null> {
        const cacheKey = this.getDiffCacheKey(path, staged, untracked);
        const cache = globalStore.get(this.diffCacheAtom);
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const diff = await this.fetchDiff(globalStore.get(this.cwd), path, staged, untracked);
        if (diff) {
            const next = new Map(cache);
            next.set(cacheKey, diff);
            globalStore.set(this.diffCacheAtom, next);
            this.updateFileChangeCounts(path, diff);
        }
        return diff;
    }

    updateFileChangeCounts(path: string, diff: GitDiffResponse) {
        const files = globalStore.get(this.reviewFilesAtom);
        let additions = 0;
        let deletions = 0;
        if (diff.hunks && diff.hunks.length > 0) {
            for (const hunk of diff.hunks) {
                additions += hunk.modifiedCount;
                deletions += hunk.originalCount;
            }
        } else {
            additions = diff.modified.split("\n").length;
            deletions = diff.original.split("\n").length;
        }
        globalStore.set(this.reviewFilesAtom, files.map(f =>
            f.path === path ? { ...f, additions, deletions } : f
        ));
    }

    async stageFileFromReview(path: string, staged: boolean, untracked: boolean) {
        const prevFiles = globalStore.get(this.reviewFilesAtom);
        if (untracked) {
            globalStore.set(this.reviewFilesAtom, prevFiles.map(f =>
                f.path === path ? { ...f, staged: true } : f
            ));
        } else if (staged) {
            globalStore.set(this.reviewFilesAtom, prevFiles.map(f =>
                f.path === path ? { ...f, staged: false } : f
            ));
        } else {
            globalStore.set(this.reviewFilesAtom, prevFiles.map(f =>
                f.path === path ? { ...f, staged: true } : f
            ));
        }

        this.invalidateDiffCache(path);

        try {
            const cwd = globalStore.get(this.cwd);
            const route = makeConnRoute(globalStore.get(this.connection));
            if (untracked || !staged) {
                await this.env.rpc.GitStageCommand(TabRpcClient, { dir: cwd, paths: [path] }, { route });
            } else {
                await this.env.rpc.GitUnstageCommand(TabRpcClient, { dir: cwd, paths: [path] }, { route });
            }
            await this.fetchStatus();
            this.updateReviewFilesFromStatus();
        } catch (e) {
            globalStore.set(this.reviewFilesAtom, prevFiles);
            console.error("[SCM] stageFileFromReview failed:", e);
        }
    }

    async revertFileFromReview(path: string, staged: boolean) {
        this.invalidateDiffCache(path);
        try {
            const cwd = globalStore.get(this.cwd);
            const diff = await this.fetchDiff(cwd, path, staged, false);
            const hunkCount = diff?.hunks?.length ?? 0;
            for (let i = 0; i < hunkCount; i++) {
                await this.revertHunk(path, i, staged);
            }
            await this.fetchStatus();
            this.updateReviewFilesFromStatus();
        } catch (e) {
            console.error("[SCM] revertFileFromReview failed:", e);
        }
    }

    invalidateDiffCache(path: string) {
        const cache = globalStore.get(this.diffCacheAtom);
        const next = new Map(cache);
        for (const key of next.keys()) {
            if (key.startsWith(path + "|")) {
                next.delete(key);
            }
        }
        globalStore.set(this.diffCacheAtom, next);
    }

    updateReviewFilesFromStatus() {
        const status = globalStore.get(this.statusAtom);
        const reviewFiles = globalStore.get(this.reviewFilesAtom);
        if (!status || reviewFiles.length === 0) return;

        const existingByPath = new Map(reviewFiles.map(f => [f.path, f]));

        const allFiles = [
            ...status.staged.map(f => ({ ...f, staged: true, additions: 0, deletions: 0 })),
            ...status.unstaged.map(f => ({ ...f, staged: false, additions: 0, deletions: 0 })),
            ...status.untracked.map(f => ({ ...f, staged: false, untracked: true, additions: 0, deletions: 0 })),
        ];

        const reviewPaths = new Set(reviewFiles.map(f => f.path));
        const updated = allFiles
            .filter(f => reviewPaths.has(f.path))
            .map(f => {
                const existing = existingByPath.get(f.path);
                if (existing && (existing.additions > 0 || existing.deletions > 0)) {
                    return { ...f, additions: existing.additions, deletions: existing.deletions };
                }
                return f;
            });
        if (updated.length > 0) {
            globalStore.set(this.reviewFilesAtom, updated);
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
