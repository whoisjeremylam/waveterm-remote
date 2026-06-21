// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { NewInstallOnboardingModal } from "@/app/onboarding/onboarding";
import { CurrentOnboardingVersion } from "@/app/onboarding/onboarding-common";
import { UpgradeOnboardingModal } from "@/app/onboarding/onboarding-upgrade";
import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { atoms, globalPrimaryTabStartup } from "@/store/global";
import { modalsModel } from "@/store/modalmodel";
import * as jotai from "jotai";
import { useEffect, useMemo } from "react";
import * as semver from "semver";
import { getModalComponent } from "./modalregistry";

function getActiveTabConnections(): Set<string> {
    const tabId = globalStore.get(atoms.staticTabId);
    if (!tabId) {
        return new Set();
    }
    const tabData = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    if (!tabData?.blockids) {
        return new Set();
    }
    const connections = new Set<string>();
    for (const blockId of tabData.blockids) {
        const blockData = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        if (blockData?.meta?.connection) {
            connections.add(blockData.meta.connection);
        }
    }
    return connections;
}

const ModalsRenderer = () => {
    const clientData = jotai.useAtomValue(ClientModel.getInstance().clientAtom);
    const [newInstallOnboardingOpen, setNewInstallOnboardingOpen] = jotai.useAtom(modalsModel.newInstallOnboardingOpen);
    const [upgradeOnboardingOpen, setUpgradeOnboardingOpen] = jotai.useAtom(modalsModel.upgradeOnboardingOpen);
    const [modals] = jotai.useAtom(modalsModel.modalsAtom);
    const activeUserInputPrompts = jotai.useAtomValue(modalsModel.activeUserInputPromptsAtom);
    const tabId = jotai.useAtomValue(atoms.staticTabId);

    const activeTabConnections = useMemo(() => getActiveTabConnections(), [tabId]);

    const rtn: React.ReactElement[] = [];
    for (const modal of modals) {
        const ModalComponent = getModalComponent(modal.displayName);
        if (ModalComponent) {
            rtn.push(<ModalComponent key={modal.displayName} {...modal.props} />);
        }
    }
    for (const [connName, promptEntry] of Object.entries(activeUserInputPrompts)) {
        if (connName && !activeTabConnections.has(connName)) {
            continue;
        }
        const PromptComponent = getModalComponent(promptEntry.displayName);
        if (PromptComponent) {
            rtn.push(<PromptComponent key={`userinput-${connName}`} {...promptEntry.props} />);
        }
    }
    if (newInstallOnboardingOpen) {
        rtn.push(<NewInstallOnboardingModal key={NewInstallOnboardingModal.displayName} />);
    }
    if (upgradeOnboardingOpen) {
        rtn.push(<UpgradeOnboardingModal key={UpgradeOnboardingModal.displayName} />);
    }
    useEffect(() => {
        if (!clientData.tosagreed) {
            setNewInstallOnboardingOpen(true);
        }
    }, [clientData]);

    useEffect(() => {
        if (!globalPrimaryTabStartup) {
            return;
        }
        if (!clientData.tosagreed) {
            return;
        }
        const lastVersion = clientData.meta?.["onboarding:lastversion"] ?? "v0.0.0";
        if (semver.lt(lastVersion, CurrentOnboardingVersion)) {
            setUpgradeOnboardingOpen(true);
        }
    }, []);
    useEffect(() => {
        const hasBlockingModals = rtn.some((el) => typeof el.key === "string" && !el.key.startsWith("userinput-"));
        globalStore.set(atoms.modalOpen, hasBlockingModals);
    }, [rtn]);

    return <>{rtn}</>;
};

export { ModalsRenderer };
