// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
    frecencyScore,
    sortConnSuggestionItems,
    buildNewTabSuggestions,
    filterConnections,
    getNewConnectionSuggestionItem,
    getConnectionsEditItem,
} from "@/app/modals/conn-suggestions";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000; // fixed "now" for deterministic tests

function makeConnItem(connName: string, overrides?: Partial<SuggestionConnectionItem>): SuggestionConnectionItem {
    return {
        status: "connected",
        icon: "arrow-right-arrow-left",
        iconColor: "var(--grey-text-color)",
        value: connName,
        label: connName,
        ...overrides,
    };
}

function makeConnStatus(connectcount: number, lastconnecttime: number): ConnStatus {
    return {
        status: "connected",
        wshenabled: true,
        connection: "",
        connected: true,
        hasconnected: true,
        activeconnnum: 1,
        connectcount,
        lastconnecttime,
        canautoreconnect: true,
    };
}

function makeConfig(connections?: Record<string, Record<string, any>>): FullConfigType {
    return {
        connections: connections ?? {},
    } as unknown as FullConfigType;
}

// ─── frecencyScore ───────────────────────────────────────────────────────────

describe("frecencyScore", () => {
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns 0 when connectCount is 0", () => {
        expect(frecencyScore(0, NOW)).toBe(0);
    });

    it("returns connectCount when lastConnectTime is 0 (frequency after restart)", () => {
        // lastConnectTime is session-scoped; after restart it is 0 but connectCount persists
        expect(frecencyScore(5, 0)).toBe(5);
    });

    it("returns connectCount when age is 0 (just connected)", () => {
        expect(frecencyScore(5, NOW)).toBe(5);
    });

    it("decays with 14-day half-life (≈exp(-1) at 14 days)", () => {
        const fourteenDaysMs = 14 * 86400000;
        const score = frecencyScore(10, NOW - fourteenDaysMs);
        // exp(-1) ≈ 0.367879
        expect(score).toBeCloseTo(10 * Math.exp(-1), 5);
    });

    it("decays to near-zero after 140 days (10 half-lives)", () => {
        const hundredFortyDaysMs = 140 * 86400000;
        const score = frecencyScore(100, NOW - hundredFortyDaysMs);
        // exp(-10) ≈ 0.0000454, score ≈ 0.00454
        expect(score).toBeCloseTo(100 * Math.exp(-10), 5);
        expect(score).toBeLessThan(0.01);
    });

    it("never returns negative (clamps age to 0 for future dates)", () => {
        // lastConnectTime in the future should not produce negative score
        const score = frecencyScore(5, NOW + 86400000);
        expect(score).toBe(5); // age clamped to 0, exp(0) = 1
    });

    it("higher count with same recency scores higher", () => {
        expect(frecencyScore(20, NOW)).toBeGreaterThan(frecencyScore(10, NOW));
    });

    it("same count, more recent scores higher", () => {
        const recent = frecencyScore(10, NOW);
        const old = frecencyScore(10, NOW - 14 * 86400000);
        expect(recent).toBeGreaterThan(old);
    });
});

// ─── sortConnSuggestionItems ─────────────────────────────────────────────────

