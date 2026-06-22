// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UserInputPrompt } from "@/app/modals/userinputprompt";
import { modalsModel } from "@/app/store/modalmodel";
import { NodeModel } from "@/layout/index";
import * as jotai from "jotai";
import * as React from "react";
import { BlockEnv } from "./blockenv";
import { useWaveEnv } from "@/app/waveenv/waveenv";

export const UserInputPromptOverlay = React.memo(
    ({
        nodeModel,
    }: {
        nodeModel: NodeModel;
    }) => {
        const waveEnv = useWaveEnv<BlockEnv>();
        const connName = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "connection"));
        const activeUserInputPrompts = jotai.useAtomValue(modalsModel.activeUserInputPromptsAtom);

        if (!connName) {
            return null;
        }

        const promptEntry = activeUserInputPrompts[connName];
        if (!promptEntry) {
            console.log("[DEBUG] UserInputPromptOverlay: no prompt for connName:", connName, "blockId:", nodeModel.blockId, "activePrompts:", Object.keys(activeUserInputPrompts));
            return null;
        }

        // Check if this tab has dismissed the prompt
        if (modalsModel.isUserInputPromptDismissedForTab(connName, nodeModel.blockId)) {
            console.log("[DEBUG] UserInputPromptOverlay: prompt dismissed for connName:", connName, "blockId:", nodeModel.blockId);
            return null;
        }

        console.log("[DEBUG] UserInputPromptOverlay: rendering prompt for connName:", connName, "blockId:", nodeModel.blockId);
        return (
            <div
                className="@container absolute inset-0 z-[calc(var(--zindex-block-mask-inner)+1)] flex items-center justify-center"
            >
                <div className="p-3">
                    <UserInputPrompt
                        {...promptEntry.props}
                        blockId={nodeModel.blockId}
                    />
                </div>
            </div>
        );
    }
);
UserInputPromptOverlay.displayName = "UserInputPromptOverlay";
