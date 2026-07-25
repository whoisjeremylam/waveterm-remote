// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { TypeAheadModal } from "@/app/modals/typeaheadmodal";
import {
    filterConnections,
    sortConnSuggestionItems,
    createRemoteSuggestionItems,
    createWslSuggestionItems,
    createFilteredLocalSuggestionItem,
} from "@/app/modals/conn-suggestions";
import { ConnectionsModel } from "@/app/store/connections-model";
import {
    atoms,
    getConnStatusAtom,
    getLocalHostDisplayNameAtom,
    globalStore,
    WOS,
} from "@/app/store/global";
import { globalRefocusWithTimeout } from "@/app/store/keymodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { NodeModel } from "@/layout/index";
import * as keyutil from "@/util/keyutil";
import * as util from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";

// ─── Block-specific helpers ──────────────────────────────────────────────────

function getReconnectItem(
    connStatus: ConnStatus,
    blockId: string,
    changeConnModalAtom: jotai.PrimitiveAtom<boolean>
): SuggestionConnectionItem | null {
    if (connStatus.status != "disconnected" && connStatus.status != "error") {
        return null;
    }
    // Only offer reconnect when the block already has a remote connection set.
    if (util.isBlank(connStatus.connection) || util.isLocalConnName(connStatus.connection)) {
        return null;
    }
    const reconnectSuggestionItem: SuggestionConnectionItem = {
        status: "connected",
        icon: "arrow-right-arrow-left",
        iconColor: "var(--grey-text-color)",
        label: `Reconnect to ${connStatus.connection}`,
        value: "",
        onSelect: async (_: string) => {
            globalStore.set(changeConnModalAtom, false);
            const prtn = RpcApi.ConnConnectCommand(
                TabRpcClient,
                { host: connStatus.connection, logblockid: blockId },
                { timeout: 60000 }
            );
            prtn.catch((e) => console.log("error reconnecting", connStatus.connection, e));
        },
    };
    return reconnectSuggestionItem;
}

function getLocalSuggestions(
    localName: string,
    wslList: Array<string>,
    connection: string,
    connStatusMap: Map<string, ConnStatus>,
    fullConfig: FullConfigType,
    filterOutNowsh: boolean,
    hasGitBash: boolean
): SuggestionConnectionScope | null {
    // Empty filter → full list (connection switcher, no typeahead).
    const wslFiltered = filterConnections(wslList, "", fullConfig, filterOutNowsh);
    const wslSuggestionItems = createWslSuggestionItems(wslFiltered, connection, connStatusMap);
    const localSuggestionItem = createFilteredLocalSuggestionItem(localName, connection, "");

    const gitBashItems: Array<SuggestionConnectionItem> = [];
    if (hasGitBash) {
        gitBashItems.push({
            status: "connected",
            icon: "laptop",
            iconColor: "var(--grey-text-color)",
            value: "local:gitbash",
            label: "Git Bash",
            current: connection === "local:gitbash",
        });
    }

    const combinedSuggestionItems = [...localSuggestionItem, ...gitBashItems, ...wslSuggestionItems];
    const sortedSuggestionItems = sortConnSuggestionItems(combinedSuggestionItems, fullConfig, connStatusMap);
    if (sortedSuggestionItems.length == 0) {
        return null;
    }
    const localSuggestions: SuggestionConnectionScope = {
        headerText: "Local",
        items: sortedSuggestionItems,
    };
    return localSuggestions;
}

function getRemoteSuggestions(
    connList: Array<string>,
    connection: string,
    connStatusMap: Map<string, ConnStatus>,
    fullConfig: FullConfigType,
    filterOutNowsh: boolean
): SuggestionConnectionScope | null {
    // Empty filter → full list ordered by frecency (same as new-tab dropdown).
    const filtered = filterConnections(connList, "", fullConfig, filterOutNowsh);
    const suggestionItems = createRemoteSuggestionItems(filtered, connection, connStatusMap);
    const sortedSuggestionItems = sortConnSuggestionItems(suggestionItems, fullConfig, connStatusMap);
    if (sortedSuggestionItems.length == 0) {
        return null;
    }
    const remoteSuggestions: SuggestionConnectionScope = {
        headerText: "Remote",
        items: sortedSuggestionItems,
    };
    return remoteSuggestions;
}

// ─── Block-header modal (connection switcher — no type filter) ───────────────

