// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applyClearSelection, applySelectAll, applySelectionClick, buildDragFileItems, decideNativeDropRoute } from "./preview-directory-utils";

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
