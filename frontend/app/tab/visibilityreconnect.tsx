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

/** Default attention heartbeat while a disconnected tab is visible (UX-0.3 D4). */
const HEARTBEAT_DEFAULT_MS = 30_000;
/** Faster heartbeat after network-unreachable dial failures (UX-0.3 D4). */
const HEARTBEAT_NETWORK_MS = 10_000;

const NETWORK_UNREACHABLE_CODES = new Set([
    "dial-error",
    "dial-proxy-jump",
]);

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
 * UX-0.1 / UX-0.5: skips conns with suppressautoreconnect (user Disconnect,
 * Stop auto-retry, password Cancel, permanent host-key failures). Backend also
 * gates EnsureConnection.
 *
 * UX-0.3: while the tab stays visible with a disconnected/error conn (and
 * suppress clear), runs a slow heartbeat (30s default, 10s after network
 * errors) and fires immediately on the browser `online` event.
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
        // Returns the recommended next heartbeat interval (ms) based on last
        // error codes seen, or null if no eligible disconnected conns.
        const fireReconnect = React.useCallback((): number | null => {
            if (!tabId || !blockIds || blockIds.length === 0) {
                return null;
            }
            const seenConns = new Set<string>();
            let eligibleCount = 0;
            let useNetworkInterval = false;
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
                // UX-0.1 / UX-0.5: sticky suppress after user Disconnect, Stop
                // auto-retry, password Cancel, or permanent failures.
                if (connStatus.suppressautoreconnect) {
                    continue;
                }
                // Permanent host-key failures: backend sets suppress, but also
                // skip by errorcode so we never re-storm if flag lagged.
                if (
                    connStatus.errorcode === "hostkey-changed" ||
                    connStatus.errorcode === "hostkey-revoked" ||
                    connStatus.errorcode === "hostkey-verify"
                ) {
                    continue;
                }
                // If a password prompt is already active for this connection,
                // the user is being asked — don't pile on another Connect.
                if (
                    modalsModel.activeUserInputPromptsAtom &&
                    globalStore.get(modalsModel.activeUserInputPromptsAtom)[connName]
                ) {
                    continue;
                }
                eligibleCount++;
                if (connStatus.errorcode && NETWORK_UNREACHABLE_CODES.has(connStatus.errorcode)) {
                    useNetworkInterval = true;
                }
                // Fire-and-forget; backend serializes via cooldown + pendingAuth.
                // Interactive auth without cache is OK when tab is visible (D5).
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
            if (eligibleCount === 0) {
                return null;
            }
            return useNetworkInterval ? HEARTBEAT_NETWORK_MS : HEARTBEAT_DEFAULT_MS;
        }, [tabId, blockIds, waveEnv]);

        // Debounced trigger — coalesces rapid tab switches / focus bursts.
        const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const heartbeatRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

        const clearHeartbeat = React.useCallback(() => {
            if (heartbeatRef.current) {
                clearTimeout(heartbeatRef.current);
                heartbeatRef.current = null;
            }
        }, []);

        const scheduleHeartbeat = React.useCallback(
            (intervalMs: number) => {
                clearHeartbeat();
                heartbeatRef.current = setTimeout(() => {
                    heartbeatRef.current = null;
                    // Only heartbeat while document is visible (attention-bound).
                    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
                        return;
                    }
                    const next = fireReconnect();
                    if (next != null) {
                        scheduleHeartbeat(next);
                    }
                }, intervalMs);
            },
            [clearHeartbeat, fireReconnect]
        );

        const scheduleReconnect = React.useCallback(() => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
            debounceRef.current = setTimeout(() => {
                debounceRef.current = null;
                const next = fireReconnect();
                if (next != null) {
                    scheduleHeartbeat(next);
                } else {
                    clearHeartbeat();
                }
            }, RECONNECT_DEBOUNCE_MS);
        }, [fireReconnect, scheduleHeartbeat, clearHeartbeat]);

        // Trigger 1: tab switch — when tabId changes, scan the new tab.
        React.useEffect(() => {
            scheduleReconnect();
            return () => {
                if (debounceRef.current) {
                    clearTimeout(debounceRef.current);
                    debounceRef.current = null;
                }
                clearHeartbeat();
            };
        }, [tabId, scheduleReconnect, clearHeartbeat]);

        // Trigger 2: window focus — when waveterm regains focus, re-scan the
        // active tab. Catches "switch away from waveterm and back" without a
        // tab change.
        React.useEffect(() => {
            const handleFocus = () => scheduleReconnect();
            window.addEventListener("focus", handleFocus);
            return () => window.removeEventListener("focus", handleFocus);
        }, [scheduleReconnect]);

        // Trigger 3 (UX-0.3): OS/browser network online — immediate kick.
        // Degrades gracefully if the event is unavailable.
        React.useEffect(() => {
            const handleOnline = () => scheduleReconnect();
            window.addEventListener("online", handleOnline);
            return () => window.removeEventListener("online", handleOnline);
        }, [scheduleReconnect]);

        // Pause heartbeat when the document is hidden; resume on visible.
        React.useEffect(() => {
            const handleVisibility = () => {
                if (document.visibilityState === "visible") {
                    scheduleReconnect();
                } else {
                    clearHeartbeat();
                }
            };
            document.addEventListener("visibilitychange", handleVisibility);
            return () => document.removeEventListener("visibilitychange", handleVisibility);
        }, [scheduleReconnect, clearHeartbeat]);

        return null;
    }
);
VisibilityReconnectHandler.displayName = "VisibilityReconnectHandler";
