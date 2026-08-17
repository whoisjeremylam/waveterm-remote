// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applyClearSelection, applySelectAll, applySelectionClick, buildDragFileItems, buildDropFileCopyOpts, decideNativeDropRoute, resolveDeleteItems, shouldConfirmDelete } from "./preview-directory-utils";

describe("buildDropFileCopyOpts", () => {
    const yearTimeout = 31536000000; // one year

    it("file + copy -> no recursive flag, year timeout", () => {
        const opts = buildDropFileCopyOpts(false, false);
        expect(opts.recursive).toBeUndefined();
        expect(opts.timeout).toBe(yearTimeout);
    });

    it("directory + copy -> no recursive flag (copy is always recursive backend-side)", () => {
        const opts = buildDropFileCopyOpts(true, false);
        expect(opts.recursive).toBeUndefined();
        expect(opts.timeout).toBe(yearTimeout);
    });

    it("directory + move -> recursive === true", () => {
        const opts = buildDropFileCopyOpts(true, true);
        expect(opts.recursive).toBe(true);
        expect(opts.timeout).toBe(yearTimeout);
    });

    it("file + move -> no recursive flag", () => {
        const opts = buildDropFileCopyOpts(false, true);
        expect(opts.recursive).toBeUndefined();
        expect(opts.timeout).toBe(yearTimeout);
    });
});

describe("decideNativeDropRoute", () => {
    const multiSourceSameParent: DragSourceState = {
        move: false,
        files: [
            { uri: "wsh://conn//home/user/a.txt", absParent: "/home/user", relName: "a.txt", isDir: false },
            { uri: "wsh://conn//home/user/b.txt", absParent: "/home/user", relName: "b.txt", isDir: false },
        ],
    };
    const multiSourceOtherParent: DragSourceState = {
        move: false,
        files: [
            { uri: "wsh://conn//home/user/a.txt", absParent: "/home/user", relName: "a.txt", isDir: false },
            { uri: "wsh://conn//home/other/b.txt", absParent: "/home/other", relName: "b.txt", isDir: false },
        ],
    };

    it("routes our own drag to a different directory as inapp (copy)", () => {
        expect(decideNativeDropRoute(multiSourceOtherParent, "/home/dest")).toBe("inapp");
    });

    it("routes an OS-file drag (no drag source) as upload", () => {
        expect(decideNativeDropRoute(null, "/home/user")).toBe("upload");
    });

    it("rejects a multi-file drag when every file's parent matches the drop dir", () => {
        expect(decideNativeDropRoute(multiSourceSameParent, "/home/user")).toBe("reject");
    });

    it("rejects a multi-file drag with a mixed parent (inapp) when any parent differs", () => {
        expect(decideNativeDropRoute(multiSourceOtherParent, "/home/user")).toBe("inapp");
    });

    it("treats an empty file list as inapp (not reject)", () => {
        expect(decideNativeDropRoute({ files: [], move: false }, "/home/user")).toBe("inapp");
    });

    it("rejects when dirPath is null or undefined", () => {
        expect(decideNativeDropRoute(multiSourceSameParent, null)).toBe("reject");
        expect(decideNativeDropRoute(multiSourceSameParent, undefined)).toBe("reject");
    });
});

describe("buildDragFileItems", () => {
    const entries = [
        { path: "/dir/..", name: "..", isdir: true },
        { path: "/dir/a.txt", name: "a.txt", isdir: false },
        { path: "/dir/b.txt", name: "b.txt", isdir: false },
        { path: "/dir/sub", name: "sub", isdir: true },
        { path: "/dir/c.txt", name: "c.txt", isdir: false },
    ];

    it("dragging a selected path picks all selected file entries (excludes .. and directories)", () => {
        const selectedPaths = new Set(["/dir/a.txt", "/dir/b.txt", "/dir/sub"]);
        const files = buildDragFileItems(selectedPaths, "/dir/a.txt", entries, "/dir", "conn");
        expect(files).toEqual([
            { relName: "a.txt", absParent: "/dir", uri: "wsh://conn//dir/a.txt", isDir: false },
            { relName: "b.txt", absParent: "/dir", uri: "wsh://conn//dir/b.txt", isDir: false },
        ]);
    });

    it("dragging an unselected path picks just that single file", () => {
        const selectedPaths = new Set(["/dir/a.txt"]);
        const files = buildDragFileItems(selectedPaths, "/dir/c.txt", entries, "/dir", "conn");
        expect(files).toEqual([
            { relName: "c.txt", absParent: "/dir", uri: "wsh://conn//dir/c.txt", isDir: false },
        ]);
    });

    it("a selection that is all directories yields []", () => {
        const selectedPaths = new Set(["/dir/sub", "/dir/.."]);
        const files = buildDragFileItems(selectedPaths, "/dir/sub", entries, "/dir", "conn");
        expect(files).toEqual([]);
    });
});

const selectablePaths = ["/a", "/b", "/c", "/d"];

