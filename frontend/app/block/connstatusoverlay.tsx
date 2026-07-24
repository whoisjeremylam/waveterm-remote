// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/app/element/button";
import { CopyButton } from "@/app/element/copybutton";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { modalsModel } from "@/app/store/modalmodel";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { NodeModel } from "@/layout/index";
import * as util from "@/util/util";
import clsx from "clsx";
import * as jotai from "jotai";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import * as React from "react";
import { BlockEnv } from "./blockenv";

function formatElapsedTime(elapsedMs: number): string {
    if (elapsedMs <= 0) {
        return "";
    }

    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    if (elapsedSeconds < 60) {
        return `${elapsedSeconds}s`;
    }

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
        return `${elapsedMinutes}m`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    const remainingMinutes = elapsedMinutes % 60;

    if (elapsedHours < 24) {
        if (remainingMinutes === 0) {
            return `${elapsedHours}h`;
        }
        return `${elapsedHours}h${remainingMinutes}m`;
    }

    return "more than a day";
}

function formatCountdown(nextAttemptMs: number): string {
    const remaining = Math.max(0, Math.ceil((nextAttemptMs - Date.now()) / 1000));
    if (remaining <= 0) {
        return "now";
    }
    return `${remaining}s`;
}

const PERMANENT_HOSTKEY_CODES = new Set(["hostkey-changed", "hostkey-revoked", "hostkey-verify"]);
const PERMANENT_KNOWNHOSTS_CODES = new Set(["knownhosts-none", "knownhosts-format"]);

function permanentErrorTitle(errorCode?: string): string | null {
    if (!errorCode) {
        return null;
    }
    if (PERMANENT_HOSTKEY_CODES.has(errorCode)) {
        return "Host key verification failed";
    }
    if (PERMANENT_KNOWNHOSTS_CODES.has(errorCode)) {
        return "known_hosts problem";
    }
    if (errorCode === "config-parse" || errorCode === "config-default") {
        return "SSH config error";
    }
    return null;
}

function permanentErrorHint(errorCode?: string): string | null {
    if (!errorCode) {
        return null;
    }
    if (errorCode === "hostkey-changed") {
        return "The remote host key has changed. This can mean the server was reinstalled — or a MITM attack. Update your known_hosts only if you trust this change. Auto-retry is stopped.";
    }
    if (errorCode === "hostkey-revoked") {
        return "The remote host key has been revoked. Auto-retry is stopped.";
    }
    if (errorCode === "hostkey-verify") {
        return "Could not verify the remote host key. Auto-retry is stopped.";
    }
    if (PERMANENT_KNOWNHOSTS_CODES.has(errorCode)) {
        return "Check your known_hosts file configuration. Auto-retry is stopped.";
    }
    if (errorCode === "config-parse" || errorCode === "config-default") {
        return "Fix your SSH configuration, then click Reconnect. Auto-retry is stopped.";
    }
    return null;
}

const overlayShellClass =
    "@container absolute top-[calc(var(--header-height)+6px)] left-1.5 right-1.5 z-[var(--zindex-block-mask-inner)] overflow-hidden rounded-md bg-[var(--conn-status-overlay-bg-color)] backdrop-blur-[50px] shadow-lg opacity-90";

