// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget, isBlank } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import dayjs from "dayjs";
import React from "react";
import { type PreviewModel } from "./preview-model";

export type NativeDropRoute = "inapp" | "upload" | "reject";

// Decides how a native drop should be handled:
//  - our own widget drag (dragSource set) to a different directory -> "inapp" (copy)
//  - our own widget drag dropped back into its own parent directory -> "reject" (no-op)
//  - no drag source (e.g. OS/Finder/Explorer files) -> "upload"
export function decideNativeDropRoute(
    dragSource: DragSourceState | null,
    dirPath: string | null | undefined
): NativeDropRoute {
    if (dirPath == null) {
        return "reject";
    }
    if (dragSource != null) {
        if (dragSource.files.length > 0 && dragSource.files.every((f) => f.absParent === dirPath)) {
            return "reject";
        }
        return "inapp";
    }
    return "upload";
}

// Builds the OS drag-out file list from the current selection. If the dragged
// path is part of the selection, every selected file is dragged; otherwise only
// the dragged row. Directories and the ".." row are always excluded (native
// drag-out is files-only).
export function buildDragFileItems(
    selectedPaths: Set<string>,
    draggedPath: string,
    entries: Array<{ path: string; name: string; isdir: boolean }>,
    dirPath: string,
    connName: string
): DraggedFile[] {
    const paths = selectedPaths.has(draggedPath) ? selectedPaths : new Set<string>([draggedPath]);
    return entries
        .filter((entry) => entry.name !== ".." && !entry.isdir && paths.has(entry.path))
        .map((entry) => ({
            relName: entry.name,
            absParent: dirPath,
            uri: formatRemoteUri(entry.path, connName),
            isDir: false,
        }));
}

export type SelectionState = { selectedPaths: Set<string>; anchor: string | null };

// plain click -> {path}; cmd-click -> toggle path (anchor=path);
// shift-click -> range over selectablePaths from anchor to path (anchor unchanged);
// if anchor is null or not found in selectablePaths, fall back to plain {path}.
// If cmd is set, treat as toggle (ignore shift).
export function applySelectionClick(
    prev: SelectionState,
    path: string,
    opts: { cmd: boolean; shift: boolean },
    selectablePaths: string[]
): SelectionState {
    if (opts.cmd) {
        const nextPaths = new Set(prev.selectedPaths);
        if (nextPaths.has(path)) {
            nextPaths.delete(path);
        } else {
            nextPaths.add(path);
        }
        return { selectedPaths: nextPaths, anchor: path };
    }
    if (opts.shift) {
        const anchorIdx = prev.anchor != null ? selectablePaths.indexOf(prev.anchor) : -1;
        const pathIdx = selectablePaths.indexOf(path);
        if (anchorIdx !== -1 && pathIdx !== -1) {
            const [start, end] = anchorIdx <= pathIdx ? [anchorIdx, pathIdx] : [pathIdx, anchorIdx];
            const nextPaths = new Set<string>();
            for (let i = start; i <= end; i++) {
                nextPaths.add(selectablePaths[i]);
            }
            return { selectedPaths: nextPaths, anchor: prev.anchor };
        }
        return { selectedPaths: new Set([path]), anchor: path };
    }
    return { selectedPaths: new Set([path]), anchor: path };
}

// select all selectablePaths, anchor = first
export function applySelectAll(selectablePaths: string[]): SelectionState {
    return {
        selectedPaths: new Set(selectablePaths),
        anchor: selectablePaths.length > 0 ? selectablePaths[0] : null,
    };
}

// empty set, null anchor
export function applyClearSelection(): SelectionState {
    return { selectedPaths: new Set(), anchor: null };
}

export const recursiveError = "recursive flag must be set for directory operations";
export const overwriteError = "set overwrite flag to delete the existing file";
export const mergeError = "set overwrite flag to delete the existing contents or set merge flag to merge the contents";

export const displaySuffixes = {
    B: "b",
    kB: "k",
    MB: "m",
    GB: "g",
    TB: "t",
    KiB: "k",
    MiB: "m",
    GiB: "g",
    TiB: "t",
};

export function getBestUnit(bytes: number, si = false, sigfig = 3): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "-";
    if (bytes === 0) return "0B";

    const units = si ? ["kB", "MB", "GB", "TB"] : ["KiB", "MiB", "GiB", "TiB"];
    const divisor = si ? 1000 : 1024;

    const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(divisor)), units.length);
    const unit = idx === 0 ? "B" : units[idx - 1];
    const value = bytes / Math.pow(divisor, idx);

    return `${parseFloat(value.toPrecision(sigfig))}${displaySuffixes[unit] ?? unit}`;
}

function padDay(day: number) {
    return String(day).padStart(2, " ");
}