describe("sortConnSuggestionItems", () => {
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("sorts by descending frecency score", () => {
        const items = [
            makeConnItem("old-high-count"), // count 10, 28 days ago
            makeConnItem("recent-low-count"), // count 2, now
            makeConnItem("recent-high-count"), // count 10, now
        ];
        const connStatusMap = new Map<string, ConnStatus>([
            ["old-high-count", makeConnStatus(10, NOW - 28 * 86400000)], // score ≈ 10*exp(-2) ≈ 1.353
            ["recent-low-count", makeConnStatus(2, NOW)], // score = 2
            ["recent-high-count", makeConnStatus(10, NOW)], // score = 10
        ]);
        const result = sortConnSuggestionItems(items, makeConfig(), connStatusMap);
        expect(result[0].value).toBe("recent-high-count"); // score 10
        expect(result[1].value).toBe("recent-low-count"); // score 2
        expect(result[2].value).toBe("old-high-count"); // score ≈ 1.353
    });

    it("tie-breaks by ascending display:order when scores are equal", () => {
        const items = [makeConnItem("conn-b"), makeConnItem("conn-a"), makeConnItem("conn-c")];
        const connStatusMap = new Map<string, ConnStatus>([
            ["conn-a", makeConnStatus(5, NOW)],
            ["conn-b", makeConnStatus(5, NOW)],
            ["conn-c", makeConnStatus(5, NOW)],
        ]);
        const config = makeConfig({
            "conn-a": { "display:order": 2 },
            "conn-b": { "display:order": 1 },
            "conn-c": { "display:order": 3 },
        });
        const result = sortConnSuggestionItems(items, config, connStatusMap);
        // All same score → tie-break by display:order ascending: conn-b(1), conn-a(2), conn-c(3)
        expect(result[0].value).toBe("conn-b");
        expect(result[1].value).toBe("conn-a");
        expect(result[2].value).toBe("conn-c");
    });

    it("final tie-break is ascending name (localeCompare) when score and order are equal", () => {
        const items = [makeConnItem("charlie"), makeConnItem("alpha"), makeConnItem("bravo")];
        const connStatusMap = new Map<string, ConnStatus>([
            ["alpha", makeConnStatus(5, NOW)],
            ["bravo", makeConnStatus(5, NOW)],
            ["charlie", makeConnStatus(5, NOW)],
        ]);
        const result = sortConnSuggestionItems(items, makeConfig(), connStatusMap);
        expect(result[0].value).toBe("alpha");
        expect(result[1].value).toBe("bravo");
        expect(result[2].value).toBe("charlie");
    });

    it("items with zero score (never connected) sort to the bottom", () => {
        const items = [makeConnItem("never-used"), makeConnItem("used-once")];
        const connStatusMap = new Map<string, ConnStatus>([
            ["never-used", makeConnStatus(0, 0)], // score 0
            ["used-once", makeConnStatus(1, NOW)], // score 1
        ]);
        const result = sortConnSuggestionItems(items, makeConfig(), connStatusMap);
        expect(result[0].value).toBe("used-once");
        expect(result[1].value).toBe("never-used");
    });

    it("does not mutate the input array", () => {
        const items = [makeConnItem("a"), makeConnItem("b")];
        const connStatusMap = new Map<string, ConnStatus>([
            ["a", makeConnStatus(1, NOW)],
            ["b", makeConnStatus(5, NOW)],
        ]);
        const original = [...items];
        sortConnSuggestionItems(items, makeConfig(), connStatusMap);
        // Input order unchanged
        expect(items[0].value).toBe(original[0].value);
        expect(items[1].value).toBe(original[1].value);
    });
});

// ─── filterConnections ───────────────────────────────────────────────────────

describe("filterConnections", () => {
    it("filters case-insensitively", () => {
        const config = makeConfig({
            "user@Host1": {},
            "user@HOST2": {},
            "user@lower": {},
        });
        const result = filterConnections(["user@Host1", "user@HOST2", "user@lower"], "host", config, false);
        expect(result).toEqual(["user@Host1", "user@HOST2"]);
    });

    it("excludes hidden connections", () => {
        const config = makeConfig({
            "hidden-conn": { "display:hidden": true },
            "visible-conn": {},
        });
        const result = filterConnections(["hidden-conn", "visible-conn"], "", config, false);
        expect(result).toEqual(["visible-conn"]);
    });

    it("empty filter matches all non-hidden connections", () => {
        const config = makeConfig({
            "conn-a": {},
            "conn-b": {},
        });
        const result = filterConnections(["conn-a", "conn-b"], "", config, false);
        expect(result).toEqual(["conn-a", "conn-b"]);
    });
});

// ─── getNewConnectionSuggestionItem ──────────────────────────────────────────

describe("getNewConnectionSuggestionItem", () => {
    const onCreate = (_: string) => {};
    const onEdit = () => {};

    it("returns null when filterText is empty (matches local name)", () => {
        const result = getNewConnectionSuggestionItem("", "local", [], [], onCreate);
        expect(result).toBeNull();
    });

    it("returns null when filterText matches an existing remote connection", () => {
        const result = getNewConnectionSuggestionItem("user@host", "local", ["user@host"], [], onCreate);
        expect(result).toBeNull();
    });

    it("returns null when filterText matches a wsl connection (bare name)", () => {
        // wslConns stores bare names ("ubuntu"), not prefixed ("wsl://ubuntu")
        const result = getNewConnectionSuggestionItem("ubuntu", "local", [], ["ubuntu"], onCreate);
        expect(result).toBeNull();
    });

    it("returns a suggestion when filterText does not match any existing connection", () => {
        const result = getNewConnectionSuggestionItem("newhost", "local", ["user@existing"], ["ubuntu"], onCreate);
        expect(result).not.toBeNull();
        expect(result!.label).toBe("newhost (New Connection)");
        expect(result!.value).toBe("");
    });

    it("returns a suggestion when filterText matches local name but is not empty", () => {
        // filterText "local" is in allCons (localName), so returns null
        const result = getNewConnectionSuggestionItem("local", "local", [], [], onCreate);
        expect(result).toBeNull();
    });
});

