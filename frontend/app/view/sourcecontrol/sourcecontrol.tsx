// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { DirectoryDropdown } from "@/app/element/directorydropdown";
import { MonacoDiffViewer } from "@/app/monaco/monaco-react";
import { Tooltip } from "@/app/element/tooltip";
import { makeIconClass } from "@/util/util";
import * as jotai from "jotai";
import * as monaco from "monaco-editor";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { DiffGutter } from "./DiffGutter";
import { ReviewMode } from "./review-mode";
import type { SourceControlViewModel } from "./sourcecontrol-model";
import type { FileTreeNode, ReviewFile, SelectedFile } from "./types";

type SourceControlViewProps = ViewComponentProps<SourceControlViewModel>;

// File status badge component
const StatusBadge = memo(({ status, color }: { status: string; color: string }) => (
    <span
        className="inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded"
        style={{ color, backgroundColor: `${color}20` }}
    >
        {status}
    </span>
));
StatusBadge.displayName = "StatusBadge";

// File icon component
const FileIcon = memo(({ icon, color }: { icon: string; color: string }) => (
    <i className={makeIconClass(icon, false)} style={{ color, fontSize: "11px" }} />
));
FileIcon.displayName = "FileIcon";

// Single file row component
const FileRow = memo(({ data, isSelected, onClick, onMiddleClick, stageLabel, onStage }: {
    data: FileTreeNode;
    isSelected: boolean;
    onClick: () => void;
    onMiddleClick?: () => void;
    stageLabel?: string;
    onStage?: () => void;
}) => {
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button === 1 && onMiddleClick) {
            e.preventDefault();
            onMiddleClick();
        }
    }, [onMiddleClick]);

    return (
        <div
            className={`flex items-center gap-2 px-2 py-1 cursor-pointer text-xs group ${
                isSelected ? "bg-activebg text-white" : "hover:bg-hoverbg text-secondary"
            }`}
            onClick={onClick}
            onMouseDown={handleMouseDown}
        >
            <StatusBadge status={data.status.status} color={data.status.color} />
            <FileIcon icon={data.status.icon} color={data.status.color} />
            <span className="truncate flex-1">{data.name}</span>
            {onStage && stageLabel && (
                <button
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-hoverbg transition-opacity"
                    title={stageLabel}
                    onClick={(e) => { e.stopPropagation(); console.log("[SCM] stage button clicked"); onStage(); }}
                >
                    <i className={`fa-solid ${stageLabel === "Stage" ? "fa-plus" : "fa-minus"} text-[10px]"`} />
                </button>
            )}
        </div>
    );
});
FileRow.displayName = "FileRow";

// Section header component
const SectionHeader = memo(({ label, count, expanded, onToggle, actionLabel, onAction }: {
    label: string;
    count: number;
    expanded: boolean;
    onToggle: () => void;
    actionLabel?: string;
    onAction?: () => void;
}) => (
    <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-secondary group"
        onClick={onToggle}
    >
        <i className={`fa-solid fa-chevron-${expanded ? "down" : "right"} text-[10px]`} />
        <span>{label}</span>
        <span className="text-[10px] bg-surface rounded px-1.5 py-0.5">{count}</span>
        {actionLabel && onAction && count > 0 && (
            <Tooltip content={actionLabel} placement="bottom">
                <button
                    className="ml-auto opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-hoverbg transition-opacity"
                    onClick={(e) => { e.stopPropagation(); onAction(); }}
                >
                    <i className="fa-solid fa-plus text-[10px]" />
                </button>
            </Tooltip>
        )}
    </div>
));
SectionHeader.displayName = "SectionHeader";

// Empty state component
const EmptyState = memo(({ message }: { message: string }) => (
    <div className="flex flex-col items-center justify-center h-full text-muted text-xs">
        <i className="fa-solid fa-code-branch text-xl mb-2 opacity-50" />
        <span>{message}</span>
    </div>
));
EmptyState.displayName = "EmptyState";

