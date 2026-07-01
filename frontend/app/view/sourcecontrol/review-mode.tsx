// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { memo, useCallback, useEffect, useRef } from "react";
import * as jotai from "jotai";
import * as monaco from "monaco-editor";
import { ReviewHeader } from "./review-header";
import { JumpList } from "./jump-list";
import { FileDiffSection } from "./file-diff-section";
import type { SourceControlViewModel } from "./sourcecontrol-model";
import type { ReviewFile } from "./types";

type ReviewModeProps = {
    model: SourceControlViewModel;
    onExit: () => void;
};

export const ReviewMode = memo(({ model, onExit }: ReviewModeProps) => {
    const files = jotai.useAtomValue(model.reviewFilesAtom);
    const activeIndex = jotai.useAtomValue(model.reviewActiveIndexAtom);
    const collapsedMap = jotai.useAtomValue(model.reviewCollapsedAtom);
    const stats = jotai.useAtomValue(model.reviewStatsAtom);
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRefs = useRef<Map<string, monaco.editor.IStandaloneDiffEditor>>(new Map());

    const registerRef = useCallback((path: string, el: HTMLDivElement | null) => {
        const refs = globalStore.get(model.reviewFileRefsAtom);
        const next = new Map(refs);
        if (el) {
            next.set(path, el);
        } else {
            next.delete(path);
        }
        globalStore.set(model.reviewFileRefsAtom, next);
    }, [model]);

    const handleVisible = useCallback((index: number) => {
        globalStore.set(model.reviewActiveIndexAtom, index);
    }, [model]);

    const handleEditorRef = useCallback((path: string, editor: monaco.editor.IStandaloneDiffEditor | null) => {
        if (editor) {
            editorRefs.current.set(path, editor);
        } else {
            editorRefs.current.delete(path);
        }
    }, []);

    const handleToggleCollapse = useCallback((path: string) => {
        model.toggleFileCollapse(path);
    }, [model]);

    const handleStage = useCallback((file: ReviewFile) => {
        model.stageFileFromReview(file.path, file.staged, file.untracked ?? false);
    }, [model]);

    const handleRevert = useCallback((file: ReviewFile) => {
        model.revertFileFromReview(file.path, file.staged);
    }, [model]);

    const handleJump = useCallback((index: number) => {
        model.jumpToFile(index);
    }, [model]);

    // Keyboard navigation — on outer container so it works from jump list too (significant #4)
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            const reviewMode = globalStore.get(model.reviewModeAtom);
            if (!reviewMode) return;

            if (e.key === "Escape") {
                e.preventDefault();
                onExit();
                return;
            }

            if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                const currentIdx = globalStore.get(model.reviewActiveIndexAtom);
                const filesList = globalStore.get(model.reviewFilesAtom);
                if (filesList.length === 0) return;

                if (e.key === "ArrowDown") {
                    const nextIdx = Math.min(currentIdx + 1, filesList.length - 1);
                    model.jumpToFile(nextIdx);
                } else {
                    const prevIdx = Math.max(currentIdx - 1, 0);
                    model.jumpToFile(prevIdx);
                }
            }

            // F7 / Shift+F7 cross-file hunk navigation
            if (e.key === "F7") {
                e.preventDefault();
                const filesList = globalStore.get(model.reviewFilesAtom);
                const currentIdx = globalStore.get(model.reviewActiveIndexAtom);
                if (filesList.length === 0) return;

                const isNext = !e.shiftKey;
                const activeFile = filesList[currentIdx];
                const editor = editorRefs.current.get(activeFile?.path);

                if (!editor) {
                    // Editor not loaded — navigate between file sections
                    if (isNext && currentIdx < filesList.length - 1) {
                        model.jumpToFile(currentIdx + 1);
                    } else if (!isNext && currentIdx > 0) {
                        model.jumpToFile(currentIdx - 1);
                    }
                    return;
                }

                const lineChanges = editor.getLineChanges();
                const modifiedEditor = editor.getModifiedEditor();
                const position = modifiedEditor?.getPosition();

                if (isNext) {
                    const lastHunk = lineChanges?.[lineChanges.length - 1];
                    const atLastHunk = lastHunk && position && position.lineNumber >= lastHunk.modifiedEndLineNumber;

                    if (atLastHunk && currentIdx < filesList.length - 1) {
                        model.jumpToFile(currentIdx + 1);
                        const nextEditor = editorRefs.current.get(filesList[currentIdx + 1]?.path);
                        if (nextEditor) {
                            nextEditor.goToDiff('next');
                        }
                    } else {
                        editor.goToDiff('next');
                    }
                } else {
                    const firstHunk = lineChanges?.[0];
                    const atFirstHunk = firstHunk && position && position.lineNumber <= firstHunk.modifiedStartLineNumber;

                    if (atFirstHunk && currentIdx > 0) {
                        model.jumpToFile(currentIdx - 1);
                        const prevEditor = editorRefs.current.get(filesList[currentIdx - 1]?.path);
                        if (prevEditor) {
                            const prevModified = prevEditor.getModifiedEditor();
                            const prevModel = prevModified?.getModel();
                            if (prevModel) {
                                prevModified.setPosition({ lineNumber: prevModel.getLineCount(), column: 1 });
                            }
                            prevEditor.goToDiff('previous');
                        }
                    } else {
                        editor.goToDiff('previous');
                    }
                }
            }
        };

        container.addEventListener("keydown", handleKeyDown);
        return () => container.removeEventListener("keydown", handleKeyDown);
    }, [model, onExit]);

    return (
        <div ref={containerRef} className="flex flex-col h-full w-full overflow-hidden" tabIndex={0}>
            <ReviewHeader
                fileCount={files.length}
                totalAdditions={stats.additions}
                totalDeletions={stats.deletions}
                onExit={onExit}
            />
            <div className="flex flex-1 overflow-hidden">
                {/* Jump list sidebar */}
                <div style={{ width: "200px", minWidth: "150px", flexShrink: 0 }}>
                    <JumpList
                        files={files}
                        activeIndex={activeIndex}
                        collapsedMap={collapsedMap}
                        onJump={handleJump}
                    />
                </div>

                {/* Scrollable diff sections */}
                <div className="flex-1 overflow-y-auto">
                    {files.map((file, index) => (
                        <FileDiffSection
                            key={file.path}
                            model={model}
                            file={file}
                            index={index}
                            isCollapsed={collapsedMap.get(file.path) ?? false}
                            onToggleCollapse={() => handleToggleCollapse(file.path)}
                            onStage={() => handleStage(file)}
                            onRevert={() => handleRevert(file)}
                            onRegisterRef={registerRef}
                            onVisible={handleVisible}
                            onEditorRef={handleEditorRef}
                        />
                    ))}
                    {files.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-muted text-xs">
                            <i className="fa-solid fa-code-branch text-xl mb-2 opacity-50" />
                            <span>No files to review</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});
ReviewMode.displayName = "ReviewMode";
