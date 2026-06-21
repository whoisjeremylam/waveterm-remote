// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as jotai from "jotai";
import { globalStore } from "./jotaiStore";

class ModalsModel {
    modalsAtom: jotai.PrimitiveAtom<Array<{ displayName: string; props?: any }>>;
    newInstallOnboardingOpen: jotai.PrimitiveAtom<boolean>;
    upgradeOnboardingOpen: jotai.PrimitiveAtom<boolean>;
    activeUserInputPromptsAtom: jotai.PrimitiveAtom<Record<string, { displayName: string; props: any }>>;

    constructor() {
        this.newInstallOnboardingOpen = jotai.atom(false);
        this.upgradeOnboardingOpen = jotai.atom(false);
        this.modalsAtom = jotai.atom([]);
        this.activeUserInputPromptsAtom = jotai.atom({});
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
        globalStore.set(this.activeUserInputPromptsAtom, (prev) => ({
            ...prev,
            [connName]: { displayName, props },
        }));
    }

    dismissUserInputPrompt(connName: string) {
        globalStore.set(this.activeUserInputPromptsAtom, (prev) => {
            const next = { ...prev };
            delete next[connName];
            return next;
        });
    }

    dismissAllUserInputPrompts() {
        globalStore.set(this.activeUserInputPromptsAtom, {});
    }
}

const modalsModel = new ModalsModel();

export { modalsModel };
