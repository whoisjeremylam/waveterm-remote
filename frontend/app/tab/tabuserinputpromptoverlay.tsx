// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UserInputPrompt } from "@/app/modals/userinputprompt";
import { modalsModel } from "@/app/store/modalmodel";
import * as jotai from "jotai";
import * as React from "react";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { BlockEnv } from "@/app/block/blockenv";
import { globalStore } from "@/app/store/jotaiStore";

const tabHasTerminalBlockForConn = (
    waveEnv: ReturnType<typeof useWaveEnv<BlockEnv>>,
    blockIds: string[],
    connName: string,
): boolean => {
    for (const blockId of blockIds) {
        const viewAtom = waveEnv.getBlockMetaKeyAtom(blockId, "view");
        const connAtom = waveEnv.getBlockMetaKeyAtom(blockId, "connection");
        const view = globalStore.get(viewAtom);
        const blockConn = globalStore.get(connAtom);
        if (view === "term" && blockConn === connName) {
            return true;
        }
    }
    return false;
};

export const TabUserInputPromptOverlay = React.memo(
    ({
        tabId,
        blockIds,
    }: {
        tabId: string;
        blockIds: string[];
    }) => {
        const waveEnv = useWaveEnv<BlockEnv>();
        const activeUserInputPrompts = jotai.useAtomValue(modalsModel.activeUserInputPromptsAtom);

        const connNamesForThisTab: string[] = [];
        for (const connName of Object.keys(activeUserInputPrompts)) {
            if (tabHasTerminalBlockForConn(waveEnv, blockIds, connName)) {
                connNamesForThisTab.push(connName);
            }
        }

        if (connNamesForThisTab.length === 0) {
            return null;
        }

        return (
            <div className="absolute inset-0 z-[11] flex items-center justify-center pointer-events-none">
                {connNamesForThisTab.map((connName) => (
                    <div key={connName} className="p-3 pointer-events-auto">
                        <UserInputPrompt
                            {...activeUserInputPrompts[connName].props}
                        />
                    </div>
                ))}
            </div>
        );
    }
);
TabUserInputPromptOverlay.displayName = "TabUserInputPromptOverlay";
