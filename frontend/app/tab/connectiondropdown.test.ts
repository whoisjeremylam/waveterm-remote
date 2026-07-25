// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { clampNewTabRowIndex, connectionNamesFromConfig } from "./connectiondropdown";

describe("connectionNamesFromConfig", () => {
    it("returns empty for null/undefined config", () => {
        expect(connectionNamesFromConfig(null)).toEqual([]);
        expect(connectionNamesFromConfig(undefined)).toEqual([]);
        expect(connectionNamesFromConfig({} as FullConfigType)).toEqual([]);
    });

    it("returns remote connection keys and excludes wsl/local", () => {
        const config = {
            connections: {
                "user@host1": { "conn:connectcount": 3 },
                "user@host2": {},
                "wsl://ubuntu": {},
                local: {},
                "local:default": {},
                "": {},
            },
        } as unknown as FullConfigType;
        expect(connectionNamesFromConfig(config).sort()).toEqual(["user@host1", "user@host2"]);
    });
});

describe("clampNewTabRowIndex", () => {
    it("returns -1 when no selectable items so Enter cannot create a connection", () => {
        // Typing to a no-match state must never leave New Connection highlighted
        expect(clampNewTabRowIndex(0, 0, 0)).toBe(-1);
        expect(clampNewTabRowIndex(5, 0, 0)).toBe(-1);
        expect(clampNewTabRowIndex(-1, 0, null)).toBe(-1);
        expect(clampNewTabRowIndex(-1, 0, 0, 5)).toBe(-1);
    });

    it("clamps to selectable range when real items exist", () => {
        expect(clampNewTabRowIndex(5, 3, null)).toBe(2);
        expect(clampNewTabRowIndex(0, 3, null)).toBe(0);
        expect(clampNewTabRowIndex(1, 3, null)).toBe(1);
    });

    it("keeps no selection on open or short filter even when real items exist", () => {
        // Opening the dropdown with matches must not highlight localhost/first item
        expect(clampNewTabRowIndex(-1, 3, null, 0)).toBe(-1);
        // One character is still too short for auto-select
        expect(clampNewTabRowIndex(-1, 3, null, 1)).toBe(-1);
    });

    it("auto-selects first match after two or more filter characters", () => {
        expect(clampNewTabRowIndex(-1, 3, null, 2)).toBe(0);
        expect(clampNewTabRowIndex(-1, 5, null, 4)).toBe(0);
    });

    it("does not auto-select New Connection when only it remains", () => {
        // selectableCount 0 = only New Connection fallback (excluded from count)
        expect(clampNewTabRowIndex(-1, 0, 0, 3)).toBe(-1);
        expect(clampNewTabRowIndex(0, 0, 0, 3)).toBe(-1);
    });
});
