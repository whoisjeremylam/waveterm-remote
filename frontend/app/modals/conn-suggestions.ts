// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { computeConnColorNum } from "@/app/block/blockutil";
import * as util from "@/util/util";

// ─── Filter ──────────────────────────────────────────────────────────────────

export function filterConnections(
    connList: Array<string>,
    filterText: string,
    fullConfig: FullConfigType,
    filterOutNowsh: boolean
): Array<string> {
    const connectionsConfig = fullConfig.connections;
    const lowerFilter = filterText.toLowerCase();
    return connList.filter((conn) => {
        const hidden = connectionsConfig?.[conn]?.["display:hidden"] ?? false;
        const wshEnabled = connectionsConfig?.[conn]?.["conn:wshenabled"] ?? true;
        return conn.toLowerCase().includes(lowerFilter) && !hidden && (wshEnabled || !filterOutNowsh);
    });
}

// ─── Frecency sort ───────────────────────────────────────────────────────────

export function frecencyScore(
    connectCount: number,
    lastConnectTime: number
): number {
    if (connectCount <= 0) {
        return 0;
    }
    // lastConnectTime is session-scoped (not persisted). After restart it is 0
    // until the first successful SSH connect this session — still rank by
    // persisted connectCount so frequency survives restarts.
    if (lastConnectTime <= 0) {
        return connectCount;
    }
    const ageDays = Math.max(0, (Date.now() - lastConnectTime) / 86400000);
    return connectCount * Math.exp(-ageDays / 14);
}

export function sortConnSuggestionItems(
    items: Array<SuggestionConnectionItem>,
    fullConfig: FullConfigType,
    connStatusMap: Map<string, ConnStatus>
): Array<SuggestionConnectionItem> {
    const connectionsConfig = fullConfig.connections;
    // Return a NEW array — do not mutate input
    return [...items].sort((itemA: SuggestionConnectionItem, itemB: SuggestionConnectionItem) => {
        const connNameA = itemA.value;
        const connNameB = itemB.value;

        // Compute frecency scores
        const statusA = connStatusMap.get(connNameA);
        const statusB = connStatusMap.get(connNameB);
        const scoreA = frecencyScore(
            statusA?.connectcount ?? 0,
            statusA?.lastconnecttime ?? 0
        );
        const scoreB = frecencyScore(
            statusB?.connectcount ?? 0,
            statusB?.lastconnecttime ?? 0
        );

        // Descending by score
        if (scoreB !== scoreA) {
            return scoreB - scoreA;
        }

        // Tie-break: ascending display:order (default 0)
        const orderA = connectionsConfig?.[connNameA]?.["display:order"] ?? 0;
        const orderB = connectionsConfig?.[connNameB]?.["display:order"] ?? 0;
        if (orderA !== orderB) {
            return orderA - orderB;
        }

        // Final tie-break: ascending name (locale-aware)
        return connNameA.localeCompare(connNameB);
    });
}

// ─── Item creators ───────────────────────────────────────────────────────────

export function createRemoteSuggestionItems(
    filteredList: Array<string>,
    connection: string,
    connStatusMap: Map<string, ConnStatus>
): Array<SuggestionConnectionItem> {
    return filteredList.map((connName) => {
        const connStatus = connStatusMap.get(connName);
        const connColorNum = computeConnColorNum(connStatus);
        const item: SuggestionConnectionItem = {
            status: "connected",
            icon: "arrow-right-arrow-left",
            iconColor:
                connStatus?.status == "connected"
                    ? `var(--conn-icon-color-${connColorNum})`
                    : "var(--grey-text-color)",
            value: connName,
            label: connName,
            current: connName == connection,
        };
        return item;
    });
}

export function createWslSuggestionItems(
    filteredList: Array<string>,
    connection: string,
    connStatusMap: Map<string, ConnStatus>
): Array<SuggestionConnectionItem> {
    return filteredList.map((connName) => {
        const connStatus = connStatusMap.get(`wsl://${connName}`);
        const connColorNum = computeConnColorNum(connStatus);
        const item: SuggestionConnectionItem = {
            status: "connected",
            icon: "arrow-right-arrow-left",
            iconColor:
                connStatus?.status == "connected"
                    ? `var(--conn-icon-color-${connColorNum})`
                    : "var(--grey-text-color)",
            value: "wsl://" + connName,
            label: "wsl://" + connName,
            current: "wsl://" + connName == connection,
        };
        return item;
    });
}