const StalledOverlay = React.memo(
    ({
        connName,
        connStatus,
        overlayRefCallback,
    }: {
        connName: string;
        connStatus: ConnStatus;
        overlayRefCallback: (el: HTMLDivElement | null) => void;
    }) => {
        const [elapsedTime, setElapsedTime] = React.useState<string>("");

        const waveEnv = useWaveEnv<BlockEnv>();
        const handleDisconnect = React.useCallback(() => {
            const prtn = waveEnv.rpc.ConnDisconnectCommand(TabRpcClient, connName, { timeout: 5000 });
            prtn.catch((e) => console.log("error disconnecting", connName, e));
        }, [connName, waveEnv]);

        React.useEffect(() => {
            if (!connStatus.lastactivitybeforestalledtime) {
                return;
            }

            const updateElapsed = () => {
                const now = Date.now();
                const lastActivity = connStatus.lastactivitybeforestalledtime!;
                const elapsed = now - lastActivity;
                setElapsedTime(formatElapsedTime(elapsed));
            };

            updateElapsed();
            const interval = setInterval(updateElapsed, 1000);

            return () => clearInterval(interval);
        }, [connStatus.lastactivitybeforestalledtime]);

        return (
            <div className={overlayShellClass} ref={overlayRefCallback}>
                <div className="flex items-center gap-3 w-full pt-2.5 pb-2.5 pr-2 pl-3">
                    <i
                        className="fa-solid fa-triangle-exclamation text-warning text-base shrink-0"
                        title="Connection Stalled"
                    ></i>
                    <div className="text-[11px] font-semibold leading-4 tracking-[0.11px] text-white min-w-0 flex-1 break-words @max-xxs:hidden">
                        Connection to "{connName}" is stalled
                        {elapsedTime && ` (no activity for ${elapsedTime})`}
                    </div>
                    <div className="flex-1 hidden @max-xxs:block"></div>
                    <Button
                        className="outlined grey text-[11px] py-[3px] px-[7px] @max-w350:text-[12px] @max-w350:py-[5px] @max-w350:px-[6px]"
                        onClick={handleDisconnect}
                        title="Disconnect"
                    >
                        <span className="@max-w350:hidden!">Disconnect</span>
                        <i className="fa-solid fa-link-slash hidden! @max-w350:inline!"></i>
                    </Button>
                </div>
            </div>
        );
    }
);
StalledOverlay.displayName = "StalledOverlay";

const StopAutoRetryButton = React.memo(({ onStop, compact }: { onStop: () => void; compact?: boolean }) => (
    <Button
        className="outlined grey text-[11px] py-[3px] px-[7px] @max-w350:text-[12px] @max-w350:py-[5px] @max-w350:px-[6px]"
        onClick={onStop}
        title="Stop auto-retry"
    >
        <span className="@max-w350:hidden!">{compact ? "Stop" : "Stop auto-retry"}</span>
        <i className="fa-solid fa-hand hidden! @max-w350:inline!"></i>
    </Button>
));
StopAutoRetryButton.displayName = "StopAutoRetryButton";

