// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("ModalsModel - user input prompt methods", () => {
    let modalsModel: any;
    let mockStore: Map<any, any>;

    beforeEach(async () => {
        vi.resetModules();
        mockStore = new Map();

        vi.doMock("./jotaiStore", () => ({
            globalStore: {
                get: (atom: any) => mockStore.get(atom) ?? atom.init,
                set: (atom: any, value: any) => {
                    if (typeof value === "function") {
                        const current = mockStore.get(atom) ?? atom.init;
                        mockStore.set(atom, value(current));
                    } else {
                        mockStore.set(atom, value);
                    }
                },
            },
        }));

        const mod = await import("./modalmodel");
        modalsModel = mod.modalsModel;
    });

    describe("upsertUserInputPrompt", () => {
        it("adds a new prompt keyed by connName", () => {
            modalsModel.upsertUserInputPrompt("user@host", "UserInputPrompt", { requestid: "123" });

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value).toEqual({
                "user@host": { displayName: "UserInputPrompt", props: { requestid: "123" } },
            });
        });

        it("updates existing prompt for same connName", () => {
            modalsModel.upsertUserInputPrompt("user@host", "UserInputPrompt", { requestid: "123" });
            modalsModel.upsertUserInputPrompt("user@host", "UserInputPrompt", { requestid: "456" });

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value).toEqual({
                "user@host": { displayName: "UserInputPrompt", props: { requestid: "456" } },
            });
        });

        it("keeps separate prompts for different connNames", () => {
            modalsModel.upsertUserInputPrompt("user@host1", "UserInputPrompt", { requestid: "1" });
            modalsModel.upsertUserInputPrompt("user@host2", "UserInputPrompt", { requestid: "2" });

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(Object.keys(value)).toEqual(["user@host1", "user@host2"]);
            expect(value["user@host1"].props.requestid).toBe("1");
            expect(value["user@host2"].props.requestid).toBe("2");
        });
    });

    describe("dismissUserInputPrompt", () => {
        it("removes prompt for given connName", () => {
            modalsModel.upsertUserInputPrompt("user@host1", "UserInputPrompt", {});
            modalsModel.upsertUserInputPrompt("user@host2", "UserInputPrompt", {});

            modalsModel.dismissUserInputPrompt("user@host1");

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(Object.keys(value)).toEqual(["user@host2"]);
        });

        it("does not error when dismissing non-existent connName", () => {
            modalsModel.upsertUserInputPrompt("user@host", "UserInputPrompt", {});

            modalsModel.dismissUserInputPrompt("nonexistent");

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(Object.keys(value)).toEqual(["user@host"]);
        });

        it("handles dismissing from empty state", () => {
            modalsModel.dismissUserInputPrompt("user@host");

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value).toEqual({});
        });
    });

    describe("dismissAllUserInputPrompts", () => {
        it("clears all prompts", () => {
            modalsModel.upsertUserInputPrompt("user@host1", "UserInputPrompt", {});
            modalsModel.upsertUserInputPrompt("user@host2", "UserInputPrompt", {});

            modalsModel.dismissAllUserInputPrompts();

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value).toEqual({});
        });

        it("handles dismissing when no prompts exist", () => {
            modalsModel.dismissAllUserInputPrompts();

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value).toEqual({});
        });
    });

    describe("popModal", () => {
        it("returns true when a modal is popped", () => {
            modalsModel.pushModal("SomeModal", {});

            const popped = modalsModel.popModal();

            expect(popped).toBe(true);
            expect(mockStore.get(modalsModel.modalsAtom)).toEqual([]);
        });

        it("returns false when the modal stack is empty", () => {
            const popped = modalsModel.popModal();

            expect(popped).toBe(false);
        });
    });

    describe("upsertUserInputPrompt auto-expiry", () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it("auto-dismisses a prompt after timeoutms + 1000", () => {
            vi.useFakeTimers();
            modalsModel.upsertUserInputPrompt("user@host", "UserInputPrompt", { requestid: "123", timeoutms: 1000 });

            let value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value["user@host"]).toBeDefined();

            // Not yet expired (timer fires at timeoutms + 1000 = 2000)
            vi.advanceTimersByTime(1999);
            value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value["user@host"]).toBeDefined();

            vi.advanceTimersByTime(1);
            value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value["user@host"]).toBeUndefined();
        });

        it("stale timer does not dismiss a newer prompt with a different requestid", () => {
            vi.useFakeTimers();
            modalsModel.upsertUserInputPrompt("user@host", "UserInputPrompt", { requestid: "old", timeoutms: 1000 });
            // Newer prompt for the same conn supersedes the old one before its timer fires
            modalsModel.upsertUserInputPrompt("user@host", "UserInputPrompt", { requestid: "new" });

            vi.advanceTimersByTime(5000);

            const value = mockStore.get(modalsModel.activeUserInputPromptsAtom);
            expect(value["user@host"]).toBeDefined();
            expect(value["user@host"].props.requestid).toBe("new");
        });
    });
});
