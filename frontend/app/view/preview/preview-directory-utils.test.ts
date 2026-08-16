// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { decideNativeDropRoute } from "./preview-directory-utils";

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
