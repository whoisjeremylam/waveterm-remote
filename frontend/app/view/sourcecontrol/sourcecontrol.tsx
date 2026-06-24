// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { DirectoryDropdown } from "@/app/element/directorydropdown";
import { MonacoDiffViewer } from "@/app/monaco/monaco-react";
import { Tooltip } from "@/app/element/tooltip";
import { makeIconClass } from "@/util/util";
import * as jotai from "jotai";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { SourceControlViewModel } from "./sourcecontrol-model";
import type { FileTreeNode, SelectedFile } from "./types";

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
    <i className={makeIconClass(icon, false)} style={{ color, fontSize: "12px" }} />
));
FileIcon.displayName = "FileIcon";

// Single file row component
const FileRow = memo(({ data, isSelected, onClick }: { data: FileTreeNode; isSelected: boolean; onClick: () => void }) => {
    return (
        <div
            className={`flex items-center gap-2 px-2 py-1 cursor-pointer text-sm ${
                isSelected ? "bg-activebg text-white" : "hover:bg-hoverbg text-secondary"
            }`}
            onClick={onClick}
        >
            <StatusBadge status={data.status.status} color={data.status.color} />
            <FileIcon icon={data.status.icon} color={data.status.color} />
            <span className="truncate">{data.name}</span>
        </div>
    );
});
FileRow.displayName = "FileRow";

// Section header component
const SectionHeader = memo(({ label, count, expanded, onToggle }: { label: string; count: number; expanded: boolean; onToggle: () => void }) => (
    <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted hover:text-secondary"
        onClick={onToggle}
    >
        <i className={`fa-solid fa-chevron-${expanded ? "down" : "right"} text-[10px]`} />
        <span>{label}</span>
        <span className="text-[10px] bg-surface rounded px-1.5 py-0.5">{count}</span>
    </div>
));
SectionHeader.displayName = "SectionHeader";

// Empty state component
const EmptyState = memo(({ message }: { message: string }) => (
    <div className="flex flex-col items-center justify-center h-full text-muted text-sm">
        <i className="fa-solid fa-code-branch text-2xl mb-2 opacity-50" />
        <span>{message}</span>
    </div>
));
EmptyState.displayName = "EmptyState";

// Loading state component
const LoadingState = memo(() => (
    <div className="flex flex-col items-center justify-center h-full text-muted text-sm">
        <i className="fa-solid fa-spinner fa-spin text-2xl mb-2" />
        <span>Loading git status...</span>
    </div>
));
LoadingState.displayName = "LoadingState";

// Error state component
const ErrorState = memo(({ error, onRetry }: { error: string; onRetry: () => void }) => {
    const isNotGitRepo = error.includes("not a git repository");

    return (
        <div className="flex flex-col items-center justify-center h-full text-muted text-sm p-8">
            <i className="fa-solid fa-code-branch text-3xl mb-3 opacity-50" />
            {isNotGitRepo ? (
                <>
                    <span className="text-center mb-2">This directory is not a git repository</span>
                    <span className="text-xs text-muted text-center">
                        Select a directory containing a git repository to view source control status
                    </span>
                </>
            ) : (
                <>
                    <span className="text-center mb-2">{error}</span>
                    <button
                        className="px-3 py-1 text-xs bg-surface rounded hover:bg-hoverbg transition-colors mt-2"
                        onClick={onRetry}
                    >
                        Retry
                    </button>
                </>
            )}
        </div>
    );
});
ErrorState.displayName = "ErrorState";

// Diff panel component
const DiffPanel = memo(({ diff, fileName, viewMode }: { diff: GitDiffResponse | null; fileName: string; viewMode: "side-by-side" | "inline" }) => {
    if (!diff) {
        return (
            <EmptyState message="Select a file to view changes" />
        );
    }

    return (
        <div className="flex flex-col h-full w-full">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-sm text-secondary">
                <i className="fa-solid fa-file-code" />
                <span className="truncate">{fileName}</span>
            </div>
            <div className="flex-1 overflow-hidden">
                <MonacoDiffViewer
                    original={diff.original}
                    modified={diff.modified}
                    language={diff.language}
                    path={fileName}
                    options={{
                        renderSideBySide: viewMode === "side-by-side",
                        readOnly: true,
                        scrollBeyondLastLine: false,
                        fontSize: 12,
                        minimap: { enabled: false },
                    }}
                />
            </div>
        </div>
    );
});
DiffPanel.displayName = "DiffPanel";