describe("applySelectionClick", () => {
    it("plain click replaces the selection with a single path and sets the anchor", () => {
        const prev = { selectedPaths: new Set(["/b"]), anchor: "/b" };
        const next = applySelectionClick(prev, "/c", { cmd: false, shift: false }, selectablePaths);
        expect([...next.selectedPaths]).toEqual(["/c"]);
        expect(next.anchor).toBe("/c");
    });

    it("cmd-click toggles a path on and sets the anchor to that path", () => {
        const prev = { selectedPaths: new Set(["/a"]), anchor: "/a" };
        const next = applySelectionClick(prev, "/b", { cmd: true, shift: false }, selectablePaths);
        expect([...next.selectedPaths].sort()).toEqual(["/a", "/b"]);
        expect(next.anchor).toBe("/b");
    });

    it("cmd-click toggles a path off and sets the anchor to that path", () => {
        const prev = { selectedPaths: new Set(["/a", "/b"]), anchor: "/a" };
        const next = applySelectionClick(prev, "/b", { cmd: true, shift: false }, selectablePaths);
        expect([...next.selectedPaths]).toEqual(["/a"]);
        expect(next.anchor).toBe("/b");
    });

    it("shift-click selects a contiguous forward range and keeps the anchor", () => {
        const prev = { selectedPaths: new Set(["/a"]), anchor: "/a" };
        const next = applySelectionClick(prev, "/c", { cmd: false, shift: true }, selectablePaths);
        expect([...next.selectedPaths].sort()).toEqual(["/a", "/b", "/c"]);
        expect(next.anchor).toBe("/a");
    });

    it("shift-click selects a contiguous reverse range and keeps the anchor", () => {
        const prev = { selectedPaths: new Set(["/c"]), anchor: "/c" };
        const next = applySelectionClick(prev, "/a", { cmd: false, shift: true }, selectablePaths);
        expect([...next.selectedPaths].sort()).toEqual(["/a", "/b", "/c"]);
        expect(next.anchor).toBe("/c");
    });

    it("shift-click with a null anchor falls back to plain selection", () => {
        const prev = { selectedPaths: new Set(), anchor: null };
        const next = applySelectionClick(prev, "/b", { cmd: false, shift: true }, selectablePaths);
        expect([...next.selectedPaths]).toEqual(["/b"]);
        expect(next.anchor).toBe("/b");
    });

    it("shift-click with an anchor not in selectablePaths falls back to plain selection", () => {
        const prev = { selectedPaths: new Set(), anchor: "/missing" };
        const next = applySelectionClick(prev, "/b", { cmd: false, shift: true }, selectablePaths);
        expect([...next.selectedPaths]).toEqual(["/b"]);
        expect(next.anchor).toBe("/b");
    });
});

describe("applySelectAll", () => {
    it("selects every selectable path and anchors at the first", () => {
        const next = applySelectAll(selectablePaths);
        expect([...next.selectedPaths].sort()).toEqual(["/a", "/b", "/c", "/d"]);
        expect(next.anchor).toBe("/a");
    });

    it("handles an empty selectable list with a null anchor", () => {
        const next = applySelectAll([]);
        expect(next.selectedPaths.size).toBe(0);
        expect(next.anchor).toBeNull();
    });
});

describe("applyClearSelection", () => {
    it("empties the selection and clears the anchor", () => {
        const next = applyClearSelection();
        expect(next.selectedPaths.size).toBe(0);
        expect(next.anchor).toBeNull();
    });
});

const deleteEntries = [
    { path: "/dir/..", name: "..", isdir: true },
    { path: "/dir/a.txt", name: "a.txt", isdir: false },
    { path: "/dir/b.txt", name: "b.txt", isdir: false },
    { path: "/dir/sub", name: "sub", isdir: true },
];

describe("resolveDeleteItems", () => {
    it("right-clicking an unselected path deletes just that item", () => {
        const selectedPaths = new Set(["/dir/a.txt"]);
        const items = resolveDeleteItems(selectedPaths, "/dir/b.txt", deleteEntries);
        expect(items).toEqual([{ path: "/dir/b.txt", isdir: false }]);
    });

    it("right-clicking an already-selected path deletes the whole selection", () => {
        const selectedPaths = new Set(["/dir/a.txt", "/dir/b.txt"]);
        const items = resolveDeleteItems(selectedPaths, "/dir/a.txt", deleteEntries);
        expect(items).toEqual([
            { path: "/dir/a.txt", isdir: false },
            { path: "/dir/b.txt", isdir: false },
        ]);
    });

    it("clickedPath null deletes the whole selection", () => {
        const selectedPaths = new Set(["/dir/a.txt", "/dir/sub"]);
        const items = resolveDeleteItems(selectedPaths, null, deleteEntries);
        expect(items).toEqual([
            { path: "/dir/a.txt", isdir: false },
            { path: "/dir/sub", isdir: true },
        ]);
    });

    it("never includes the .. entry", () => {
        const selectedPaths = new Set(["/dir/..", "/dir/a.txt"]);
        const items = resolveDeleteItems(selectedPaths, null, deleteEntries);
        expect(items).toEqual([{ path: "/dir/a.txt", isdir: false }]);
    });
});

describe("shouldConfirmDelete", () => {
    it("a single file does not require confirmation", () => {
        expect(shouldConfirmDelete([{ path: "/dir/a.txt", isdir: false }])).toBe(false);
    });

    it("a single directory requires confirmation", () => {
        expect(shouldConfirmDelete([{ path: "/dir/sub", isdir: true }])).toBe(true);
    });

    it("two files require confirmation", () => {
        expect(
            shouldConfirmDelete([
                { path: "/dir/a.txt", isdir: false },
                { path: "/dir/b.txt", isdir: false },
            ])
        ).toBe(true);
    });

    it("two directories require confirmation", () => {
        expect(
            shouldConfirmDelete([
                { path: "/dir/sub", isdir: true },
                { path: "/dir/sub2", isdir: true },
            ])
        ).toBe(true);
    });
});
