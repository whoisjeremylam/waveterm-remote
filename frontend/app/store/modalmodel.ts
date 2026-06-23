// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as jotai from "jotai";
import { globalStore } from "./jotaiStore";

class ModalsModel {
    modalsAtom: jotai.PrimitiveAtom<Array<{ displayName: string; props?: any }>>;
    newInstallOnboardingOpen: jotai.PrimitiveAtom<boolean>;
    upgradeOnboardingOpen: jotai.PrimitiveAtom<boolean>;
    activeUserInputPromptsAtom: jotai.PrimitiveAtom<Record<string, { displayName: string; props: any }>>;
    dismissedUserInputPromptsAtom: jotai.PrimitiveAtom<Record<string, string[]>>;

    constructor() {
        this.newInstallOnboardingOpen = jotai.atom(false);
        this.upgradeOnboardingOpen = jotai.atom(false);
        this.modalsAtom = jotai.atom([]);
        this.activeUserInputPromptsAtom = jotai.atom({});
        this.dismissedUserInputPromptsAtom = jotai.atom({});
    }

    pushModal = (displayName: string, props?: any) => {
        const modals = globalStore.get(this.modalsAtom);
        globalStore.set(this.modalsAtom, [...modals, { displayName, props }]);
    };

    popModal = (callback?: () => void) => {
        const modals = globalStore.get(this.modalsAtom);
        if (modals.length > 0) {
            const updatedModals = modals.slice(0, -1);
            globalStore.set(this.modalsAtom, updatedModals);
            if (callback) callback();
        }
    };

    hasOpenModals(): boolean {
        const modals = globalStore.get(this.modalsAtom);
        const userInputPrompts = globalStore.get(this.activeUserInputPromptsAtom);
        return modals.length > 0 || Object.keys(userInputPrompts).length > 0;
    }

    isModalOpen(displayName: string): boolean {
        const modals = globalStore.get(this.modalsAtom);
        return modals.some((modal) => modal.displayName === displayName);
    }

    upsertUserInputPrompt(connName: string, displayName: string, props: any) {
        console.log(`[PW-MODEL] upsert: connName=${connName}, requestId=${props?.requestid}`);
        globalStore.set(this.activeUserInputPromptsAtom, (prev) => ({
            ...prev,
            [connName]: { displayName, props },
        }));
        // Clear per-tab dismissals — new prompt attempt means all tabs should re-show
        globalStore.set(this.dismissedUserInputPromptsAtom, (prev) => {
            if (!(connName in prev)) {
                return prev;
            }
            const next = { ...prev };
            delete next[connName];
            return next;
        });
    }

    dismissUserInputPrompt(connName: string) {
        console.log(`[PW-MODEL] dismiss: connName=${connName}`);
        globalStore.set(this.activeUserInputPromptsAtom, (prev) => {
            const next = { ...prev };
            delete next[connName];
            return next;
        });
        // Also clear per-tab dismissals for this connection
        globalStore.set(this.dismissedUserInputPromptsAtom, (prev) => {
            if (!(connName in prev)) {
                return prev;
            }
            const next = { ...prev };
            delete next[connName];
            return next;
        });
    }

    dismissAllUserInputPrompts() {
        globalStore.set(this.activeUserInputPromptsAtom, {});
        globalStore.set(this.dismissedUserInputPromptsAtom, {});
    }

    dismissUserInputPromptForTab(connName: string, blockId: string) {
        globalStore.set(this.dismissedUserInputPromptsAtom, (prev) => {
            const dismissed = prev[connName] || [];
            if (dismissed.includes(blockId)) {
                return prev;
            }
            return {
                ...prev,
                [connName]: [...dismissed, blockId],
            };
        });
    }

    isUserInputPromptDismissedForTab(connName: string, blockId: string): boolean {
        const dismissed = globalStore.get(this.dismissedUserInputPromptsAtom);
        return dismissed[connName]?.includes(blockId) ?? false;
    }

    resetDismissedUserInputPrompts(connName: string) {
        globalStore.set(this.dismissedUserInputPromptsAtom, (prev) => {
            if (!(connName in prev)) {
                return prev;
            }
            const next = { ...prev };
            delete next[connName];
            return next;
        });
    }
}

const modalsModel = new ModalsModel();

export { modalsModel };
