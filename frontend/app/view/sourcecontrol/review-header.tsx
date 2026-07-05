// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";

type ReviewHeaderProps = {
    fileCount: number;
    totalAdditions: number;
    totalDeletions: number;
    filterLabel?: string;
    onExit: () => void;
};

export const ReviewHeader = memo(({ fileCount, totalAdditions, totalDeletions, filterLabel, onExit }: ReviewHeaderProps) => (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface">
        <div className="flex items-center gap-2 text-xs">
            <i className="fa-solid fa-eye text-muted" />
            <span className="font-medium text-secondary">
                Review{filterLabel ? ` ${filterLabel}` : ""}: {fileCount} {fileCount === 1 ? "file" : "files"}
            </span>
            {totalAdditions > 0 && (
                <span className="text-green-400">+{totalAdditions}</span>
            )}
            {totalDeletions > 0 && (
                <span className="text-red-400">-{totalDeletions}</span>
            )}
        </div>
        <button
            className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded bg-surface hover:bg-hoverbg text-secondary hover:text-white transition-colors"
            onClick={onExit}
        >
            <i className="fa-solid fa-times text-[10px]" />
            Exit Review
        </button>
    </div>
));
ReviewHeader.displayName = "ReviewHeader";
