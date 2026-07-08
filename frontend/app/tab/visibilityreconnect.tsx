// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { modalsModel } from "@/app/store/modalmodel";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { BlockEnv } from "@/app/block/blockenv";
import { globalStore } from "@/app/store/jotaiStore";
import { isLocalConnName, isWslConnName } from "@/util/util";
import * as React from "react";

const RECONNECT_DEBOUNCE_MS = 200;

/**
 * VisibilityReconnectHandler fires ConnEnsureCommand for disconnected/error
 * connections on the active tab when the user's attention returns to waveterm
 * — on tab switch and on window focus. This is the core "feels connected all
 * along" behavior: the user should never have to click "Reconnect" after a
 * sleep/wake or network drop just because they switched tabs.
 *
 * The backend (EnsureConnection) is idempotent and cooldown-guarded (5s), so
 * rapid tab switches or focus events do not cause reconnect storms. Only
 * terminal blocks with a connection are considered; local and WSL connections
 * are skipped. Connections that are already connected or connecting are left
 * alone.
 *
 * This component renders nothing — it is a side-effect-only handler mounted
 * in WorkspaceElem alongside TabUserInputPromptOverlay.
 */
export const VisibilityReconnectHandler = React.memo(
    ({ tabId, blockIds }: { tabId: string; blockIds: string[] }) => {
        const waveEnv = useWaveEnv<BlockEnv>();

        // The reconnect scan. Reads block meta + conn status from the store
        // (non-reactive — we read on trigger, not subscribe) and fires
        // ConnEnsureCommand for each unique disconnected/error connection.
        const fireReconnect = React.useCallback(() => {
            if (!tabId || !blockIds || blockIds.length === 0) {
                return;
            }
            const seenConns = new Set<string>();
            for (const blockId of blockIds) {
                const view = globalStore.get(waveEnv.getBlockMetaKeyAtom(blockId, "view"));
                if (view !== "term") {
                    continue;
                }
                const connName = globalStore.get(waveEnv.getBlockMetaKeyAtom(blockId, "connection"));
                if (!connName || isLocalConnName(connName) || isWslConnName(connName)) {
                    continue;
                }
                if (seenConns.has(connName)) {
                    continue;
                }
                seenConns.add(connName);
                const connStatus = globalStore.get(waveEnv.getConnStatusAtom(connName));
                if (!connStatus) {
                    continue;
                }
                // Only reconnect if disconnected or errored. "connecting" and
                // "connected" are left alone — EnsureConnection would no-op
                // anyway, but skipping avoids unnecessary RPC noise.
                if (connStatus.status !== "disconnected" && connStatus.status !== "error") {
                    continue;
                }
                // If a password prompt is already active for this connection,
                // the user is being asked — don't pile on another Connect.
                if (modalsModel.activeUserInputPromptsAtom && globalStore.get(modalsModel.activeUserInputPromptsAtom)[connName]) {
                    continue;
                }
                // Fire-and-forget; backend serializes via cooldown + pendingAuth.
                waveEnv.rpc
                    .ConnEnsureCommand(
                        TabRpcClient,
                        { connname: connName, logblockid: blockId },
                        { timeout: 60000 }
                    )
                    .catch((e) => {
                        console.log("visibility reconnect error", connName, e);
                    });
            }
        }, [tabId, blockIds, waveEnv]);

        // Debounced trigger — coalesces rapid tab switches / focus bursts.
        const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const scheduleReconnect = React.useCallback(() => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
            debounceRef.current = setTimeout(() => {
                debounceRef.current = null;
                fireReconnect();
            }, RECONNECT_DEBOUNCE_MS);
        }, [fireReconnect]);

        // Trigger 1: tab switch — when tabId changes, scan the new tab.
        React.useEffect(() => {
            scheduleReconnect();
            return () => {
                if (debounceRef.current) {
                    clearTimeout(debounceRef.current);
                    debounceRef.current = null;
                }
            };
        }, [tabId, scheduleReconnect]);

        // Trigger 2: window focus — when waveterm regains focus, re-scan the
        // active tab. Catches "switch away from waveterm and back" without a
        // tab change.
        React.useEffect(() => {
            const handleFocus = () => scheduleReconnect();
            window.addEventListener("focus", handleFocus);
            return () => window.removeEventListener("focus", handleFocus);
        }, [scheduleReconnect]);

        return null;
    }
);
VisibilityReconnectHandler.displayName = "VisibilityReconnectHandler";