// Loading state component
const LoadingState = memo(() => (
    <div className="flex flex-col items-center justify-center h-full text-muted text-xs">
        <i className="fa-solid fa-spinner fa-spin text-xl mb-2" />
        <span>Loading git status...</span>
    </div>
));
LoadingState.displayName = "LoadingState";

// Git Auth Dialog component
const GitAuthDialog = memo(({ model }: { model: SourceControlViewModel }) => {
    const showAuthDialog = jotai.useAtomValue(model.showAuthDialogAtom);
    const authError = jotai.useAtomValue(model.authErrorAtom);
    const authHost = jotai.useAtomValue(model.authHostAtom);
    const authRemote = jotai.useAtomValue(model.authRemoteAtom);
    const authPreFilledUsername = jotai.useAtomValue(model.authPreFilledUsernameAtom);
    const authIsRetry = jotai.useAtomValue(model.authIsRetryAtom);

    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [saveToSecrets, setSaveToSecrets] = useState(false);
    const [saveScope, setSaveScope] = useState<"repo" | "host">("repo");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Pre-fill username when dialog opens
    useEffect(() => {
        if (showAuthDialog) {
            setUsername(authPreFilledUsername);
            setPassword("");
            setSaveToSecrets(false);
            setSaveScope("repo");
        }
    }, [showAuthDialog, authPreFilledUsername]);

    const handleSubmit = useCallback(async () => {
        if (!username || !password || isSubmitting) return;

        setIsSubmitting(true);
        try {
            // Retry push with new credentials
            const result = await model.push(username, password);

            if (result?.success) {
                // Save credentials if requested
                if (saveToSecrets) {
                    await model.saveCredentials(authRemote, username, password, saveScope);
                }
                model.hideAuthDialog();
            } else if (result?.authNeeded) {
                // Auth failed again, show error
                globalStore.set(model.authErrorAtom, result.authError || "Authentication failed. Check your credentials and try again.");
            } else if (result && !result.success) {
                // Other error (not auth), show the error message
                globalStore.set(model.authErrorAtom, result.output || "Push failed. Please try again.");
            }
            // If result is null, push() already showed the dialog with error
        } finally {
            setIsSubmitting(false);
        }
    }, [model, username, password, authRemote, saveToSecrets, saveScope, isSubmitting]);

    const handleCancel = useCallback(() => {
        model.hideAuthDialog();
    }, [model]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        } else if (e.key === "Escape") {
            handleCancel();
        }
    }, [handleSubmit, handleCancel]);

    if (!showAuthDialog) {
        return null;
    }

    // Extract display host from remote URL
    const displayHost = authHost || (authRemote ? authRemote.replace(/^https?:\/\//, '').split('/')[0] : "remote");

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
            <div className="bg-[#1e1e1e] border border-[#3e3e3e] rounded-lg shadow-2xl w-96 p-6">
                <div className="flex items-center justify-center gap-2 mb-4">
                    <i className="fa-solid fa-lock text-[#888]" />
                    <h3 className="text-sm font-medium text-white">
                        {authIsRetry ? "Authentication Failed" : "Authentication Required"}
                    </h3>
                </div>

                {authError && (
                    <div className="mb-4 p-2 bg-red-500/20 border border-red-500/30 rounded text-xs text-red-400">
                        {authError}
                    </div>
                )}

                <p className="text-xs text-[#888] mb-4">
                    {authIsRetry
                        ? `Stored credentials for ${displayHost} were rejected. Enter new credentials:`
                        : `git push to ${displayHost}`
                    }
                </p>

                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <label className="text-xs text-[#888] w-20 text-right">Username</label>
                        <input
                            type="text"
                            className="flex-1 px-3 py-2 text-xs bg-[#2d2d2d] border border-[#3e3e3e] rounded outline-none focus:border-[#555] text-white"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Username"
                            autoFocus
                        />
                    </div>

                    <div className="flex items-center gap-3">
                        <label className="text-xs text-[#888] w-20 text-right">Password</label>
                        <input
                            type="password"
                            className="flex-1 px-3 py-2 text-xs bg-[#2d2d2d] border border-[#3e3e3e] rounded outline-none focus:border-[#555] text-white"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Password or token"
                        />
                    </div>

                    {!authIsRetry && (
                        <div className="ml-20">
                            <label className="flex items-center gap-2 cursor-pointer mb-2">
                                <input
                                    type="checkbox"
                                    checked={saveToSecrets}
                                    onChange={(e) => setSaveToSecrets(e.target.checked)}
                                    className="w-3 h-3"
                                />
                                <span className="text-xs text-[#888]">Save credentials in secrets store</span>
                            </label>

                            {saveToSecrets && (
                                <div className="flex gap-4 ml-5">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="saveScope"
                                            checked={saveScope === "repo"}
                                            onChange={() => setSaveScope("repo")}
                                            className="w-3 h-3"
                                        />
                                        <span className="text-xs text-[#888]">This repo</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="saveScope"
                                            checked={saveScope === "host"}
                                            onChange={() => setSaveScope("host")}
                                            className="w-3 h-3"
                                        />
                                        <span className="text-xs text-[#888]">All repos for this remote</span>
                                    </label>
                                </div>
                            )}
                        </div>
                    )}

                    {authIsRetry && (
                        <div className="ml-20">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={true}
                                    readOnly
                                    className="w-3 h-3"
                                />
                                <span className="text-xs text-[#888]">Update stored credentials</span>
                            </label>
                        </div>
                    )}
                </div>

                <div className="flex justify-end gap-2 mt-6">
                    <button
                        className="px-3 py-1.5 text-xs rounded bg-[#3e3e3e] hover:bg-[#4e4e4e] text-white transition-colors"
                        onClick={handleCancel}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </button>
                    <button
                        className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                            username && password && !isSubmitting
                                ? "bg-[#0e639c] hover:bg-[#1177bb] text-white"
                                : "bg-[#3e3e3e] text-[#888] cursor-not-allowed"
                        }`}
                        onClick={handleSubmit}
                        disabled={!username || !password || isSubmitting}
                    >
                        {isSubmitting ? (
                            <span className="flex items-center gap-2">
                                <i className="fa-solid fa-spinner fa-spin" />
                                Authenticating...
                            </span>
                        ) : (
                            "Authenticate"
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
});
GitAuthDialog.displayName = "GitAuthDialog";

// Diff panel component
const DiffPanel = memo(({ diff, fileName, viewMode, wordWrap, isStaged, onStageHunk, onRevertHunk }: {
    diff: GitDiffResponse | null;
    fileName: string;
    viewMode: "side-by-side" | "inline";
    wordWrap: boolean;
    isStaged: boolean;
    onStageHunk: (hunkIndex: number) => void;
    onRevertHunk: (hunkIndex: number) => void;
}) => {
    const [diffEditor, setDiffEditor] = useState<monaco.editor.IStandaloneDiffEditor | null>(null);

    const diffViewerOptions = useMemo(() => ({
        renderSideBySide: viewMode === "side-by-side",
        readOnly: true,
        scrollBeyondLastLine: false,
        fontSize: 12,
        fontFamily: "Hack",
        minimap: { enabled: false },
        wordWrap: wordWrap ? "on" as const : "off" as const,
    }), [viewMode, wordWrap]);

    const handleMount = useCallback((editor: monaco.editor.IStandaloneDiffEditor) => {
        setDiffEditor(editor);
    }, []);

    // Update renderSideBySide when viewMode changes without remounting
    useEffect(() => {
        if (diffEditor) {
            diffEditor.updateOptions({ renderSideBySide: viewMode === "side-by-side" });
        }
    }, [diffEditor, viewMode]);

    if (!diff) {
        return (
            <EmptyState message="Select a file to view changes" />
        );
    }

    return (
        <div className="flex flex-col h-full w-full">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs text-secondary">
                <i className="fa-solid fa-file-code" />
                <span className="truncate">{fileName}</span>
            </div>
            <div className="flex-1 overflow-hidden relative">
                <MonacoDiffViewer
                    original={diff.original}
                    modified={diff.modified}
                    language={diff.language}
                    path={fileName}
                    options={diffViewerOptions}
                    onMount={handleMount}
                />
                {diffEditor && diff.hunks && diff.hunks.length > 0 && (
                    <DiffGutter
                        diffEditor={diffEditor}
                        hunks={diff.hunks.map(h => ({
                            header: h.header,
                            modifiedStart: h.modifiedStart,
                            modifiedCount: h.modifiedCount,
                            originalStart: h.originalStart,
                            originalCount: h.originalCount,
                        }))}
                        isStaged={isStaged}
                        onStageHunk={onStageHunk}
                        onRevertHunk={onRevertHunk}
                    />
                )}
            </div>
        </div>
    );
});
DiffPanel.displayName = "DiffPanel";

// Commit message input component
const CommitInput = memo(({ model, hasStagedChanges, hasUnpushedCommits }: {
    model: SourceControlViewModel;
    hasStagedChanges: boolean;
    hasUnpushedCommits: boolean;
}) => {
    const commitMessage = jotai.useAtomValue(model.commitMessageAtom);
    const committing = jotai.useAtomValue(model.committingAtom);
    const pushing = jotai.useAtomValue(model.pushingAtom);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        globalStore.set(model.commitMessageAtom, e.target.value);
        // Auto-grow: reset height then set to scrollHeight
        e.target.style.height = "auto";
        e.target.style.height = `${e.target.scrollHeight}px`;
    }, [model]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (commitMessage.trim() && hasStagedChanges && !committing) {
                model.commit();
            }
        }
    }, [model, commitMessage, hasStagedChanges, committing]);

    const handleCommit = useCallback(() => {
        if (commitMessage.trim() && hasStagedChanges && !committing) {
            model.commit();
        }
    }, [model, commitMessage, hasStagedChanges, committing]);

    const handlePush = useCallback(async () => {
        if (pushing || committing) return;
        model.push();
    }, [model, pushing, committing]);

    return (
        <div className="flex flex-col gap-2">
            <textarea
                className="w-full px-2 py-1.5 text-xs bg-surface border border-border rounded resize-none outline-none focus:border-zinc-500 placeholder:text-muted overflow-hidden text-ellipsis [&::placeholder]:whitespace-nowrap [&::placeholder]:overflow-hidden [&::placeholder]:text-ellipsis"
                placeholder="Commit message (Ctrl+Enter to commit)"
                rows={1}
                value={commitMessage}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                disabled={committing || pushing}
            />
            <div className="flex gap-2">
                <button
                    className={`flex-1 px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                        commitMessage.trim() && hasStagedChanges && !committing && !pushing
                            ? "bg-zinc-600 hover:bg-zinc-500 text-white"
                            : "bg-surface text-muted cursor-not-allowed"
                    }`}
                    onClick={handleCommit}
                    disabled={!commitMessage.trim() || !hasStagedChanges || committing || pushing}
                >
                    {committing ? (
                        <span className="flex items-center justify-center gap-2">
                            <i className="fa-solid fa-spinner fa-spin" />
                            Committing...
                        </span>
                    ) : (
                        "Commit"
                    )}
                </button>
                <button
                    className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                        hasUnpushedCommits && !pushing && !committing
                            ? "bg-zinc-600 hover:bg-zinc-500 text-white"
                            : "bg-surface text-muted cursor-not-allowed"
                    }`}
                    onClick={handlePush}
                    disabled={!hasUnpushedCommits || pushing || committing}
                    title="Push to remote"
                >
                    {pushing ? (
                        <i className="fa-solid fa-spinner fa-spin" />
                    ) : (
                        <i className="fa-solid fa-arrow-up" />
                    )}
                </button>
            </div>
        </div>
    );
});
CommitInput.displayName = "CommitInput";