export function getLastModifiedTime(unixMillis: number): string {
    const file = dayjs(unixMillis);
    const now = dayjs();

    const day = padDay(file.date());
    const time = file.format("HH:mm");

    if (now.isSame(file, "year")) {
        return `${file.format("MMM")} ${day} ${time}`;
    }

    return `${file.format("YYYY-MM-DD")}`;
}

const iconRegex = /^[a-z0-9- ]+$/;

export function isIconValid(icon: string): boolean {
    if (isBlank(icon)) {
        return false;
    }
    return icon.match(iconRegex) != null;
}

export function getSortIcon(sortType: string | boolean): React.ReactNode {
    switch (sortType) {
        case "asc":
            return <i className="fa-solid fa-chevron-up dir-table-head-direction"></i>;
        case "desc":
            return <i className="fa-solid fa-chevron-down dir-table-head-direction"></i>;
        default:
            return null;
    }
}

export function cleanMimetype(input: string): string {
    const truncated = input.split(";")[0];
    return truncated.trim();
}

export function handleRename(
    model: PreviewModel,
    path: string,
    newPath: string,
    isDir: boolean,
    setErrorMsg: (msg: ErrorMsg) => void
) {
    fireAndForget(async () => {
        try {
            let srcuri = await model.formatRemoteUri(path, globalStore.get);
            if (isDir) {
                srcuri += "/";
            }
            await model.env.rpc.FileMoveCommand(TabRpcClient, {
                srcuri,
                desturi: await model.formatRemoteUri(newPath, globalStore.get),
            });
        } catch (e) {
            const errorText = `${e}`;
            console.warn(`Rename failed: ${errorText}`);
            const errorMsg: ErrorMsg = {
                status: "Rename Failed",
                text: `${e}`,
            };
            setErrorMsg(errorMsg);
        }
        model.refresh();
    });
}

export function handleFileDelete(
    model: PreviewModel,
    path: string,
    recursive: boolean,
    setErrorMsg: (msg: ErrorMsg) => void
) {
    fireAndForget(async () => {
        const formattedPath = await model.formatRemoteUri(path, globalStore.get);
        try {
            await model.env.rpc.FileDeleteCommand(TabRpcClient, {
                path: formattedPath,
                recursive,
            });
        } catch (e) {
            const errorText = `${e}`;
            console.warn(`Delete failed: ${errorText}`);
            let errorMsg: ErrorMsg;
            if (errorText.includes(recursiveError) && !recursive) {
                errorMsg = {
                    status: "Confirm Delete Directory",
                    text: "Deleting a directory requires the recursive flag. Proceed?",
                    level: "warning",
                    buttons: [
                        {
                            text: "Delete Recursively",
                            onClick: () => handleFileDelete(model, path, true, setErrorMsg),
                        },
                    ],
                };
            } else {
                errorMsg = {
                    status: "Delete Failed",
                    text: `${e}`,
                };
            }
            setErrorMsg(errorMsg);
        }
        model.refresh();
    });
}

export function makeDirectoryDefaultMenuItems(model: PreviewModel): ContextMenuItem[] {
    const defaultSort = globalStore.get(model.env.getSettingsKeyAtom("preview:defaultsort")) ?? "name";
    const showHiddenFiles = globalStore.get(model.showHiddenFiles) ?? true;
    return [
        {
            label: "Directory Sort Order",
            submenu: [
                {
                    label: "Name",
                    type: "checkbox",
                    checked: defaultSort === "name",
                    click: () =>
                        fireAndForget(() =>
                            model.env.rpc.SetConfigCommand(TabRpcClient, { "preview:defaultsort": "name" })
                        ),
                },
                {
                    label: "Last Modified",
                    type: "checkbox",
                    checked: defaultSort === "modtime",
                    click: () =>
                        fireAndForget(() =>
                            model.env.rpc.SetConfigCommand(TabRpcClient, { "preview:defaultsort": "modtime" })
                        ),
                },
            ],
        },
        {
            label: "Show Hidden Files",
            submenu: [
                {
                    label: "On",
                    type: "checkbox",
                    checked: showHiddenFiles,
                    click: () => {
                        globalStore.set(model.showHiddenFiles, true);
                        fireAndForget(() =>
                            model.env.rpc.SetConfigCommand(TabRpcClient, { "preview:showhiddenfiles": true })
                        );
                    },
                },
                {
                    label: "Off",
                    type: "checkbox",
                    checked: !showHiddenFiles,
                    click: () => {
                        globalStore.set(model.showHiddenFiles, false);
                        fireAndForget(() =>
                            model.env.rpc.SetConfigCommand(TabRpcClient, { "preview:showhiddenfiles": false })
                        );
                    },
                },
            ],
        },
    ];
}
