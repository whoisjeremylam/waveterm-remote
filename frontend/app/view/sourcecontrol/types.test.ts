// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import type { ReviewFile, SelectedFile, FileTreeNode, DiffHunk } from "./types";

describe("types", () => {
    describe("ReviewFile", () => {
        it("can be created with required fields", () => {
            const file: ReviewFile = {
                path: "src/index.ts",
                status: "M",
                oldPath: "",
                icon: "fa-file-code",
                color: "#f0ad4e",
                staged: false,
                additions: 5,
                deletions: 2,
            };
            expect(file.path).toBe("src/index.ts");
            expect(file.staged).toBe(false);
            expect(file.additions).toBe(5);
            expect(file.deletions).toBe(2);
        });

        it("can have optional untracked field", () => {
            const file: ReviewFile = {
                path: "new-file.txt",
                status: "?",
                oldPath: "",
                icon: "fa-file",
                color: "#888",
                staged: false,
                untracked: true,
                additions: 10,
                deletions: 0,
            };
            expect(file.untracked).toBe(true);
        });
    });

    describe("SelectedFile", () => {
        it("can be created with required fields", () => {
            const file: SelectedFile = {
                path: "src/utils.ts",
                staged: true,
            };
            expect(file.path).toBe("src/utils.ts");
            expect(file.staged).toBe(true);
            expect(file.untracked).toBeUndefined();
        });

        it("can have optional untracked field", () => {
            const file: SelectedFile = {
                path: "new.txt",
                staged: false,
                untracked: true,
            };
            expect(file.untracked).toBe(true);
        });
    });

    describe("FileTreeNode", () => {
        it("can be created with required fields", () => {
            const node: FileTreeNode = {
                id: "src",
                name: "src",
                path: "src",
                status: {
                    path: "src",
                    status: "M",
                    oldPath: "",
                    icon: "fa-folder",
                    color: "#888",
                },
                isDirectory: true,
            };
            expect(node.isDirectory).toBe(true);
        });

        it("can have children", () => {
            const child: FileTreeNode = {
                id: "src/index.ts",
                name: "index.ts",
                path: "src/index.ts",
                status: {
                    path: "src/index.ts",
                    status: "M",
                    oldPath: "",
                    icon: "fa-file-code",
                    color: "#f0ad4e",
                },
                isDirectory: false,
            };
            const parent: FileTreeNode = {
                id: "src",
                name: "src",
                path: "src",
                status: {
                    path: "src",
                    status: "M",
                    oldPath: "",
                    icon: "fa-folder",
                    color: "#888",
                },
                isDirectory: true,
                children: [child],
            };
            expect(parent.children).toHaveLength(1);
        });
    });

    describe("DiffHunk", () => {
        it("can be created with all fields", () => {
            const hunk: DiffHunk = {
                header: "@@ -1,3 +1,4 @@",
                modifiedStart: 1,
                modifiedCount: 4,
                originalStart: 1,
                originalCount: 3,
            };
            expect(hunk.header).toContain("@@");
            expect(hunk.modifiedCount).toBe(4);
        });
    });
});