const DisconnectedOverlay = React.memo(
    ({
        connName,
        connStatus,
        overlayRefCallback,
        onReconnect,
        onStopAutoRetry,
    }: {
        connName: string;
        connStatus: ConnStatus;
        overlayRefCallback: (el: HTMLDivElement | null) => void;
        onReconnect: () => void;
        onStopAutoRetry?: () => void;
    }) => {
        const [countdown, setCountdown] = React.useState<string>("");
        const hasCountdown = connStatus.reconnectnextattempt && connStatus.reconnectnextattempt > 0;
        const permanentTitle = permanentErrorTitle(connStatus.errorcode);
        const permanentHint = permanentErrorHint(connStatus.errorcode);

        React.useEffect(() => {
            if (!hasCountdown) {
                return;
            }
            const update = () => {
                setCountdown(formatCountdown(connStatus.reconnectnextattempt!));
            };
            update();
            const interval = setInterval(update, 1000);
            return () => clearInterval(interval);
        }, [connStatus.reconnectnextattempt, hasCountdown]);

        return (
            <div className={overlayShellClass} ref={overlayRefCallback}>
                <div className="flex items-center gap-3 w-full pt-2.5 pb-2.5 pr-2 pl-3">
                    <i
                        className={clsx(
                            "text-base shrink-0",
                            permanentTitle ? "fa-solid fa-shield-halved text-error" : "fa-solid fa-link-slash text-error"
                        )}
                        title={permanentTitle ?? "Disconnected"}
                    ></i>
                    <div className="text-[11px] font-semibold leading-4 tracking-[0.11px] text-white min-w-0 flex-1 break-words @max-xxs:hidden">
                        {permanentTitle ? (
                            <>
                                <div>
                                    {permanentTitle} — "{connName}"
                                </div>
                                {permanentHint && (
                                    <div className="text-[10px] text-white/70 mt-0.5">{permanentHint}</div>
                                )}
                                {connStatus.error && (
                                    <div className="text-[10px] text-white/50 mt-0.5 truncate">{connStatus.error}</div>
                                )}
                            </>
                        ) : (
                            <>
                                <div>Disconnected from "{connName}"</div>
                                {connStatus.error && (
                                    <div className="text-[10px] text-white/70 mt-0.5 truncate">{connStatus.error}</div>
                                )}
                                {hasCountdown && countdown !== "now" && (
                                    <div className="text-[10px] text-white/70 mt-0.5">
                                        Auto-retrying in {countdown}
                                    </div>
                                )}
                                {connStatus.suppressautoreconnect && !hasCountdown && (
                                    <div className="text-[10px] text-white/70 mt-0.5">
                                        Auto-retry paused — click Reconnect when ready
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                    <div className="flex-1 hidden @max-xxs:block"></div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {onStopAutoRetry && hasCountdown && !permanentTitle && (
                            <StopAutoRetryButton onStop={onStopAutoRetry} compact />
                        )}
                        <Button
                            className="outlined grey text-[11px] py-[3px] px-[7px] @max-w350:text-[12px] @max-w350:py-[5px] @max-w350:px-[6px]"
                            onClick={onReconnect}
                            title="Reconnect now"
                        >
                            <span className="@max-w350:hidden!">Reconnect</span>
                            <i className="fa-solid fa-rotate-right hidden! @max-w350:inline!"></i>
                        </Button>
                    </div>
                </div>
            </div>
        );
    }
);
DisconnectedOverlay.displayName = "DisconnectedOverlay";

const RetryingOverlay = React.memo(
    ({
        connName,
        attempt,
        overlayRefCallback,
        onStopAutoRetry,
    }: {
        connName: string;
        attempt: number;
        overlayRefCallback: (el: HTMLDivElement | null) => void;
        onStopAutoRetry?: () => void;
    }) => {
        return (
            <div className={overlayShellClass} ref={overlayRefCallback}>
                <div className="flex items-center gap-3 w-full pt-2.5 pb-2.5 pr-2 pl-3">
                    <i className="fa-solid fa-spinner fa-spin text-warning text-base shrink-0" title="Connecting"></i>
                    <div className="text-[11px] font-semibold leading-4 tracking-[0.11px] text-white min-w-0 flex-1 break-words @max-xxs:hidden">
                        Attempt {attempt} — connecting to "{connName}"…
                    </div>
                    <div className="flex-1 hidden @max-xxs:block"></div>
                    {onStopAutoRetry && <StopAutoRetryButton onStop={onStopAutoRetry} compact />}
                </div>
            </div>
        );
    }
);
RetryingOverlay.displayName = "RetryingOverlay";

const CountdownOverlay = React.memo(
    ({
        connName,
        connStatus,
        overlayRefCallback,
        onReconnectNow,
        onStopAutoRetry,
    }: {
        connName: string;
        connStatus: ConnStatus;
        overlayRefCallback: (el: HTMLDivElement | null) => void;
        onReconnectNow: () => void;
        onStopAutoRetry?: () => void;
    }) => {
        const [countdown, setCountdown] = React.useState<string>("");

        React.useEffect(() => {
            if (!connStatus.reconnectnextattempt) {
                return;
            }
            const update = () => {
                setCountdown(formatCountdown(connStatus.reconnectnextattempt!));
            };
            update();
            const interval = setInterval(update, 1000);
            return () => clearInterval(interval);
        }, [connStatus.reconnectnextattempt]);

        return (
            <div className={overlayShellClass} ref={overlayRefCallback}>
                <div className="flex items-center gap-3 w-full pt-2.5 pb-2.5 pr-2 pl-3">
                    <i className="fa-solid fa-clock text-grey-text text-base shrink-0" title="Waiting to retry"></i>
                    <div className="text-[11px] font-semibold leading-4 tracking-[0.11px] text-white min-w-0 flex-1 break-words @max-xxs:hidden">
                        {connStatus.reconnecterror && (
                            <div className="text-[10px] text-white/70 mb-0.5 truncate">
                                Last attempt failed: {connStatus.reconnecterror}
                            </div>
                        )}
                        <div>{countdown === "now" ? "Retrying now…" : `Retrying in ${countdown}`}</div>
                    </div>
                    <div className="flex-1 hidden @max-xxs:block"></div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {onStopAutoRetry && <StopAutoRetryButton onStop={onStopAutoRetry} compact />}
                        <Button
                            className="outlined grey text-[11px] py-[3px] px-[7px] @max-w350:text-[12px] @max-w350:py-[5px] @max-w350:px-[6px]"
                            onClick={onReconnectNow}
                            title="Reconnect now"
                        >
                            <span className="@max-w350:hidden!">Reconnect now</span>
                            <i className="fa-solid fa-rotate-right hidden! @max-w350:inline!"></i>
                        </Button>
                    </div>
                </div>
            </div>
        );
    }
);
CountdownOverlay.displayName = "CountdownOverlay";

/** UX-0.2: conn is up but durable job/session is not healthy. */
const JobSessionOverlay = React.memo(
    ({
        mode,
        overlayRefCallback,
        onRetrySession,
        onStartNewSession,
    }: {
        mode: "reconnecting" | "failed" | "gone";
        overlayRefCallback: (el: HTMLDivElement | null) => void;
        onRetrySession?: () => void;
        onStartNewSession?: () => void;
    }) => {
        let icon = "fa-solid fa-spinner fa-spin text-warning";
        let title = "Reconnecting session…";
        let detail: string | null = "SSH is connected; restoring the durable terminal session.";
        if (mode === "failed") {
            icon = "fa-solid fa-triangle-exclamation text-error";
            title = "Session reconnect failed";
            detail = "The host is connected, but the durable session could not be restored.";
        } else if (mode === "gone") {
            icon = "fa-solid fa-ghost text-error";
            title = "Remote session ended";
            detail =
                "The durable session is no longer running on the remote host (reboot or process exit). Start a new durable session to continue.";
        }

        return (
            <div className={overlayShellClass} ref={overlayRefCallback}>
                <div className="flex items-center gap-3 w-full pt-2.5 pb-2.5 pr-2 pl-3">
                    <i className={clsx(icon, "text-base shrink-0")} title={title}></i>
                    <div className="text-[11px] font-semibold leading-4 tracking-[0.11px] text-white min-w-0 flex-1 break-words @max-xxs:hidden">
                        <div>{title}</div>
                        {detail && <div className="text-[10px] text-white/70 mt-0.5">{detail}</div>}
                    </div>
                    <div className="flex-1 hidden @max-xxs:block"></div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {mode === "failed" && onRetrySession && (
                            <Button
                                className="outlined grey text-[11px] py-[3px] px-[7px]"
                                onClick={onRetrySession}
                                title="Retry session reconnect"
                            >
                                Retry
                            </Button>
                        )}
                        {mode === "gone" && onStartNewSession && (
                            <Button
                                className="outlined grey text-[11px] py-[3px] px-[7px]"
                                onClick={onStartNewSession}
                                title="Start new durable session"
                            >
                                <span className="@max-w350:hidden!">Start new durable session</span>
                                <i className="fa-solid fa-shield hidden! @max-w350:inline! text-sky-500"></i>
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        );
    }
);
JobSessionOverlay.displayName = "JobSessionOverlay";

/** How long job may stay "disconnected" after conn is up before showing "failed". */
const JOB_RECONNECT_GRACE_MS = 20_000;

export const ConnStatusOverlay = React.memo(
    ({
        nodeModel,
        viewModel,
        changeConnModalAtom,
    }: {
        nodeModel: NodeModel;
        viewModel: ViewModel;
        changeConnModalAtom: jotai.PrimitiveAtom<boolean>;
    }) => {
        const waveEnv = useWaveEnv<BlockEnv>();
        const connName = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "connection"));
        const [connModalOpen] = jotai.useAtom(changeConnModalAtom);
        const connStatus = jotai.useAtomValue(waveEnv.getConnStatusAtom(connName));
        const isLayoutMode = jotai.useAtomValue(waveEnv.atoms.controlShiftDelayAtom);
        const [overlayRefCallback, _, domRect] = useDimensionsWithCallbackRef(30);
        const width = domRect?.width;
        const [showError, setShowError] = React.useState(false);
        const wshConfigEnabled =
            jotai.useAtomValue(waveEnv.getConnConfigKeyAtom(connName, "conn:wshenabled")) ?? true;
        const [showWshError, setShowWshError] = React.useState(false);

        // UX-0.2 job-level status (durable session)
        const termDurableStatus = util.useAtomValueSafe(viewModel?.termDurableStatus);
        const termConfigedDurable = util.useAtomValueSafe(viewModel?.termConfigedDurable);
        const jobDisconnectedSinceRef = React.useRef<number | null>(null);
        const [jobOverlayMode, setJobOverlayMode] = React.useState<"reconnecting" | "failed" | "gone" | null>(null);

        React.useEffect(() => {
            if (width) {
                const hasError = !util.isBlank(connStatus.error);
                const showError = hasError && width >= 250 && connStatus.status == "error";
                setShowError(showError);
            }
        }, [width, connStatus, setShowError]);

        React.useEffect(() => {
            // Strict durable: null/undefined is not durable (avoids overlay on standard shells).
            const isDurable = termConfigedDurable === true;
            const connUp = connStatus?.status === "connected" && connStatus?.connhealthstatus !== "stalled";
            if (!isDurable || !connUp || !termDurableStatus) {
                jobDisconnectedSinceRef.current = null;
                setJobOverlayMode(null);
                return;
            }
            const status = termDurableStatus.status;
            const doneReason = termDurableStatus.donereason;
            if (status === "connected") {
                jobDisconnectedSinceRef.current = null;
                setJobOverlayMode(null);
                return;
            }
            if (status === "done" && doneReason === "gone") {
                jobDisconnectedSinceRef.current = null;
                setJobOverlayMode("gone");
                return;
            }
            // init: show reconnecting, never auto-promote to failed (slow start is normal).
            if (status === "init") {
                jobDisconnectedSinceRef.current = null;
                setJobOverlayMode("reconnecting");
                return;
            }
            // disconnected: grace timer, then failed + Retry.
            if (status === "disconnected") {
                if (jobDisconnectedSinceRef.current == null) {
                    jobDisconnectedSinceRef.current = Date.now();
                }
                const elapsed = Date.now() - jobDisconnectedSinceRef.current;
                if (elapsed >= JOB_RECONNECT_GRACE_MS) {
                    setJobOverlayMode("failed");
                } else {
                    setJobOverlayMode("reconnecting");
                }
                return;
            }
            jobDisconnectedSinceRef.current = null;
            setJobOverlayMode(null);
        }, [connStatus?.status, connStatus?.connhealthstatus, termDurableStatus, termConfigedDurable]);

        // Tick job grace period so reconnecting → failed transitions without new events.
        // Only promotes when grace timer was started for status === "disconnected"
        // (jobDisconnectedSinceRef is set); init never arms the timer.
        React.useEffect(() => {
            if (jobOverlayMode !== "reconnecting") {
                return;
            }
            const t = setInterval(() => {
                if (jobDisconnectedSinceRef.current == null) {
                    return;
                }
                if (Date.now() - jobDisconnectedSinceRef.current >= JOB_RECONNECT_GRACE_MS) {
                    setJobOverlayMode("failed");
                }
            }, 1000);
            return () => clearInterval(t);
        }, [jobOverlayMode]);

        const handleTryReconnect = React.useCallback(() => {
            const prtn = waveEnv.rpc.ConnConnectCommand(
                TabRpcClient,
                { host: connName, logblockid: nodeModel.blockId },
                { timeout: 60000 }
            );
            prtn.catch((e) => console.log("error reconnecting", connName, e));
        }, [connName, nodeModel.blockId, waveEnv]);

        const handleStopAutoRetry = React.useCallback(() => {
            const prtn = waveEnv.rpc.ConnStopAutoRetryCommand(TabRpcClient, connName, { timeout: 5000 });
            prtn.catch((e) => console.log("error stopping auto-retry", connName, e));
        }, [connName, waveEnv]);

        const handleRetrySession = React.useCallback(() => {
            const jobId = termDurableStatus?.jobid;
            if (!jobId) {
                // Fall back to full controller restart if no job id
                const vm = viewModel as TermViewModel;
                if (vm?.forceRestartController) {
                    util.fireAndForget(() => vm.forceRestartController());
                }
                return;
            }
            jobDisconnectedSinceRef.current = Date.now();
            setJobOverlayMode("reconnecting");
            const prtn = waveEnv.rpc.JobControllerReconnectJobCommand(TabRpcClient, jobId, { timeout: 30000 });
            prtn.catch((e) => {
                console.log("error reconnecting job", jobId, e);
                setJobOverlayMode("failed");
            });
        }, [termDurableStatus?.jobid, viewModel, waveEnv]);

        const handleStartNewSession = React.useCallback(() => {
            const vm = viewModel as TermViewModel;
            if (vm?.forceRestartController) {
                util.fireAndForget(() => vm.forceRestartController());
            }
        }, [viewModel]);

        const handleDisableWsh = React.useCallback(async () => {
            const metamaptype: unknown = {
                "conn:wshenabled": false,
            };
            const data: ConnConfigRequest = {
                host: connName,
                metamaptype: metamaptype,
            };
            try {
                await waveEnv.rpc.SetConnectionsConfigCommand(TabRpcClient, data);
            } catch (e) {
                console.log("problem setting connection config: ", e);
            }
        }, [connName, waveEnv]);

        const handleRemoveWshError = React.useCallback(async () => {
            try {
                await waveEnv.rpc.DismissWshFailCommand(TabRpcClient, connName);
            } catch (e) {
                console.log("unable to dismiss wsh error: ", e);
            }
        }, [connName, waveEnv]);

        let statusText = `Disconnected from "${connName}"`;
        let showReconnect = true;
        if (connStatus.status == "connecting") {
            statusText = `Connecting to "${connName}"...`;
            showReconnect = false;
        }
        if (connStatus.status == "connected") {
            showReconnect = false;
        }
        let reconDisplay = null;
        let reconClassName = "outlined grey";
        if (width && width < 350) {
            reconDisplay = <i className="fa-sharp fa-solid fa-rotate-right"></i>;
            reconClassName = clsx(reconClassName, "text-[12px] py-[5px] px-[6px]");
        } else {
            reconDisplay = "Reconnect";
            reconClassName = clsx(reconClassName, "text-[11px] py-[3px] px-[7px]");
        }
        const showIcon = connStatus.status != "connecting";

        React.useEffect(() => {
            const showWshErrorTemp =
                connStatus.status == "connected" &&
                connStatus.wsherror &&
                connStatus.wsherror != "" &&
                wshConfigEnabled;

            setShowWshError(showWshErrorTemp);
        }, [connStatus, wshConfigEnabled]);

        const handleCopy = React.useCallback(
            async (e: React.MouseEvent) => {
                const errTexts = [];
                if (showError) {
                    errTexts.push(`error: ${connStatus.error}`);
                }
                if (showWshError) {
                    errTexts.push(`unable to use wsh: ${connStatus.wsherror}`);
                }
                const textToCopy = errTexts.join("\n");
                await navigator.clipboard.writeText(textToCopy);
            },
            [showError, showWshError, connStatus.error, connStatus.wsherror]
        );

        const showStalled = connStatus.status == "connected" && connStatus.connhealthstatus == "stalled";
        // Only show retry/countdown overlays if auto-reconnect is possible
        // (password cached or no interactive auth required) and not suppressed
        const canAutoReconnect = connStatus.canautoreconnect && !connStatus.suppressautoreconnect;
        const showRetrying =
            canAutoReconnect && connStatus.status == "connecting" && (connStatus.reconnectattempt ?? 0) > 0;
        const showCountdown =
            canAutoReconnect && connStatus.status == "disconnected" && (connStatus.reconnectnextattempt ?? 0) > 0;
        // Disconnected-style overlay: plain disconnect, permanent host-key, or
        // suppress-on-error (password Cancel / Stop / permanent) so users see
        // "Auto-retry paused — click Reconnect" instead of a raw error shell.
        const showDisconnected =
            (connStatus.status == "disconnected" && !connStatus.connected) ||
            !!permanentErrorTitle(connStatus.errorcode) ||
            (!!connStatus.suppressautoreconnect &&
                (connStatus.status == "error" || connStatus.status == "disconnected"));

        // Hide status overlay when a password prompt is active for this connection
        // and not dismissed on this tab
        const activeUserInputPrompts = jotai.useAtomValue(modalsModel.activeUserInputPromptsAtom);
        const hasPasswordPrompt =
            connName &&
            connName in activeUserInputPrompts &&
            !modalsModel.isUserInputPromptDismissedForTab(connName, nodeModel.blockId);

        if (hasPasswordPrompt) {
            return null;
        }

        // UX-0.2: job-level overlay when conn is healthy but session is not
        if (jobOverlayMode && !showStalled && !showWshError) {
            return (
                <JobSessionOverlay
                    mode={jobOverlayMode}
                    overlayRefCallback={overlayRefCallback}
                    onRetrySession={handleRetrySession}
                    onStartNewSession={handleStartNewSession}
                />
            );
        }

        if (
            !showWshError &&
            !showStalled &&
            !showRetrying &&
            !showCountdown &&
            (isLayoutMode || connStatus.status == "connected" || connModalOpen)
        ) {
            return null;
        }

        if (showStalled && !showWshError) {
            return (
                <StalledOverlay connName={connName} connStatus={connStatus} overlayRefCallback={overlayRefCallback} />
            );
        }

        if (showRetrying) {
            return (
                <RetryingOverlay
                    connName={connName}
                    attempt={connStatus.reconnectattempt!}
                    overlayRefCallback={overlayRefCallback}
                    onStopAutoRetry={handleStopAutoRetry}
                />
            );
        }

        if (showCountdown) {
            return (
                <CountdownOverlay
                    connName={connName}
                    connStatus={connStatus}
                    overlayRefCallback={overlayRefCallback}
                    onReconnectNow={handleTryReconnect}
                    onStopAutoRetry={handleStopAutoRetry}
                />
            );
        }

        if (showDisconnected) {
            return (
                <DisconnectedOverlay
                    connName={connName}
                    connStatus={connStatus}
                    overlayRefCallback={overlayRefCallback}
                    onReconnect={handleTryReconnect}
                    onStopAutoRetry={canAutoReconnect || (connStatus.reconnectnextattempt ?? 0) > 0 ? handleStopAutoRetry : undefined}
                />
            );
        }

        return (
            <div className="connstatus-overlay" ref={overlayRefCallback}>
                <div className="connstatus-content">
                    <div className={clsx("connstatus-status-icon-wrapper", { "has-error": showError || showWshError })}>
                        {showIcon && <i className="fa-solid fa-triangle-exclamation"></i>}
                        <div className="connstatus-status ellipsis">
                            <div className="connstatus-status-text">{statusText}</div>
                            {(showError || showWshError) && (
                                <OverlayScrollbarsComponent
                                    className="connstatus-error"
                                    options={{ scrollbars: { autoHide: "leave" } }}
                                >
                                    <CopyButton className="copy-button" onClick={handleCopy} title="Copy" />
                                    {showError ? <div>error: {connStatus.error}</div> : null}
                                    {showWshError ? <div>unable to use wsh: {connStatus.wsherror}</div> : null}
                                </OverlayScrollbarsComponent>
                            )}
                            {showWshError && (
                                <Button className={reconClassName} onClick={handleDisableWsh}>
                                    always disable wsh
                                </Button>
                            )}
                        </div>
                    </div>
                    {showReconnect ? (
                        <div className="connstatus-actions">
                            <Button className={reconClassName} onClick={handleTryReconnect}>
                                {reconDisplay}
                            </Button>
                        </div>
                    ) : null}
                    {showWshError ? (
                        <div className="connstatus-actions">
                            <Button className={`fa-xmark fa-solid ${reconClassName}`} onClick={handleRemoveWshError} />
                        </div>
                    ) : null}
                </div>
            </div>
        );
    }
);
ConnStatusOverlay.displayName = "ConnStatusOverlay";
