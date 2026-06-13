// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach } from "vitest";

describe("ModalsModel - user input modal methods", () => {
    let modalsModel: any;
    let mockStore: Map<any, any>;

    beforeEach(async () => {
        vi.resetModules();
        mockStore = new Map();

        vi.doMock("./jotaiStore", () => ({
            globalStore: {
                get: (atom: any) => mockStore.get(atom),
                set: (atom: any, value: any) => {
                    if (typeof value === "function") {
                        const current = mockStore.get(atom);
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

    describe("upsertUserInputModal", () => {
        it("adds a new modal keyed by connName", () => {
            modalsModel.upsertUserInputModal("user@host", "UserInputModal", { requestid: "123" });

            const value = mockStore.get(modalsModel.activeUserInputModalsAtom);
            expect(value).toEqual({
                "user@host": { displayName: "UserInputModal", props: { requestid: "123" } },
            });
        });

        it("updates existing modal for same connName", () => {
            modalsModel.upsertUserInputModal("user@host", "UserInputModal", { requestid: "123" });
            modalsModel.upsertUserInputModal("user@host", "UserInputModal", { requestid: "456" });

            const value = mockStore.get(modalsModel.activeUserInputModalsAtom);
            expect(value).toEqual({
                "user@host": { displayName: "UserInputModal", props: { requestid: "456" } },
            });
        });

        it("keeps separate modals for different connNames", () => {
            modalsModel.upsertUserInputModal("user@host1", "UserInputModal", { requestid: "1" });
            modalsModel.upsertUserInputModal("user@host2", "UserInputModal", { requestid: "2" });

            const value = mockStore.get(modalsModel.activeUserInputModalsAtom);
            expect(Object.keys(value)).toEqual(["user@host1", "user@host2"]);
            expect(value["user@host1"].props.requestid).toBe("1");
            expect(value["user@host2"].props.requestid).toBe("2");
        });
    });

    describe("dismissUserInputModal", () => {
        it("removes modal for given connName", () => {
            modalsModel.upsertUserInputModal("user@host1", "UserInputModal", {});
            modalsModel.upsertUserInputModal("user@host2", "UserInputModal", {});

            modalsModel.dismissUserInputModal("user@host1");

            const value = mockStore.get(modalsModel.activeUserInputModalsAtom);
            expect(Object.keys(value)).toEqual(["user@host2"]);
        });

        it("does not error when dismissing non-existent connName", () => {
            modalsModel.upsertUserInputModal("user@host", "UserInputModal", {});

            modalsModel.dismissUserInputModal("nonexistent");

            const value = mockStore.get(modalsModel.activeUserInputModalsAtom);
            expect(Object.keys(value)).toEqual(["user@host"]);
        });

        it("handles dismissing from empty state", () => {
            modalsModel.dismissUserInputModal("user@host");

            const value = mockStore.get(modalsModel.activeUserInputModalsAtom);
            expect(value).toEqual({});
        });
    });

    describe("dismissAllUserInputModals", () => {
        it("clears all modals", () => {
            modalsModel.upsertUserInputModal("user@host1", "UserInputModal", {});
            modalsModel.upsertUserInputModal("user@host2", "UserInputModal", {});

            modalsModel.dismissAllUserInputModals();

            const value = mockStore.get(modalsModel.activeUserInputModalsAtom);
            expect(value).toEqual({});
        });

        it("handles dismissing when no modals exist", () => {
            modalsModel.dismissAllUserInputModals();

            const value = mockStore.get(modalsModel.activeUserInputModalsAtom);
            expect(value).toEqual({});
        });
    });
});
