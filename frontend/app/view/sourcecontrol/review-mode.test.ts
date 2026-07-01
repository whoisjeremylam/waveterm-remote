// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock atom store — used by both globalStore mock and jotai mock
// ---------------------------------------------------------------------------

interface MockAtom {
    _key: string;
    _type: "primitive" | "derived";
    _value?: any;
    _fn?: (get: any) => any;
}

const atomStore = new Map<string, MockAtom>();
let atomCounter = 0;

function createMockAtom(initOrFn?: any): MockAtom {
    const key = `atom_${atomCounter++}`;
    if (typeof initOrFn === "function") {
        const derived: MockAtom = { _key: key, _type: "derived", _fn: initOrFn };
        atomStore.set(key, derived);
        return derived;
    }
    const val = initOrFn ?? null;
    const primitive: MockAtom = { _key: key, _type: "primitive", _value: val };
    atomStore.set(key, primitive);
    return primitive;
}

function mockAtomGet(atom: MockAtom | any): any {
    if (atom && atom._type === "primitive") return atom._value;
    if (atom && atom._type === "derived" && atom._fn) return atom._fn(mockAtomGet);
    return undefined;
}

function mockAtomSet(atom: MockAtom | any, value: any): void {
    if (atom && atom._type === "primitive") {
        atom._value = value;
    }
}

// ---------------------------------------------------------------------------
// Mocks (vi.mock is hoisted, so these must be at top level)
// ---------------------------------------------------------------------------

vi.mock("@/app/store/jotaiStore", () => ({
    globalStore: {
        get: vi.fn((atom: any) => mockAtomGet(atom)),
        set: vi.fn((atom: any, value: any) => mockAtomSet(atom, value)),
        sub: vi.fn(() => vi.fn()),
    },
}));

vi.mock("@/store/global", () => ({
    getFocusedTerminalCwd: vi.fn(() => "/home/user/project"),
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {},
}));

vi.mock("@/util/util", () => ({
    makeConnRoute: vi.fn((conn: string) => `conn:${conn}`),
    isBlank: vi.fn((val: any) => !val || String(val).trim() === ""),
}));

vi.mock("@/app/view/sourcecontrol/sourcecontrol", () => ({
    SourceControlView: {},
}));

vi.mock("jotai", () => ({
    atom: vi.fn((initOrFn?: any) => createMockAtom(initOrFn)),
}));

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeReviewFile(overrides: Partial<any> = {}): any {
    return {
        path: "src/index.ts",
        status: "M",
        oldPath: "",
        icon: "fa-file-code",
        color: "#f0ad4e",
        staged: false,
        untracked: false,
        additions: 5,
        deletions: 2,
        ...overrides,
    };
}

function makeStatusResponse(overrides: Partial<any> = {}): any {
    return {
        branch: "main",
        staged: [],
        unstaged: [],
        untracked: [],
        ...overrides,
    };
}

