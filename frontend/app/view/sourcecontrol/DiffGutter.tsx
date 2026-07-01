// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import type { DiffHunk } from "./types";

type DiffGutterProps = {
    diffEditor: monaco.editor.IStandaloneDiffEditor;
    hunks: DiffHunk[];
    isStaged: boolean;
    onStageHunk: (hunkIndex: number) => void;
    onRevertHunk: (hunkIndex: number) => void;
};

export function DiffGutter({ diffEditor, hunks, isStaged, onStageHunk, onRevertHunk }: DiffGutterProps) {
    const collectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
    const disposableRef = useRef<monaco.IDisposable | null>(null);

    useEffect(() => {
        // Clean up previous decorations
        if (collectionRef.current) {
            collectionRef.current.clear();
            collectionRef.current = null;
        }
        if (disposableRef.current) {
            disposableRef.current.dispose();
            disposableRef.current = null;
        }

        if (!hunks || hunks.length === 0) return;

        const modifiedEditor = diffEditor.getModifiedEditor();
        if (!modifiedEditor) return;

        // Create glyph margin decorations for each hunk
        const decorations: monaco.editor.IModelDeltaDecoration[] = hunks.map((hunk, idx) => ({
            range: new monaco.Range(hunk.modifiedStart, 1, hunk.modifiedStart, 1),
            options: {
                isWholeLine: true,
                glyphMarginClassName: isStaged ? "scm-revert-glyph" : "scm-stage-glyph",
                glyphMarginHoverMessage: {
                    value: isStaged ? `**Revert hunk ${idx + 1}**` : `**Stage hunk ${idx + 1}**`,
                },
            },
        }));

        const collection = modifiedEditor.createDecorationsCollection(decorations);
        collectionRef.current = collection;

        // Register click handler on glyph margin
        const clickDisposable = modifiedEditor.onMouseDown((e) => {
            if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                const line = e.target.position?.lineNumber;
                if (line === undefined) return;

                // Find which hunk contains this line
                const hunkIdx = hunks.findIndex(h => h.modifiedStart === line);
                if (hunkIdx >= 0) {
                    if (isStaged) {
                        onRevertHunk(hunkIdx);
                    } else {
                        onStageHunk(hunkIdx);
                    }
                }
            }
        });
        disposableRef.current = clickDisposable;

        return () => {
            if (collectionRef.current) {
                collectionRef.current.clear();
                collectionRef.current = null;
            }
            if (disposableRef.current) {
                disposableRef.current.dispose();
                disposableRef.current = null;
            }
        };
    }, [diffEditor, hunks, isStaged, onStageHunk, onRevertHunk]);

    // This component is purely side-effect-driven
    return null;
}