// Review mode dropdown button
const ReviewDropdown = memo(({ totalCount, stagedCount, unstagedCount, onReviewAll, onReviewStaged, onReviewUnstaged }: {
    totalCount: number;
    stagedCount: number;
    unstagedCount: number;
    onReviewAll: () => void;
    onReviewStaged: () => void;
    onReviewUnstaged: () => void;
}) => {
    const [open, setOpen] = useState(false);

    if (totalCount === 0) return null;

    return (
        <div className="relative">
            <button
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-surface hover:bg-hoverbg text-secondary hover:text-white transition-colors"
                onClick={() => setOpen(!open)}
            >
                <i className="fa-solid fa-eye text-[10px]" />
                <span>Review ({totalCount})</span>
                <i className="fa-solid fa-chevron-down text-[8px]" />
            </button>
            {open && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 bg-[#252526] border border-[#3e3e3e] rounded shadow-lg min-w-[160px]">
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs text-secondary hover:bg-hoverbg hover:text-white"
                            onClick={() => { setOpen(false); onReviewAll(); }}
                        >
                            Review All ({totalCount})
                        </button>
                        {stagedCount > 0 && (
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs text-secondary hover:bg-hoverbg hover:text-white"
                                onClick={() => { setOpen(false); onReviewStaged(); }}
                            >
                                Review Staged ({stagedCount})
                            </button>
                        )}
                        {unstagedCount > 0 && (
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs text-secondary hover:bg-hoverbg hover:text-white"
                                onClick={() => { setOpen(false); onReviewUnstaged(); }}
                            >
                                Review Unstaged ({unstagedCount})
                            </button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
});
ReviewDropdown.displayName = "ReviewDropdown";

// Main Source Control View component
export const SourceControlView = memo(({ model }: SourceControlViewProps) => {
    const status = jotai.useAtomValue(model.statusAtom);
    const selectedFile = jotai.useAtomValue(model.selectedFileAtom);
    const loading = jotai.useAtomValue(model.loadingAtom);
    const viewMode = jotai.useAtomValue(model.viewModeAtom);
    const diff = jotai.useAtomValue(model.diffAtom);
    const cwd = jotai.useAtomValue(model.cwd);
    const connection = jotai.useAtomValue(model.connection);
    const directoryDropdownOpen = jotai.useAtomValue(model.directoryDropdownOpen);
    const reviewMode = jotai.useAtomValue(model.reviewModeAtom);

    const [stagedExpanded, setStagedExpanded] = useState(true);
    const [unstagedExpanded, setUnstagedExpanded] = useState(true);
    const [untrackedExpanded, setUntrackedExpanded] = useState(true);
    const [filter, setFilter] = useState("");
    const [wordWrap, setWordWrap] = useState(false);

    const handleFileSelect = useCallback((file: SelectedFile) => {
        globalStore.set(model.selectedFileAtom, file);
    }, [model]);

    const handleRefresh = useCallback(() => {
        model.refresh();
    }, [model]);

    const handleViewModeToggle = useCallback(() => {
        const newMode = viewMode === "side-by-side" ? "inline" : "side-by-side";
        globalStore.set(model.viewModeAtom, newMode);
    }, [model, viewMode]);

    const handleWordWrapToggle = useCallback(() => {
        setWordWrap((prev) => !prev);
    }, []);

    const handleDirectorySelect = useCallback((path: string) => {
        model.changeDirectory(path);
    }, [model]);

    const handleDirectoryDropdownClose = useCallback(() => {
        globalStore.set(model.directoryDropdownOpen, false);
    }, [model]);

    const isRegularFile = (f: GitFileChange) => !f.path.endsWith("/") && f.path.length > 0;

    const handleReviewAll = useCallback(() => {
        const st = globalStore.get(model.statusAtom);
        const allFiles: ReviewFile[] = [
            ...(st?.staged?.filter(isRegularFile).map(f => ({ ...f, staged: true, additions: 0, deletions: 0 })) ?? []),
            ...(st?.unstaged?.filter(isRegularFile).map(f => ({ ...f, staged: false, additions: 0, deletions: 0 })) ?? []),
            ...(st?.untracked?.filter(isRegularFile).map(f => ({ ...f, staged: false, untracked: true, additions: 0, deletions: 0 })) ?? []),
        ];
        model.enterReview(allFiles, "All");
    }, [model]);

    const handleReviewStaged = useCallback(() => {
        const st = globalStore.get(model.statusAtom);
        const files: ReviewFile[] = (st?.staged?.filter(isRegularFile).map(f => ({ ...f, staged: true, additions: 0, deletions: 0 })) ?? []);
        model.enterReview(files, "Staged");
    }, [model]);

    const handleReviewUnstaged = useCallback(() => {
        const st = globalStore.get(model.statusAtom);
        const files: ReviewFile[] = [
            ...(st?.unstaged?.filter(isRegularFile).map(f => ({ ...f, staged: false, additions: 0, deletions: 0 })) ?? []),
            ...(st?.untracked?.filter(isRegularFile).map(f => ({ ...f, staged: false, untracked: true, additions: 0, deletions: 0 })) ?? []),
        ];
        model.enterReview(files, "Unstaged");
    }, [model]);

    const handleExitReview = useCallback(() => {
        model.exitReview();
    }, [model]);

    const containerRef = useRef<HTMLDivElement>(null);
    const handleReviewAllRef = useRef(handleReviewAll);
    handleReviewAllRef.current = handleReviewAll;

    // Keyboard shortcut: Ctrl/Cmd+Shift+R to enter review mode — scoped to SCM container (fix #5, #7)
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "R") {
                e.preventDefault();
                handleReviewAllRef.current();
            }
        };
        container.addEventListener("keydown", handleKeyDown);
        return () => container.removeEventListener("keydown", handleKeyDown);
    }, []);

    const handleStageFile = useCallback((path: string) => {
        console.log("[SCM] handleStageFile clicked:", path);
        model.stageFiles([path]);
    }, [model]);

    const handleUnstageFile = useCallback((path: string) => {
        console.log("[SCM] handleUnstageFile clicked:", path);
        model.unstageFiles([path]);
    }, [model]);

    const handleStageAll = useCallback(() => {
        const unstaged = status?.unstaged?.map(f => f.path) ?? [];
        const untracked = status?.untracked?.map(f => f.path) ?? [];
        model.stageFiles([...unstaged, ...untracked]);
    }, [model, status]);

    const handleUnstageAll = useCallback(() => {
        const staged = status?.staged?.map(f => f.path) ?? [];
        model.unstageFiles(staged);
    }, [model, status]);

    const handleMiddleClickFile = useCallback((path: string, staged: boolean, untracked: boolean) => {
        if (!isRegularFile({ path } as any)) return;
        const st = globalStore.get(model.statusAtom);
        if (!st) return;
        const allFiles = [
            ...(st.staged?.map(f => ({ ...f, staged: true, additions: 0, deletions: 0 })) ?? []),
            ...(st.unstaged?.map(f => ({ ...f, staged: false, additions: 0, deletions: 0 })) ?? []),
            ...(st.untracked?.map(f => ({ ...f, staged: false, untracked: true, additions: 0, deletions: 0 })) ?? []),
        ];
        const file = allFiles.find(f => f.path === path);
        if (file) {
            model.enterReview([{ ...file, staged, untracked }]);
        }
    }, [model]);

    // Filter files
    const filteredStaged = useMemo(() => {
        if (!status?.staged) return [];
        if (!filter) return status.staged;
        return status.staged.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
    }, [status?.staged, filter]);

    const filteredUnstaged = useMemo(() => {
        if (!status?.unstaged) return [];
        if (!filter) return status.unstaged;
        return status.unstaged.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
    }, [status?.unstaged, filter]);

    const filteredUntracked = useMemo(() => {
        if (!status?.untracked) return [];
        if (!filter) return status.untracked;
        return status.untracked.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
    }, [status?.untracked, filter]);

    const totalChanges = (status?.staged?.length || 0) + (status?.unstaged?.length || 0) + (status?.untracked?.length || 0);

    if (loading && !status) {
        return <LoadingState />;
    }

    return (
        <div ref={containerRef} className="flex flex-col h-full w-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <div className="flex items-center gap-2 text-xs">
                    <i className="fa-solid fa-code-branch text-muted" />
                    <span className="font-medium">{status?.branch || "detached"}</span>
                    <span className="text-muted text-[10px]">({totalChanges} changes)</span>
                </div>
                <div className="flex items-center gap-1">
                    <Tooltip content={selectedFile?.untracked ? "Not available for untracked files" : (viewMode === "side-by-side" ? "Switch to inline" : "Switch to side-by-side")} placement="bottom">
                        <button
                            className={`p-1.5 rounded transition-colors ${
                                selectedFile?.untracked
                                    ? "text-muted cursor-not-allowed"
                                    : "hover:bg-hoverbg text-secondary hover:text-white"
                            }`}
                            onClick={handleViewModeToggle}
                            disabled={!!selectedFile?.untracked}
                        >
                            <i className={`fa-solid ${viewMode === "side-by-side" ? "fa-columns" : "fa-bars"} text-xs`} />
                        </button>
                    </Tooltip>
                    <Tooltip content={wordWrap ? "Disable word wrap" : "Enable word wrap"} placement="bottom">
                        <button
                            className={`p-1.5 rounded hover:bg-hoverbg transition-colors ${wordWrap ? "text-white" : "text-secondary hover:text-white"}`}
                            onClick={handleWordWrapToggle}
                        >
                            <i className="fa-solid fa-text-width text-xs" />
                        </button>
                    </Tooltip>
                    <Tooltip content="Refresh" placement="bottom">
                        <button
                            className="p-1.5 rounded hover:bg-hoverbg text-secondary hover:text-white transition-colors"
                            onClick={handleRefresh}
                        >
                            <i className="fa-solid fa-arrows-rotate text-xs" />
                        </button>
                    </Tooltip>
                    <ReviewDropdown
                        totalCount={totalChanges}
                        stagedCount={status?.staged?.length || 0}
                        unstagedCount={(status?.unstaged?.length || 0) + (status?.untracked?.length || 0)}
                        onReviewAll={handleReviewAll}
                        onReviewStaged={handleReviewStaged}
                        onReviewUnstaged={handleReviewUnstaged}
                    />
                </div>
            </div>

            {/* Directory Dropdown */}
            {directoryDropdownOpen && (
                <DirectoryDropdown
                    currentPath={cwd}
                    connection={connection === "local" ? "" : connection}
                    onSelect={handleDirectorySelect}
                    onClose={handleDirectoryDropdownClose}
                    anchorRef={model.pathRef}
                    dirsOnly
                />
            )}

            {reviewMode ? (
                <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                    <ReviewMode model={model} onExit={handleExitReview} />
                </div>
            ) : (
                <>
            {/* Search */}
            <div className="px-3 py-2 border-b border-border">
                <div className="flex items-center gap-2 px-2 py-1 bg-surface rounded text-xs">
                    <i className="fa-solid fa-search text-muted text-[10px]" />
                    <input
                        type="text"
                        placeholder="Filter files..."
                        className="flex-1 bg-transparent outline-none text-xs"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                    {filter && (
                        <button
                            className="text-muted hover:text-white"
                            onClick={() => setFilter("")}
                        >
                            <i className="fa-solid fa-times text-xs" />
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <PanelGroup direction="horizontal" className="flex-1 overflow-hidden">
                {/* File List */}
                <Panel defaultSize={33} minSize={15} maxSize={60}>
                    <div className="h-full flex flex-col border-r border-border">
                        {/* Commit Message Input - always visible */}
                        <div className="p-2 border-b border-border">
                            <CommitInput
                                model={model}
                                hasStagedChanges={filteredStaged.length > 0}
                                hasUnpushedCommits={true}
                            />
                        </div>

                        {/* File Sections */}
                        <div className="flex-1 overflow-y-auto">
                            {/* Staged */}
                        {filteredStaged.length > 0 && (
                            <div>
                                <SectionHeader
                                    label="Staged"
                                    count={filteredStaged.length}
                                    expanded={stagedExpanded}
                                    onToggle={() => setStagedExpanded(!stagedExpanded)}
                                    actionLabel="Unstage All"
                                    onAction={handleUnstageAll}
                                />
                                {stagedExpanded && filteredStaged.map((file) => (
                                    <FileRow
                                        key={`staged-${file.path}`}
                                        data={{ id: file.path, name: file.path.split("/").pop() || file.path, path: file.path, status: file, isDirectory: false }}
                                        isSelected={selectedFile?.path === file.path && selectedFile?.staged === true}
                                        onClick={() => handleFileSelect({ path: file.path, staged: true })}
                                        onMiddleClick={() => handleMiddleClickFile(file.path, true, false)}
                                        stageLabel="Unstage"
                                        onStage={() => handleUnstageFile(file.path)}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Unstaged */}
                        {filteredUnstaged.length > 0 && (
                            <div>
                                <SectionHeader
                                    label="Changed"
                                    count={filteredUnstaged.length}
                                    expanded={unstagedExpanded}
                                    onToggle={() => setUnstagedExpanded(!unstagedExpanded)}
                                    actionLabel="Stage All"
                                    onAction={handleStageAll}
                                />
                                {unstagedExpanded && filteredUnstaged.map((file) => (
                                    <FileRow
                                        key={`unstaged-${file.path}`}
                                        data={{ id: file.path, name: file.path.split("/").pop() || file.path, path: file.path, status: file, isDirectory: false }}
                                        isSelected={selectedFile?.path === file.path && selectedFile?.staged === false}
                                        onClick={() => handleFileSelect({ path: file.path, staged: false })}
                                        onMiddleClick={() => handleMiddleClickFile(file.path, false, false)}
                                        stageLabel="Stage"
                                        onStage={() => handleStageFile(file.path)}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Untracked */}
                        {filteredUntracked.length > 0 && (
                            <div>
                                <SectionHeader
                                    label="Untracked"
                                    count={filteredUntracked.length}
                                    expanded={untrackedExpanded}
                                    onToggle={() => setUntrackedExpanded(!untrackedExpanded)}
                                    actionLabel="Stage All"
                                    onAction={handleStageAll}
                                />
                                {untrackedExpanded && filteredUntracked.map((file) => (
                                    <FileRow
                                        key={`untracked-${file.path}`}
                                        data={{ id: file.path, name: file.path.split("/").pop() || file.path, path: file.path, status: file, isDirectory: false }}
                                        isSelected={selectedFile?.path === file.path && selectedFile?.untracked === true}
                                        onClick={() => handleFileSelect({ path: file.path, staged: false, untracked: true })}
                                        onMiddleClick={() => handleMiddleClickFile(file.path, false, true)}
                                        stageLabel="Stage"
                                        onStage={() => handleStageFile(file.path)}
                                    />
                                ))}
                            </div>
                        )}
                        </div>
                    </div>
                </Panel>
                <PanelResizeHandle className="w-0.5 bg-transparent hover:bg-zinc-500/20 transition-colors" />
                {/* Diff Panel */}
                <Panel defaultSize={67} minSize={30}>
                    <div className="h-full overflow-hidden">
                        <DiffPanel
                            diff={diff}
                            fileName={selectedFile?.path || ""}
                            viewMode={selectedFile?.untracked ? "inline" : viewMode}
                            wordWrap={wordWrap}
                            isStaged={selectedFile?.staged ?? false}
                            onStageHunk={(hunkIndex) => model.stageHunk(selectedFile?.path || "", hunkIndex)}
                            onRevertHunk={(hunkIndex) => model.revertHunk(selectedFile?.path || "", hunkIndex, selectedFile?.staged ?? false)}
                        />
                    </div>
                </Panel>
            </PanelGroup>
                </>
            )}

            {/* Auth Dialog */}
            <GitAuthDialog model={model} />
        </div>
    );
});

SourceControlView.displayName = "SourceControlView";