export function createFilteredLocalSuggestionItem(
    localName: string,
    connection: string,
    filterText: string
): Array<SuggestionConnectionItem> {
    if (localName.toLowerCase().includes(filterText.toLowerCase())) {
        const localSuggestion: SuggestionConnectionItem = {
            status: "connected",
            icon: "laptop",
            iconColor: "var(--grey-text-color)",
            value: "",
            label: localName,
            current: util.isBlank(connection),
        };
        return [localSuggestion];
    }
    return [];
}

// ─── Edit Connections ────────────────────────────────────────────────────────

export function getConnectionsEditItem(
    filterText: string,
    onEditConnections: () => void
): SuggestionConnectionItem | null {
    if (filterText != "") {
        return null;
    }
    const connectionsEditItem: SuggestionConnectionItem = {
        status: "disconnected",
        icon: "gear",
        iconColor: "var(--grey-text-color)",
        value: "Edit Connections",
        label: "Edit Connections",
        onSelect: () => {
            onEditConnections();
        },
    };
    return connectionsEditItem;
}

// ─── New Connection ──────────────────────────────────────────────────────────

export function getNewConnectionSuggestionItem(
    filterText: string,
    localName: string,
    remoteConns: Array<string>,
    wslConns: Array<string>,
    onCreate: (connName: string) => void
): SuggestionConnectionItem | null {
    const allCons = ["", localName, ...remoteConns, ...wslConns];
    if (allCons.includes(filterText)) {
        // do not offer to create a new connection if one
        // with the exact name already exists
        return null;
    }
    const newConnectionSuggestion: SuggestionConnectionItem = {
        status: "connected",
        icon: "plus",
        iconColor: "var(--grey-text-color)",
        label: `${filterText} (New Connection)`,
        value: "",
        onSelect: () => {
            onCreate(filterText);
        },
    };
    return newConnectionSuggestion;
}

// ─── Build new-tab suggestions ──────────────────────────────────────────────

export interface NewTabSuggestionBuildOpts {
    localName: string;
    onCreate: (connName: string) => void;
    onEditConnections: () => void;
}

export interface NewTabSuggestionsResult {
    suggestions: SuggestionsType[];
    selectionList: SuggestionConnectionItem[];
    newConnectionIndex: number | null;
}

export function buildNewTabSuggestions(
    connList: Array<string>,
    wslList: Array<string>,
    filterText: string,
    fullConfig: FullConfigType,
    connStatusMap: Map<string, ConnStatus>,
    opts: NewTabSuggestionBuildOpts
): NewTabSuggestionsResult {
    const { localName, onCreate, onEditConnections } = opts;
    const connection = ""; // new-tab has no current connection

    // Local section (local + wsl)
    const wslFiltered = filterConnections(wslList, filterText, fullConfig, false);
    const wslItems = createWslSuggestionItems(wslFiltered, connection, connStatusMap);
    const localItem = createFilteredLocalSuggestionItem(localName, connection, filterText);
    const localItems = [...localItem, ...wslItems];
    const sortedLocalItems = sortConnSuggestionItems(localItems, fullConfig, connStatusMap);

    // Remote section
    const remoteFiltered = filterConnections(connList, filterText, fullConfig, false);
    const remoteItems = createRemoteSuggestionItems(remoteFiltered, connection, connStatusMap);
    const sortedRemoteItems = sortConnSuggestionItems(remoteItems, fullConfig, connStatusMap);

    const suggestions: SuggestionsType[] = [];

    // Local section
    if (sortedLocalItems.length > 0) {
        suggestions.push({
            headerText: "Local",
            items: sortedLocalItems,
        });
    }

    // Remote section
    if (sortedRemoteItems.length > 0) {
        suggestions.push({
            headerText: "Remote",
            items: sortedRemoteItems,
        });
    }

    // Edit Connections item
    const editItem = getConnectionsEditItem(filterText, onEditConnections);
    if (editItem) {
        suggestions.push(editItem);
    }

    // New Connection item (only when no real matches)
    const totalRealItems = sortedLocalItems.length + sortedRemoteItems.length + (editItem ? 1 : 0);
    const newConnItem = getNewConnectionSuggestionItem(
        filterText,
        localName,
        connList,
        wslList,
        onCreate
    );
    if (newConnItem && totalRealItems === 0) {
        suggestions.push(newConnItem);
    }

    // Flatten selection list
    const selectionList: SuggestionConnectionItem[] = suggestions.flatMap((item) => {
        if ("items" in item) {
            return item.items;
        }
        return item;
    });

    // Find the index of the New Connection item in selectionList
    let newConnectionIndex: number | null = null;
    if (newConnItem) {
        const idx = selectionList.findIndex(
            (item) => item.label === newConnItem.label
        );
        if (idx >= 0) {
            newConnectionIndex = idx;
        }
    }

    return {
        suggestions,
        selectionList,
        newConnectionIndex,
    };
}