// Main Source Control View component
export const SourceControlView = memo(({ model }: SourceControlViewProps) => {
    const status = jotai.useAtomValue(model.statusAtom);
    const selectedFile = jotai.useAtomValue(model.selectedFileAtom);
    const loading = jotai.useAtomValue(model.loadingAtom);
    const error = jotai.useAtomValue(model.errorAtom);
    const viewMode = jotai.useAtomValue(model.viewModeAtom);
    const diff = jotai.useAtomValue(model.diffAtom);
    const cwd = jotai.useAtomValue(model.cwd);
    const connection = jotai.useAtomValue(model.connection);
    const directoryDropdownOpen = jotai.useAtomValue(model.directoryDropdownOpen);

    const [stagedExpanded, setStagedExpanded] = useState(true);
    const [unstagedExpanded, setUnstagedExpanded] = useState(true);
    const [untrackedExpanded, setUntrackedExpanded] = useState(true);
    const [filter, setFilter] = useState("");
    const pathRef = useRef<HTMLDivElement>(null);

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

    const handleDirectorySelect = useCallback((path: string) => {
        globalStore.set(model.cwd, path);
        globalStore.set(model.directoryDropdownOpen, false);
    }, [model]);

    const handleDirectoryDropdownClose = useCallback(() => {
        globalStore.set(model.directoryDropdownOpen, false);
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

    if (error && !status) {
        return <ErrorState error={error} onRetry={handleRefresh} />;
    }

    if (!status || totalChanges === 0) {
        return <EmptyState message="No changes detected" />;
    }

    return (
        <div className="flex flex-col h-full w-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <div className="flex items-center gap-2 text-sm">
                    <i className="fa-solid fa-code-branch text-muted" />
                    <div ref={pathRef} className="cursor-pointer hover:text-white transition-colors">
                        {cwd}
                    </div>
                    <span className="text-muted text-xs">({totalChanges} changes)</span>
                </div>
                <div className="flex items-center gap-1">
                    <Tooltip content={viewMode === "side-by-side" ? "Switch to inline" : "Switch to side-by-side"} placement="bottom">
                        <button
                            className="p-1.5 rounded hover:bg-hoverbg text-secondary hover:text-white transition-colors"
                            onClick={handleViewModeToggle}
                        >
                            <i className={`fa-solid ${viewMode === "side-by-side" ? "fa-columns" : "fa-bars"} text-xs`} />
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
                </div>
            </div>

            {/* Directory Dropdown */}
            {directoryDropdownOpen && (
                <DirectoryDropdown
                    currentPath={cwd}
                    connection={connection === "local" ? "" : connection}
                    onSelect={handleDirectorySelect}
                    onClose={handleDirectoryDropdownClose}
                    anchorRef={pathRef}
                />
            )}

            {/* Search */}
            <div className="px-3 py-2 border-b border-border">
                <div className="flex items-center gap-2 px-2 py-1 bg-surface rounded text-sm">
                    <i className="fa-solid fa-search text-muted text-xs" />
                    <input
                        type="text"
                        placeholder="Filter files..."
                        className="flex-1 bg-transparent outline-none text-sm"
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
            <div className="flex flex-1 overflow-hidden">
                {/* File List */}
                <div className="w-1/3 border-r border-border overflow-y-auto">
                    {/* Staged */}
                    {filteredStaged.length > 0 && (
                        <div>
                            <SectionHeader
                                label="Staged"
                                count={filteredStaged.length}
                                expanded={stagedExpanded}
                                onToggle={() => setStagedExpanded(!stagedExpanded)}
                            />
                            {stagedExpanded && filteredStaged.map((file) => (
                                <FileRow
                                    key={`staged-${file.path}`}
                                    data={{ id: file.path, name: file.path.split("/").pop() || file.path, path: file.path, status: file, isDirectory: false }}
                                    isSelected={selectedFile?.path === file.path && selectedFile?.staged === true}
                                    onClick={() => handleFileSelect({ path: file.path, staged: true })}
                                />
                            ))}
                        </div>
                    )}

                    {/* Unstaged */}
                    {filteredUnstaged.length > 0 && (
                        <div>
                            <SectionHeader
                                label="Changes"
                                count={filteredUnstaged.length}
                                expanded={unstagedExpanded}
                                onToggle={() => setUnstagedExpanded(!unstagedExpanded)}
                            />
                            {unstagedExpanded && filteredUnstaged.map((file) => (
                                <FileRow
                                    key={`unstaged-${file.path}`}
                                    data={{ id: file.path, name: file.path.split("/").pop() || file.path, path: file.path, status: file, isDirectory: false }}
                                    isSelected={selectedFile?.path === file.path && selectedFile?.staged === false}
                                    onClick={() => handleFileSelect({ path: file.path, staged: false })}
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
                            />
                            {untrackedExpanded && filteredUntracked.map((file) => (
                                <FileRow
                                    key={`untracked-${file.path}`}
                                    data={{ id: file.path, name: file.path.split("/").pop() || file.path, path: file.path, status: file, isDirectory: false }}
                                    isSelected={selectedFile?.path === file.path && selectedFile?.staged === false}
                                    onClick={() => handleFileSelect({ path: file.path, staged: false })}
                                />
                            ))}
                        </div>
                    )}
                </div>

                {/* Diff Panel */}
                <div className="flex-1 overflow-hidden">
                    <DiffPanel
                        diff={diff}
                        fileName={selectedFile?.path || ""}
                        viewMode={viewMode}
                    />
                </div>
            </div>
        </div>
    );
});

SourceControlView.displayName = "SourceControlView";
