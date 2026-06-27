// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { formatRemoteUri } from "@/util/waveutil";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./directorydropdown.scss";

type DirectoryDropdownProps = {
    currentPath: string;
    connection: string;
    onSelect: (path: string) => void;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement>;
    dirsOnly?: boolean;
};

type DirEntry = {
    name: string;
    path: string;
    isdir: boolean;
};

export const DirectoryDropdown = memo(function DirectoryDropdown({
    currentPath,
    connection,
    onSelect,
    onClose,
    anchorRef,
    dirsOnly = false,
}: DirectoryDropdownProps) {
    const [entries, setEntries] = useState<DirEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [dirError, setDirError] = useState<string | null>(null);
    const [posStyle, setPosStyle] = useState<React.CSSProperties>({});
    const dropdownRef = useRef<HTMLDivElement>(null);
    const currentPathRef = useRef(currentPath);

    useEffect(() => {
        currentPathRef.current = currentPath;
    }, [currentPath]);

    const updatePosition = useCallback(() => {
        const anchor = anchorRef?.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        setPosStyle({
            position: "fixed",
            top: rect.bottom,
            left: rect.left,
        });
    }, [anchorRef]);

    useEffect(() => {
        updatePosition();
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        return () => {
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition);
        };
    }, [updatePosition]);

    const loadDirectories = useCallback(
        async (dirPath: string) => {
            setLoading(true);
            setDirError(null);
            const dirs: DirEntry[] = [];

            if (dirPath !== "/") {
                const parentPath = dirPath.split("/").slice(0, -1).join("/") || "/";
                dirs.push({ name: "..", path: parentPath, isdir: true });
            }

            try {
                const remotePath = formatRemoteUri(dirPath, connection || "local");
                const result = await RpcApi.FileListCommand(
                    TabRpcClient,
                    { path: remotePath },
                    undefined
                );

                if (result) {
                    for (const item of result) {
                        if (item.name !== "." && item.name !== "..") {
                            if (dirsOnly && !item.isdir) continue;
                            dirs.push({
                                name: item.name,
                                path: item.path,
                                isdir: item.isdir,
                            });
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to load directories:", e);
                setDirError("Error loading directories");
            } finally {
                setLoading(false);
            }

            dirs.sort((a, b) => {
                if (a.name === "..") return -1;
                if (b.name === "..") return 1;
                if (a.isdir !== b.isdir) return a.isdir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            setEntries(dirs);
        },
        [connection, dirsOnly]
    );

    useEffect(() => {
        loadDirectories(currentPath);
    }, [currentPath, loadDirectories]);

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            const anchor = anchorRef?.current;
            if (anchor && anchor.contains(e.target as Node)) return;
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                onClose();
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [onClose, anchorRef]);

    const handleItemClick = useCallback(
        (entry: DirEntry) => {
            onSelect(entry.path);
        },
        [onSelect]
    );

    return createPortal(
        <div ref={dropdownRef} className="directory-dropdown" style={posStyle}>
            {loading ? (
                <div className="directory-dropdown-item">
                    <span className="directory-item-name">Loading...</span>
                </div>
            ) : dirError ? (
                <div className="directory-dropdown-item">
                    <span className="directory-item-name">Error loading directories</span>
                </div>
            ) : entries.length === 0 ? (
                <div className="directory-dropdown-item">
                    <span className="directory-item-name">No directories</span>
                </div>
            ) : (
                entries.map((entry) => (
                    <div
                        key={entry.path}
                        className="directory-dropdown-item"
                        onClick={() => handleItemClick(entry)}
                    >
                        <span className="directory-item-name">
                            <i className={`fa-solid ${entry.name === ".." ? "fa-arrow-up" : entry.isdir ? "fa-folder" : "fa-file"}`} />
                            {entry.name === ".." ? " Parent directory" : ` ${entry.name}`}
                        </span>
                    </div>
                ))
            )}
        </div>,
        document.body
    );
});

DirectoryDropdown.displayName = "DirectoryDropdown";
