// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

interface BlockOverlayProps {
    children: React.ReactNode;
    className?: string;
}

export const BlockOverlay = React.memo(({ children, className }: BlockOverlayProps) => {
    return (
        <div
            className={`@container absolute top-[calc(var(--header-height)+6px)] left-1.5 right-1.5 z-[var(--zindex-block-mask-inner)] overflow-hidden rounded-md bg-[var(--conn-status-overlay-bg-color)] backdrop-blur-[50px] shadow-lg opacity-90 ${className ?? ""}`}
        >
            <div className="flex items-center gap-3 w-full pt-2.5 pb-2.5 pr-2 pl-3">{children}</div>
        </div>
    );
});
BlockOverlay.displayName = "BlockOverlay";