function makeGitFileChange(path: string, status = "M"): any {
    return { path, status, oldPath: "", icon: "fa-file-code", color: "#f0ad4e" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SourceControlViewModel — review mode", () => {
    let model: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        atomStore.clear();
        atomCounter = 0;

        const { SourceControlViewModel } = await import("./sourcecontrol-model");

        model = new (SourceControlViewModel as any)({
            blockId: "test-block",
            waveEnv: {
                getBlockMetaKeyAtom: vi.fn(() => createMockAtom("local")) as any,
                getConnStatusAtom: vi.fn(() => createMockAtom({ connected: true })) as any,
                rpc: {
                    GitStatusCommand: vi.fn(),
                    GitDiffCommand: vi.fn(),
                    GitStageCommand: vi.fn(),
                    GitUnstageCommand: vi.fn(),
                    GitStageHunkCommand: vi.fn(),
                    GitRevertHunkCommand: vi.fn(),
                    GitCommitCommand: vi.fn(),
                    GitPushCommand: vi.fn(),
                    GitLookupCredentialsCommand: vi.fn(),
                    GitSaveCredentialsCommand: vi.fn(),
                } as any,
            } as any,
        });

        model.stopPolling();
        model.disposed = true;
    });

    // ---- enterReview ----

    describe("enterReview", () => {
        it("sets review mode to true and populates files", () => {
            const files = [
                makeReviewFile({ path: "a.ts" }),
                makeReviewFile({ path: "b.ts", additions: 10, deletions: 3 }),
            ];
            model.enterReview(files);

            expect(model.reviewModeAtom._value).toBe(true);
            expect(model.reviewFilesAtom._value).toHaveLength(2);
            expect(model.reviewFilesAtom._value[0].path).toBe("a.ts");
            expect(model.reviewFilesAtom._value[1].path).toBe("b.ts");
        });

        it("resets active index to 0", () => {
            model.reviewActiveIndexAtom._value = 5;
            model.enterReview([makeReviewFile()]);
            expect(model.reviewActiveIndexAtom._value).toBe(0);
        });

        it("resets collapsed state", () => {
            model.reviewCollapsedAtom._value = new Map([["a.ts", true]]);
            model.enterReview([makeReviewFile()]);
            expect(model.reviewCollapsedAtom._value.size).toBe(0);
        });
    });

    // ---- exitReview ----

    describe("exitReview", () => {
        it("sets review mode to false and clears files", () => {
            model.enterReview([makeReviewFile()]);
            expect(model.reviewModeAtom._value).toBe(true);

            model.exitReview();
            expect(model.reviewModeAtom._value).toBe(false);
            expect(model.reviewFilesAtom._value).toHaveLength(0);
            expect(model.reviewActiveIndexAtom._value).toBe(0);
        });

        it("clears diff cache", () => {
            model.diffCacheAtom._value = new Map([
                ["a.ts", { original: "", modified: "", language: "ts" }],
            ]);
            model.exitReview();
            expect(model.diffCacheAtom._value.size).toBe(0);
        });
    });

    // ---- toggleFileCollapse ----

    describe("toggleFileCollapse", () => {
        it("collapses an expanded file", () => {
            model.enterReview([makeReviewFile({ path: "a.ts" })]);
            model.toggleFileCollapse("a.ts");
            expect(model.reviewCollapsedAtom._value.get("a.ts")).toBe(true);
        });

        it("expands a collapsed file", () => {
            model.enterReview([makeReviewFile({ path: "a.ts" })]);
            model.toggleFileCollapse("a.ts");
            model.toggleFileCollapse("a.ts");
            expect(model.reviewCollapsedAtom._value.get("a.ts")).toBe(false);
        });

        it("does not affect other files", () => {
            model.enterReview([
                makeReviewFile({ path: "a.ts" }),
                makeReviewFile({ path: "b.ts" }),
            ]);
            model.toggleFileCollapse("a.ts");
            expect(model.reviewCollapsedAtom._value.has("b.ts")).toBe(false);
        });
    });

    // ---- jumpToFile ----

    describe("jumpToFile", () => {
        it("sets active index for valid index", () => {
            model.enterReview([
                makeReviewFile({ path: "a.ts" }),
                makeReviewFile({ path: "b.ts" }),
                makeReviewFile({ path: "c.ts" }),
            ]);
            model.jumpToFile(2);
            expect(model.reviewActiveIndexAtom._value).toBe(2);
        });

        it("ignores negative index", () => {
            model.enterReview([makeReviewFile({ path: "a.ts" })]);
            model.reviewActiveIndexAtom._value = 0;
            model.jumpToFile(-1);
            expect(model.reviewActiveIndexAtom._value).toBe(0);
        });

        it("ignores out-of-bounds index", () => {
            model.enterReview([makeReviewFile({ path: "a.ts" })]);
            model.reviewActiveIndexAtom._value = 0;
            model.jumpToFile(5);
            expect(model.reviewActiveIndexAtom._value).toBe(0);
        });

        it("calls scrollIntoView when ref exists", () => {
            const mockScroll = vi.fn();
            const mockEl = { scrollIntoView: mockScroll } as any;
            model.reviewFileRefsAtom._value = new Map([["b.ts", mockEl]]);

            model.enterReview([
                makeReviewFile({ path: "a.ts" }),
                makeReviewFile({ path: "b.ts" }),
            ]);
            model.jumpToFile(1);
            expect(mockScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
        });
    });

    // ---- reviewStatsAtom ----

    describe("reviewStatsAtom", () => {
        it("computes total additions and deletions", () => {
            model.enterReview([
                makeReviewFile({ path: "a.ts", additions: 5, deletions: 2 }),
                makeReviewFile({ path: "b.ts", additions: 10, deletions: 0 }),
                makeReviewFile({ path: "c.ts", additions: 0, deletions: 7 }),
            ]);
            const stats = model.reviewStatsAtom._fn(mockAtomGet);
            expect(stats).toEqual({ additions: 15, deletions: 9 });
        });

        it("returns zeros for empty files", () => {
            const stats = model.reviewStatsAtom._fn(mockAtomGet);
            expect(stats).toEqual({ additions: 0, deletions: 0 });
        });
    });

    // ---- updateReviewFilesFromStatus ----

    describe("updateReviewFilesFromStatus", () => {
        it("updates review files with latest staged/unstaged status", () => {
            model.enterReview([
                makeReviewFile({ path: "a.ts", staged: false }),
                makeReviewFile({ path: "b.ts", staged: true }),
            ]);
            model.statusAtom._value = makeStatusResponse({
                staged: [makeGitFileChange("a.ts")],
                unstaged: [makeGitFileChange("b.ts")],
            });

            model.updateReviewFilesFromStatus();

            const files = model.reviewFilesAtom._value;
            expect(files).toHaveLength(2);
            expect(files.find((f: any) => f.path === "a.ts").staged).toBe(true);
            expect(files.find((f: any) => f.path === "b.ts").staged).toBe(false);
        });

        it("removes files no longer in status", () => {
            model.enterReview([
                makeReviewFile({ path: "a.ts" }),
                makeReviewFile({ path: "b.ts" }),
            ]);
            model.statusAtom._value = makeStatusResponse({
                unstaged: [makeGitFileChange("a.ts")],
            });

            model.updateReviewFilesFromStatus();

            const files = model.reviewFilesAtom._value;
            expect(files).toHaveLength(1);
            expect(files[0].path).toBe("a.ts");
        });

        it("does nothing when no review files", () => {
            model.statusAtom._value = makeStatusResponse({
                unstaged: [makeGitFileChange("a.ts")],
            });
            model.updateReviewFilesFromStatus();
            expect(model.reviewFilesAtom._value).toHaveLength(0);
        });

        it("does nothing when no status", () => {
            model.enterReview([makeReviewFile()]);
            model.statusAtom._value = null;
            model.updateReviewFilesFromStatus();
            expect(model.reviewFilesAtom._value).toHaveLength(1);
        });

        it("handles untracked files", () => {
            model.enterReview([
                makeReviewFile({ path: "new.ts", untracked: true }),
            ]);
            model.statusAtom._value = makeStatusResponse({
                untracked: [makeGitFileChange("new.ts", "?")],
            });

            model.updateReviewFilesFromStatus();

            const files = model.reviewFilesAtom._value;
            expect(files).toHaveLength(1);
            expect(files[0].path).toBe("new.ts");
        });
    });

    // ---- stageFileFromReview ----

    describe("stageFileFromReview", () => {
        it("optimistically stages an unstaged file and calls RPC", async () => {
            model.enterReview([makeReviewFile({ path: "a.ts", staged: false })]);
            model.env.rpc.GitStageCommand = vi.fn().mockResolvedValue(undefined);
            model.env.rpc.GitStatusCommand = vi.fn().mockResolvedValue(makeStatusResponse());
            model.disposed = false;

            await model.stageFileFromReview("a.ts", false, false);

            expect(model.reviewFilesAtom._value[0].staged).toBe(true);
            expect(model.env.rpc.GitStageCommand).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ paths: ["a.ts"] }),
                expect.anything()
            );
        });

        it("optimistically unstages a staged file", async () => {
            model.enterReview([makeReviewFile({ path: "a.ts", staged: true })]);
            model.env.rpc.GitUnstageCommand = vi.fn().mockResolvedValue(undefined);
            model.env.rpc.GitStatusCommand = vi.fn().mockResolvedValue(makeStatusResponse());
            model.disposed = false;

            await model.stageFileFromReview("a.ts", true, false);

            expect(model.reviewFilesAtom._value[0].staged).toBe(false);
            expect(model.env.rpc.GitUnstageCommand).toHaveBeenCalled();
        });

        it("optimistically stages an untracked file", async () => {
            model.enterReview([makeReviewFile({ path: "new.ts", untracked: true })]);
            model.env.rpc.GitStageCommand = vi.fn().mockResolvedValue(undefined);
            model.env.rpc.GitStatusCommand = vi.fn().mockResolvedValue(makeStatusResponse());
            model.disposed = false;

            await model.stageFileFromReview("new.ts", false, true);

            expect(model.reviewFilesAtom._value[0].staged).toBe(true);
            expect(model.env.rpc.GitStageCommand).toHaveBeenCalled();
        });

        it("reverts optimistic update on RPC failure", async () => {
            const original = makeReviewFile({ path: "a.ts", staged: false });
            model.enterReview([original]);
            model.env.rpc.GitStageCommand = vi.fn().mockRejectedValue(new Error("fail"));
            model.disposed = true;

            await model.stageFileFromReview("a.ts", false, false);

            expect(model.reviewFilesAtom._value[0].staged).toBe(false);
        });
    });

    // ---- fetchDiffCached ----

    describe("fetchDiffCached", () => {
        it("returns cached diff if available", async () => {
            const cached = { original: "old", modified: "new", language: "ts" };
            model.diffCacheAtom._value = new Map([["a.ts|unstaged|", cached]]);

            const result = await model.fetchDiffCached("a.ts", false, false);
            expect(result).toBe(cached);
        });

        it("fetches and caches diff on cache miss", async () => {
            const fresh = { original: "fresh", modified: "new", language: "ts", hunks: [{ modifiedStart: 1, modifiedCount: 2, originalStart: 1, originalCount: 1, header: "@@" }] };
            model.env.rpc.GitDiffCommand = vi.fn().mockResolvedValue(fresh);
            model.connStatus._value = { connected: true };

            const result = await model.fetchDiffCached("a.ts", false, false);
            expect(result).toEqual(fresh);
            expect(model.diffCacheAtom._value.get("a.ts|unstaged|")).toEqual(fresh);
        });

        it("returns null and does not cache on fetch failure", async () => {
            model.env.rpc.GitDiffCommand = vi.fn().mockRejectedValue(new Error("fail"));
            model.connStatus._value = { connected: true };

            const result = await model.fetchDiffCached("a.ts", false, false);
            expect(result).toBeNull();
            expect(model.diffCacheAtom._value.has("a.ts|unstaged|")).toBe(false);
        });

        it("uses different cache keys for staged vs unstaged", async () => {
            const unstagedDiff = { original: "old", modified: "new", language: "ts", hunks: [] };
            const stagedDiff = { original: "old2", modified: "new2", language: "ts", hunks: [] };
            model.env.rpc.GitDiffCommand = vi.fn()
                .mockResolvedValueOnce(unstagedDiff)
                .mockResolvedValueOnce(stagedDiff);
            model.connStatus._value = { connected: true };

            const r1 = await model.fetchDiffCached("a.ts", false, false);
            const r2 = await model.fetchDiffCached("a.ts", true, false);
            expect(r1).toBe(unstagedDiff);
            expect(r2).toBe(stagedDiff);
            expect(model.env.rpc.GitDiffCommand).toHaveBeenCalledTimes(2);
        });
    });

    // ---- invalidateDiffCache ----

    describe("invalidateDiffCache", () => {
        it("removes all cache entries for a path", () => {
            model.diffCacheAtom._value = new Map([
                ["a.ts|unstaged|", { original: "1", modified: "2", language: "ts" }],
                ["a.ts|staged|", { original: "3", modified: "4", language: "ts" }],
                ["b.ts|unstaged|", { original: "5", modified: "6", language: "ts" }],
            ]);

            model.invalidateDiffCache("a.ts");

            const cache = model.diffCacheAtom._value;
            expect(cache.has("a.ts|unstaged|")).toBe(false);
            expect(cache.has("a.ts|staged|")).toBe(false);
            expect(cache.has("b.ts|unstaged|")).toBe(true);
        });
    });

    // ---- updateFileChangeCounts (stats fix, critical #1) ----

    describe("updateFileChangeCounts", () => {
        it("computes additions/deletions from hunks", () => {
            model.enterReview([makeReviewFile({ path: "a.ts", additions: 0, deletions: 0 })]);
            const diff = {
                original: "old",
                modified: "new",
                language: "ts",
                hunks: [
                    { modifiedStart: 1, modifiedCount: 5, originalStart: 1, originalCount: 3, header: "@@" },
                    { modifiedStart: 10, modifiedCount: 2, originalStart: 10, originalCount: 4, header: "@@" },
                ],
            };
            model.updateFileChangeCounts("a.ts", diff);

            const files = model.reviewFilesAtom._value;
            expect(files[0].additions).toBe(7);
            expect(files[0].deletions).toBe(7);
        });

        it("computes from line counts when no hunks", () => {
            model.enterReview([makeReviewFile({ path: "a.ts", additions: 0, deletions: 0 })]);
            const diff = {
                original: "line1\nline2\nline3",
                modified: "line1\nnew2",
                language: "ts",
            };
            model.updateFileChangeCounts("a.ts", diff);

            const files = model.reviewFilesAtom._value;
            expect(files[0].additions).toBe(2); // "line1\nnew2" has 2 lines
            expect(files[0].deletions).toBe(3); // "line1\nline2\nline3" has 3 lines
        });
    });

    // ---- revertFileFromReview ----

    describe("revertFileFromReview", () => {
        it("invalidates diff cache and calls revertHunk for each hunk", async () => {
            model.enterReview([makeReviewFile({ path: "a.ts", staged: false })]);
            model.diffCacheAtom._value = new Map([
                ["a.ts|unstaged|", {
                    original: "old",
                    modified: "new",
                    language: "ts",
                    hunks: [
                        { modifiedStart: 1, modifiedCount: 2, originalStart: 1, originalCount: 1, header: "@@" },
                        { modifiedStart: 5, modifiedCount: 3, originalStart: 5, originalCount: 2, header: "@@" },
                    ],
                }],
            ]);

            // Spy on revertHunk to verify it's called correctly
            const revertHunkSpy = vi.spyOn(model, "revertHunk").mockResolvedValue(undefined);
            const fetchStatusSpy = vi.spyOn(model, "fetchStatus").mockResolvedValue(undefined);
            model.disposed = false;

            await model.revertFileFromReview("a.ts", false);

            expect(revertHunkSpy).toHaveBeenCalledTimes(2);
            expect(revertHunkSpy).toHaveBeenCalledWith("a.ts", 0, false);
            expect(revertHunkSpy).toHaveBeenCalledWith("a.ts", 1, false);
            expect(model.diffCacheAtom._value.has("a.ts|unstaged|")).toBe(false);
        });
    });
});
