// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo, useCallback, useMemo } from "react";
import { Tooltip } from "@/app/element/tooltip";
import type { ReviewFile } from "./types";

type JumpListItemProps = {
    file: ReviewFile;
    isActive: boolean;
    isCollapsed: boolean;
    onClick: () => void;
};

const JumpListItem = memo(({ file, isActive, isCollapsed, onClick }: JumpListItemProps) => {
    const displayName = useMemo(() => {
        const parts = file.path.split("/");
        return parts[parts.length - 1] || file.path;
    }, [file.path]);

    return (
        <div
            className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer text-[11px] group ${
                isActive
                    ? "bg-activebg text-white"
                    : "hover:bg-hoverbg text-secondary"
            }`}
            onClick={onClick}
        >
            <span
                className="inline-flex items-center justify-center w-3.5 h-3.5 text-[9px] font-bold rounded flex-shrink-0"
                style={{ color: file.color, backgroundColor: `${file.color}20` }}
            >
                {file.status}
            </span>
            <Tooltip content={file.path} placement="right">
                <span className="truncate flex-1">{displayName}</span>
            </Tooltip>
            {(file.additions > 0 || file.deletions > 0) && (
                <span className="text-[9px] text-muted flex-shrink-0">
                    {file.additions > 0 && <span className="text-green-400">+{file.additions}</span>}
                    {file.deletions > 0 && <span className="text-red-400">-{file.deletions}</span>}
                </span>
            )}
            {isCollapsed && (
                <i className="fa-solid fa-chevron-right text-[8px] text-muted flex-shrink-0" />
            )}
        </div>
    );
});
JumpListItem.displayName = "JumpListItem";

const SectionHeader = memo(({ label, count }: { label: string; count: number }) => (
    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted border-t border-border">
        {label} ({count})
    </div>
));
SectionHeader.displayName = "SectionHeader";

type JumpListProps = {
    files: ReviewFile[];
    activeIndex: number;
    collapsedMap: Map<string, boolean>;
    onJump: (index: number) => void;
};

export const JumpList = memo(({ files, activeIndex, collapsedMap, onJump }: JumpListProps) => {
    const categories = useMemo(() => {
        const staged: { file: ReviewFile; originalIndex: number }[] = [];
        const changed: { file: ReviewFile; originalIndex: number }[] = [];
        const untracked: { file: ReviewFile; originalIndex: number }[] = [];
        files.forEach((file, index) => {
            if (file.staged) {
                staged.push({ file, originalIndex: index });
            } else if (file.untracked) {
                untracked.push({ file, originalIndex: index });
            } else {
                changed.push({ file, originalIndex: index });
            }
        });
        return { staged, changed, untracked };
    }, [files]);

    return (
        <div className="h-full flex flex-col overflow-hidden border-r border-border bg-surface">
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted border-b border-border">
                Files
            </div>
            <div className="flex-1 overflow-y-auto">
                {categories.staged.length > 0 && (
                    <>
                        <SectionHeader label="Staged" count={categories.staged.length} />
                        {categories.staged.map(({ file, originalIndex }) => (
                            <JumpListItem
                                key={file.path}
                                file={file}
                                isActive={originalIndex === activeIndex}
                                isCollapsed={collapsedMap.get(file.path) ?? false}
                                onClick={() => onJump(originalIndex)}
                            />
                        ))}
                    </>
                )}
                {categories.changed.length > 0 && (
                    <>
                        <SectionHeader label="Changed" count={categories.changed.length} />
                        {categories.changed.map(({ file, originalIndex }) => (
                            <JumpListItem
                                key={file.path}
                                file={file}
                                isActive={originalIndex === activeIndex}
                                isCollapsed={collapsedMap.get(file.path) ?? false}
                                onClick={() => onJump(originalIndex)}
                            />
                        ))}
                    </>
                )}
                {categories.untracked.length > 0 && (
                    <>
                        <SectionHeader label="Untracked" count={categories.untracked.length} />
                        {categories.untracked.map(({ file, originalIndex }) => (
                            <JumpListItem
                                key={file.path}
                                file={file}
                                isActive={originalIndex === activeIndex}
                                isCollapsed={collapsedMap.get(file.path) ?? false}
                                onClick={() => onJump(originalIndex)}
                            />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
});
JumpList.displayName = "JumpList";
