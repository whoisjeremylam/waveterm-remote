// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applyClearSelection, applySelectAll, applySelectionClick, decideNativeDropRoute } from "./preview-directory-utils";

describe("decideNativeDropRoute", () => {
    it("routes our own drag to a different directory as inapp (copy)", () => {
        const dragSource: DraggedFile = {
            uri: "wave://conn//home/user/file.txt",
            absParent: "/home/user",
            relName: "file.txt",
            isDir: false,
        };
        expect(decideNativeDropRoute(dragSource, "/home/other")).toBe("inapp");
    });

    it("routes an OS-file drag (no drag source) as upload", () => {
        expect(decideNativeDropRoute(null, "/home/user")).toBe("upload");
    });

    it("rejects our own drag dropped back into its own parent directory", () => {
        const dragSource: DraggedFile = {
            uri: "wave://conn//home/user/file.txt",
            absParent: "/home/user",
            relName: "file.txt",
            isDir: false,
        };
        expect(decideNativeDropRoute(dragSource, "/home/user")).toBe("reject");
    });

    it("rejects when dirPath is null or undefined", () => {
        const dragSource: DraggedFile = {
            uri: "wave://conn//home/user/file.txt",
            absParent: "/home/user",
            relName: "file.txt",
            isDir: false,
        };
        expect(decideNativeDropRoute(dragSource, null)).toBe("reject");
        expect(decideNativeDropRoute(dragSource, undefined)).toBe("reject");
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
