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

type JumpListProps = {
    files: ReviewFile[];
    activeIndex: number;
    collapsedMap: Map<string, boolean>;
    onJump: (index: number) => void;
};

export const JumpList = memo(({ files, activeIndex, collapsedMap, onJump }: JumpListProps) => {
    return (
        <div className="h-full flex flex-col overflow-hidden border-r border-border bg-surface">
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted border-b border-border">
                Files
            </div>
            <div className="flex-1 overflow-y-auto">
                {files.map((file, index) => (
                    <JumpListItem
                        key={file.path}
                        file={file}
                        isActive={index === activeIndex}
                        isCollapsed={collapsedMap.get(file.path) ?? false}
                        onClick={() => onJump(index)}
                    />
                ))}
            </div>
        </div>
    );
});
JumpList.displayName = "JumpList";