const ChangeConnectionBlockModal = React.memo(
    ({
        blockId,
        viewModel,
        blockRef,
        connBtnRef,
        changeConnModalAtom,
        nodeModel: _nodeModel,
    }: {
        blockId: string;
        viewModel: ViewModel;
        blockRef: React.RefObject<HTMLDivElement>;
        connBtnRef: React.RefObject<HTMLDivElement>;
        changeConnModalAtom: jotai.PrimitiveAtom<boolean>;
        nodeModel: NodeModel;
    }) => {
        const changeConnModalOpen = jotai.useAtomValue(changeConnModalAtom);
        const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
        const connection = blockData?.meta?.connection;
        const connStatusAtom = getConnStatusAtom(connection);
        const connStatus = jotai.useAtomValue(connStatusAtom);
        const [connList, setConnList] = React.useState<Array<string>>([]);
        const [wslList, setWslList] = React.useState<Array<string>>([]);
        const allConnStatus = jotai.useAtomValue(atoms.allConnStatus);
        const [rowIndex, setRowIndex] = React.useState(0);
        const connStatusMap = new Map<string, ConnStatus>();
        const fullConfig = jotai.useAtomValue(atoms.fullConfigAtom);
        let filterOutNowsh = util.useAtomValueSafe(viewModel.filterOutNowsh) ?? true;
        const hasGitBash = jotai.useAtomValue(ConnectionsModel.getInstance().hasGitBashAtom);
        const localName = jotai.useAtomValue(getLocalHostDisplayNameAtom());

        for (const conn of allConnStatus) {
            connStatusMap.set(conn.connection, conn);
        }
        React.useEffect(() => {
            if (!changeConnModalOpen) {
                setConnList([]);
                return;
            }
            const prtn = RpcApi.ConnListCommand(TabRpcClient, { timeout: 2000 });
            prtn.then((newConnList) => {
                setConnList(newConnList ?? []);
            }).catch((e) => console.log("unable to load conn list from backend. using blank list: ", e));
            const p2rtn = RpcApi.WslListCommand(TabRpcClient, { timeout: 2000 });
            p2rtn
                .then((newWslList) => {
                    setWslList(newWslList ?? []);
                })
                .catch((_e) => {
                    // WSL not available on non-Windows — fail silently
                });
        }, [changeConnModalOpen]);

        // Reset highlight when the modal opens.
        React.useEffect(() => {
            if (changeConnModalOpen) {
                setRowIndex(0);
            }
        }, [changeConnModalOpen]);

        const changeConnection = React.useCallback(
            async (connName: string) => {
                if (connName == "") {
                    connName = null;
                }
                if (connName == blockData?.meta?.connection) {
                    return;
                }
                const oldFile = blockData?.meta?.file ?? "";
                const newFile = oldFile == "" ? "" : "~";
                await RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", blockId),
                    meta: { connection: connName, file: newFile, "cmd:cwd": null },
                });

                try {
                    await RpcApi.ConnEnsureCommand(
                        TabRpcClient,
                        { connname: connName, logblockid: blockId },
                        { timeout: 60000 }
                    );
                } catch (e) {
                    console.log("error connecting", blockId, connName, e);
                }
            },
            [blockId, blockData]
        );

        const reconnectSuggestionItem = getReconnectItem(connStatus, blockId, changeConnModalAtom);
        const localSuggestions = getLocalSuggestions(
            localName,
            wslList,
            connection,
            connStatusMap,
            fullConfig,
            filterOutNowsh,
            hasGitBash
        );
        const remoteSuggestions = getRemoteSuggestions(
            connList,
            connection,
            connStatusMap,
            fullConfig,
            filterOutNowsh
        );

        const suggestions: Array<SuggestionsType> = [
            ...(reconnectSuggestionItem ? [reconnectSuggestionItem] : []),
            ...(localSuggestions ? [localSuggestions] : []),
            ...(remoteSuggestions ? [remoteSuggestions] : []),
        ];

        let selectionList: Array<SuggestionConnectionItem> = suggestions.flatMap((item) => {
            if ("items" in item) {
                return item.items;
            }
            return item;
        });

        // quick way to change icon color when highlighted
        selectionList = selectionList.map((item, index) => {
            if (index == rowIndex && item.iconColor == "var(--grey-text-color)") {
                item.iconColor = "var(--main-text-color)";
            }
            return item;
        });

        const handleSwitcherKeyDown = React.useCallback(
            (waveEvent: WaveKeyboardEvent): boolean => {
                if (keyutil.checkKeyPressed(waveEvent, "Enter")) {
                    const rowItem = selectionList[rowIndex];
                    if (!rowItem) {
                        return true;
                    }
                    if ("onSelect" in rowItem && rowItem.onSelect) {
                        rowItem.onSelect(rowItem.value);
                    } else {
                        changeConnection(rowItem.value);
                        globalStore.set(changeConnModalAtom, false);
                        globalRefocusWithTimeout(10);
                    }
                    setRowIndex(0);
                    return true;
                }
                if (keyutil.checkKeyPressed(waveEvent, "Escape")) {
                    globalStore.set(changeConnModalAtom, false);
                    globalRefocusWithTimeout(10);
                    return true;
                }
                if (keyutil.checkKeyPressed(waveEvent, "ArrowUp")) {
                    setRowIndex((idx) => Math.max(idx - 1, 0));
                    return true;
                }
                if (keyutil.checkKeyPressed(waveEvent, "ArrowDown")) {
                    setRowIndex((idx) => Math.min(idx + 1, Math.max(selectionList.length - 1, 0)));
                    return true;
                }
                // Swallow printable keys so they don't reach the terminal while the switcher is open.
                if (keyutil.isCharacterKeyEvent(waveEvent)) {
                    return true;
                }
                return false;
            },
            [changeConnModalAtom, blockId, selectionList, rowIndex, changeConnection]
        );
        React.useEffect(() => {
            setRowIndex((idx) => {
                if (selectionList.length === 0) {
                    return 0;
                }
                return Math.min(idx, selectionList.length - 1);
            });
        }, [selectionList.length, setRowIndex]);
        // this check was also moved to BlockFrame to prevent all the above code from running unnecessarily
        if (!changeConnModalOpen) {
            return null;
        }
        return (
            <TypeAheadModal
                blockRef={blockRef}
                anchorRef={connBtnRef}
                suggestions={suggestions}
                onSelect={(selected: string) => {
                    changeConnection(selected);
                    globalStore.set(changeConnModalAtom, false);
                    globalRefocusWithTimeout(10);
                }}
                selectIndex={rowIndex}
                autoFocus
                showFilter={false}
                onKeyDown={(e) => keyutil.keydownWrapper(handleSwitcherKeyDown)(e)}
                onClickBackdrop={() => globalStore.set(changeConnModalAtom, false)}
            />
        );
    }
);

export { ChangeConnectionBlockModal };