// ─── getConnectionsEditItem ──────────────────────────────────────────────────

describe("getConnectionsEditItem", () => {
    it("returns an edit item when filterText is empty", () => {
        const result = getConnectionsEditItem("", () => {});
        expect(result).not.toBeNull();
        expect(result!.label).toBe("Edit Connections");
    });

    it("returns null when filterText is non-empty", () => {
        const result = getConnectionsEditItem("host", () => {});
        expect(result).toBeNull();
    });
});

// ─── buildNewTabSuggestions ──────────────────────────────────────────────────

describe("buildNewTabSuggestions", () => {
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const opts = {
        localName: "local",
        onCreate: (_: string) => {},
        onEditConnections: () => {},
    };

    it("includes Local and Remote sections + Edit Connections when filter is empty", () => {
        const connList = ["user@remote1"];
        const wslList: string[] = [];
        const connStatusMap = new Map<string, ConnStatus>([
            ["user@remote1", makeConnStatus(1, NOW)],
        ]);
        const result = buildNewTabSuggestions(connList, wslList, "", makeConfig(), connStatusMap, opts);

        // Local section (contains the "local" item)
        const localSection = result.suggestions.find((s) => "headerText" in s && s.headerText === "Local");
        expect(localSection).toBeDefined();

        // Remote section
        const remoteSection = result.suggestions.find((s) => "headerText" in s && s.headerText === "Remote");
        expect(remoteSection).toBeDefined();

        // Edit Connections item (filter is empty)
        const editItem = result.suggestions.find(
            (s) => !("items" in s) && (s as SuggestionConnectionItem).label === "Edit Connections"
        );
        expect(editItem).toBeDefined();

        // No New Connection (totalRealItems > 0)
        const newConnItem = result.suggestions.find(
            (s) => !("items" in s) && (s as SuggestionConnectionItem).label?.includes("(New Connection)")
        );
        expect(newConnItem).toBeUndefined();
        expect(result.newConnectionIndex).toBeNull();
    });

    it("shows only New Connection when filter matches nothing", () => {
        const connList = ["user@existing"];
        const wslList: string[] = [];
        const connStatusMap = new Map<string, ConnStatus>([
            ["user@existing", makeConnStatus(1, NOW)],
        ]);
        const result = buildNewTabSuggestions(connList, wslList, "zzz-no-match", makeConfig(), connStatusMap, opts);

        // No sections with items
        const localSection = result.suggestions.find((s) => "headerText" in s && s.headerText === "Local");
        expect(localSection).toBeUndefined();
        const remoteSection = result.suggestions.find((s) => "headerText" in s && s.headerText === "Remote");
        expect(remoteSection).toBeUndefined();

        // No Edit Connections (filter is non-empty)
        const editItem = result.suggestions.find(
            (s) => !("items" in s) && (s as SuggestionConnectionItem).label === "Edit Connections"
        );
        expect(editItem).toBeUndefined();

        // New Connection is shown
        expect(result.suggestions.length).toBe(1);
        const newConn = result.suggestions[0] as SuggestionConnectionItem;
        expect(newConn.label).toBe("zzz-no-match (New Connection)");
        expect(result.newConnectionIndex).toBe(0);
    });

    it("does not show New Connection when filter matches existing connections", () => {
        const connList = ["user@host"];
        const wslList: string[] = [];
        const connStatusMap = new Map<string, ConnStatus>([
            ["user@host", makeConnStatus(1, NOW)],
        ]);
        const result = buildNewTabSuggestions(connList, wslList, "host", makeConfig(), connStatusMap, opts);

        // Remote section with matching connection
        const remoteSection = result.suggestions.find(
            (s) => "headerText" in s && s.headerText === "Remote"
        ) as SuggestionConnectionScope | undefined;
        expect(remoteSection).toBeDefined();
        expect(remoteSection!.items.length).toBe(1);
        expect(remoteSection!.items[0].value).toBe("user@host");

        // No New Connection
        expect(result.newConnectionIndex).toBeNull();
    });

    it("does not show New Connection when filter matches local name", () => {
        const connList: string[] = [];
        const wslList: string[] = [];
        const connStatusMap = new Map<string, ConnStatus>();
        const result = buildNewTabSuggestions(connList, wslList, "local", makeConfig(), connStatusMap, opts);

        // Local section with the local item
        const localSection = result.suggestions.find(
            (s) => "headerText" in s && s.headerText === "Local"
        ) as SuggestionConnectionScope | undefined;
        expect(localSection).toBeDefined();
        expect(localSection!.items.length).toBe(1);

        // No New Connection (local matches, totalRealItems > 0)
        expect(result.newConnectionIndex).toBeNull();
    });

    it("sorts remote connections by frecency within the Remote section", () => {
        const connList = ["old-freq", "recent-freq", "never-used"];
        const wslList: string[] = [];
        const connStatusMap = new Map<string, ConnStatus>([
            ["old-freq", makeConnStatus(10, NOW - 28 * 86400000)], // score ≈ 1.353
            ["recent-freq", makeConnStatus(10, NOW)], // score = 10
            ["never-used", makeConnStatus(0, 0)], // score = 0
        ]);
        const result = buildNewTabSuggestions(connList, wslList, "", makeConfig(), connStatusMap, opts);

        const remoteSection = result.suggestions.find(
            (s) => "headerText" in s && s.headerText === "Remote"
        ) as SuggestionConnectionScope;
        expect(remoteSection.items[0].value).toBe("recent-freq"); // highest score
        expect(remoteSection.items[1].value).toBe("old-freq"); // middle
        expect(remoteSection.items[2].value).toBe("never-used"); // zero score
    });

    it("selectionList is the flattened version of suggestions", () => {
        const connList = ["user@a", "user@b"];
        const wslList: string[] = [];
        const connStatusMap = new Map<string, ConnStatus>([
            ["user@a", makeConnStatus(1, NOW)],
            ["user@b", makeConnStatus(2, NOW)],
        ]);
        const result = buildNewTabSuggestions(connList, wslList, "", makeConfig(), connStatusMap, opts);

        // suggestions: [Local section (1 item: local), Remote section (2 items: user@b, user@a), Edit Connections]
        // selectionList: [local, user@b, user@a, Edit Connections]
        expect(result.selectionList.length).toBe(4);
        expect(result.selectionList[0].label).toBe("local");
        expect(result.selectionList[1].value).toBe("user@b"); // higher frecency
        expect(result.selectionList[2].value).toBe("user@a");
        expect(result.selectionList[3].label).toBe("Edit Connections");
    });

    it("newConnectionIndex points to the New Connection item in selectionList", () => {
        const connList: string[] = [];
        const wslList: string[] = [];
        const connStatusMap = new Map<string, ConnStatus>();
        const result = buildNewTabSuggestions(connList, wslList, "newhost", makeConfig(), connStatusMap, opts);

        expect(result.newConnectionIndex).toBe(0);
        expect(result.selectionList[result.newConnectionIndex!].label).toBe("newhost (New Connection)");
    });

    it("includes wsl connections in the Local section", () => {
        const connList: string[] = [];
        const wslList = ["ubuntu", "debian"];
        const connStatusMap = new Map<string, ConnStatus>([
            ["wsl://ubuntu", makeConnStatus(3, NOW)],
            ["wsl://debian", makeConnStatus(1, NOW)],
        ]);
        const result = buildNewTabSuggestions(connList, wslList, "", makeConfig(), connStatusMap, opts);

        const localSection = result.suggestions.find(
            (s) => "headerText" in s && s.headerText === "Local"
        ) as SuggestionConnectionScope;
        // local item + 2 wsl items
        expect(localSection.items.length).toBe(3);
        // wsl items sorted by frecency: ubuntu (3) first, debian (1) second, local (0) last
        expect(localSection.items[0].value).toBe("wsl://ubuntu");
        expect(localSection.items[1].value).toBe("wsl://debian");
        expect(localSection.items[2].label).toBe("local"); // local has score 0
    });

    it("returns empty suggestions when filter matches nothing and filterText is empty-like but not empty", () => {
        // Edge case: filter "xyz" with no connections and no local match
        // localName is "local", filter "xyz" doesn't match "local"
        const result = buildNewTabSuggestions([], [], "xyz", makeConfig(), new Map(), opts);
        expect(result.suggestions.length).toBe(1); // New Connection only
        expect(result.newConnectionIndex).toBe(0);
    });
});