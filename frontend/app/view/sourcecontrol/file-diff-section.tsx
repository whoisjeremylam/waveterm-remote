// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MonacoDiffViewer } from "@/app/monaco/monaco-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import * as jotai from "jotai";
import { DiffGutter } from "./DiffGutter";
import type { SourceControlViewModel } from "./sourcecontrol-model";
import type { ReviewFile } from "./types";

type FileDiffSectionProps = {
    model: SourceControlViewModel;
    file: ReviewFile;
    index: number;
    isCollapsed: boolean;
    onToggleCollapse: () => void;
    onStage: () => void;
    onRevert: () => void;
    onRegisterRef: (path: string, el: HTMLDivElement | null) => void;
    onVisible: (index: number) => void;
    onEditorRef: (path: string, editor: monaco.editor.IStandaloneDiffEditor | null) => void;
};

export const FileDiffSection = memo(({ model, file, index, isCollapsed, onToggleCollapse, onStage, onRevert, onRegisterRef, onVisible, onEditorRef }: FileDiffSectionProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [shouldMount, setShouldMount] = useState(false);
    const [diff, setDiff] = useState<GitDiffResponse | null>(null);
    const [diffError, setDiffError] = useState(false);
    const [diffEditor, setDiffEditor] = useState<monaco.editor.IStandaloneDiffEditor | null>(null);
    const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
    const stagedRef = useRef(file.staged);
    const viewMode = jotai.useAtomValue(model.viewModeAtom);

    const isStaged = file.staged;

    const editorHeight = useMemo(() => {
        if (!diff) return undefined;
        const lineCount = viewMode === "side-by-side"
            ? Math.max(diff.original.split("\n").length, diff.modified.split("\n").length)
            : diff.original.split("\n").length + diff.modified.split("\n").length;
        return Math.max(120, lineCount * 18 + 40);
    }, [diff, viewMode]);

    // Track rendered height of diff content for placeholder when unmounted
    useEffect(() => {
        const el = contentRef.current;
        if (!el) return;

        const observer = new ResizeObserver(([entry]) => {
            const height = entry.contentRect.height;
            if (height > 0) {
                setContentHeight(height);
            }
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [shouldMount, diff]);

    // Reset diff when staged state changes (critical #3)
    useEffect(() => {
        if (stagedRef.current !== file.staged) {
            stagedRef.current = file.staged;
            setDiff(null);
            setDiffEditor(null);
        }
    }, [file.staged]);

    // IntersectionObserver for lazy mount/unmount (critical #2)
    useEffect(() => {
        const el = containerRef.current;
        if (!el || isCollapsed) {
            setShouldMount(false);
            return;
        }

        let unmountTimer: ReturnType<typeof setTimeout> | null = null;

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    if (unmountTimer) {
                        clearTimeout(unmountTimer);
                        unmountTimer = null;
                    }
                    setShouldMount(true);
                    onVisible(index);
                } else {
                    // Delay unmount by 300ms to avoid flicker on fast scrolling
                    unmountTimer = setTimeout(() => {
                        setShouldMount(false);
                    }, 300);
                }
            },
            { rootMargin: "200px 0px 200px 0px" }
        );
        observer.observe(el);
        return () => {
            observer.disconnect();
            if (unmountTimer) clearTimeout(unmountTimer);
        };
    }, [isCollapsed, index, onVisible]);

    // Register ref for scroll-to
    useEffect(() => {
        onRegisterRef(file.path, containerRef.current);
        return () => onRegisterRef(file.path, null);
    }, [file.path, onRegisterRef]);

    // Fetch diff when shouldMount is true and no cached diff
    useEffect(() => {
        if (!shouldMount || diff) return;
        let cancelled = false;
        setDiffError(false);
        model.fetchDiffCached(file.path, file.staged, file.untracked ?? false).then((d) => {
            if (!cancelled) {
                if (d) {
                    setDiff(d);
                } else {
                    setDiffError(true);
                }
            }
        });
        return () => { cancelled = true; };
    }, [shouldMount, diff, file.path, file.staged, file.untracked, model]);

    const handleMount = useCallback((editor: monaco.editor.IStandaloneDiffEditor) => {
        setDiffEditor(editor);
        onEditorRef(file.path, editor);
    }, [file.path, onEditorRef]);

    // Resize Monaco editor on mount
    useEffect(() => {
        if (diffEditor) {
            requestAnimationFrame(() => {
                diffEditor.layout();
            });
        }
    }, [diffEditor]);

    // Unregister editor ref on unmount
    useEffect(() => {
        return () => {
            onEditorRef(file.path, null);
        };
    }, [file.path, onEditorRef]);

    const diffViewerOptions = useMemo(() => ({
        renderSideBySide: viewMode === "side-by-side",
        readOnly: true,
        scrollBeyondLastLine: false,
        fontSize: 12,
        fontFamily: "Hack",
        minimap: { enabled: false },
        wordWrap: "off" as const,
    }), [viewMode]);

    const stageLabel = file.untracked ? "Stage" : (isStaged ? "Unstage" : "Stage");
    const isDone = isStaged || (file.additions === 0 && file.deletions === 0);

    return (
        <div
            ref={containerRef}
            className="border-b border-border"
            data-file-path={file.path}
        >
            {/* Collapsible header */}
            <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-hoverbg group"
                onClick={onToggleCollapse}
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        onToggleCollapse();
                    }
                    if (e.key === "s" || e.key === "S") {
                        e.preventDefault();
                        onStage();
                    }
                    if (e.key === "r" || e.key === "R") {
                        e.preventDefault();
                        onRevert();
                    }
                }}
            >
                <i className={`fa-solid fa-chevron-${isCollapsed ? "right" : "down"} text-[10px] text-muted`} />
                <span
                    className="inline-flex items-center justify-center w-3.5 h-3.5 text-[9px] font-bold rounded"
                    style={{ color: file.color, backgroundColor: `${file.color}20` }}
                >
                    {file.status}
                </span>
                <span className="text-xs text-secondary truncate flex-1">{file.path}</span>
                {(file.additions > 0 || file.deletions > 0) && (
                    <span className="text-[10px] text-muted flex-shrink-0">
                        {file.additions > 0 && <span className="text-green-400">+{file.additions}</span>}
                        {file.deletions > 0 && <span className="text-red-400">-{file.deletions}</span>}
                    </span>
                )}
                <button
                    className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-[10px] rounded bg-surface hover:bg-hoverbg text-secondary hover:text-white transition-opacity"
                    title={stageLabel}
                    onClick={(e) => { e.stopPropagation(); onStage(); }}
                >
                    <i className={`fa-solid ${isStaged ? "fa-minus" : "fa-plus"} mr-1`} />
                    {stageLabel}
                </button>
                {!file.untracked && (
                    <button
                        className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-[10px] rounded bg-surface hover:bg-hoverbg text-secondary hover:text-white transition-opacity"
                        title="Revert"
                        onClick={(e) => { e.stopPropagation(); onRevert(); }}
                    >
                        <i className="fa-solid fa-undo mr-1" />
                        Revert
                    </button>
                )}
            </div>

            {/* Diff content (lazy) */}
            {!isCollapsed && shouldMount && (
                <div ref={contentRef} className="overflow-hidden relative">
                    {diff ? (
                        <div
                            className="relative"
                            style={{
                                height: editorHeight ? `${editorHeight}px` : "200px",
                                minHeight: "80px",
                                opacity: isDone ? 0.6 : 1,
                                transition: "opacity 0.3s",
                            }}
                        >
                            <MonacoDiffViewer
                                original={diff.original}
                                modified={diff.modified}
                                language={diff.language}
                                path={file.path}
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
                                    onStageHunk={(hunkIndex) => model.stageHunk(file.path, hunkIndex)}
                                    onRevertHunk={(hunkIndex) => model.revertHunk(file.path, hunkIndex, isStaged)}
                                />
                            )}
                        </div>
                    ) : diffError ? (
                        <div className="flex items-center justify-center py-4 text-xs text-muted">
                            <i className="fa-solid fa-triangle-exclamation mr-2" />
                            Unable to load diff
                        </div>
                    ) : (
                        <div className="flex items-center justify-center py-4 text-xs text-muted">
                            <i className="fa-solid fa-spinner fa-spin mr-2" />
                            Loading diff...
                        </div>
                    )}
                </div>
            )}

            {/* Placeholder when unmounted — preserves scroll height */}
            {!isCollapsed && !shouldMount && contentHeight > 0 && (
                <div style={{ height: contentHeight }} />
            )}

            {isCollapsed && (
                <div className="px-3 py-1 text-[10px] text-muted truncate">
                    ── {file.path} ({file.status}, +{file.additions}/-{file.deletions}) ──
                </div>
            )}
        </div>
    );
});
FileDiffSection.displayName = "FileDiffSection";
