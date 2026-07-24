// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Input, InputGroup, InputLeftElement } from "@/app/element/input";
import {
    buildNewTabSuggestions,
    type NewTabSuggestionsResult,
} from "@/app/modals/conn-suggestions";
import {
    atoms,
    createBlock,
    getLocalHostDisplayNameAtom,
} from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as keyutil from "@/util/keyutil";
import clsx from "clsx";
import { useAtom } from "jotai";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./connectiondropdown.scss";

type NewTabConnTypeaheadProps = {
    anchorRef: React.RefObject<HTMLElement>;
    onSelect: (connName: string) => void;
    onClose: () => void;
};

/** Collect connection names from connections.json (excludes wsl/local). */
export function connectionNamesFromConfig(fullConfig: FullConfigType | null | undefined): string[] {
    if (!fullConfig?.connections) {
        return [];
    }
    return Object.keys(fullConfig.connections).filter(
        (name) => name !== "" && !name.startsWith("wsl://") && name !== "local" && !name.startsWith("local:")
    );
}

/**
 * Decide the next rowIndex after filter/list changes.
 *
 * Spec S6: when there are no real matches (only the New Connection fallback),
 * highlight stays off (index -1) so Enter does nothing until the user presses
 * ↓ or clicks the item. We always reset to -1 in that case — even if the user
 * had previously highlighted New Connection — because a filter change means
 * the intent is a new search, not create.
 */
export function clampNewTabRowIndex(
    prevIndex: number,
    selectableCount: number,
    _newConnectionIndex: number | null
): number {
    if (selectableCount === 0) {
        return -1;
    }
    // No default selection — user must ↓ or click (matches empty-filter open).
    if (prevIndex < 0) {
        return -1;
    }
    return Math.min(prevIndex, selectableCount - 1);
}

export const NewTabConnTypeahead = memo(function NewTabConnTypeahead({
    anchorRef,
    onSelect,
    onClose,
}: NewTabConnTypeaheadProps) {
    const [rpcConnList, setRpcConnList] = useState<string[]>([]);
    const [wslList, setWslList] = useState<string[]>([]);
    const [filterText, setFilterText] = useState("");
    // -1 = no highlight (default, and when only New Connection is shown so Enter is safe)
    const [rowIndex, setRowIndex] = useState(-1);
    const [loading, setLoading] = useState(true);
    const [posStyle, setPosStyle] = useState<React.CSSProperties>({});
    const dropdownRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const fullConfig = useAtom(atoms.fullConfigAtom)[0];
    const allConnStatus = useAtom(atoms.allConnStatus)[0];
    const localName = useAtom(getLocalHostDisplayNameAtom())[0];

    // Build connStatusMap from allConnStatus
    const connStatusMap = useMemo(() => {
        const map = new Map<string, ConnStatus>();
        for (const conn of allConnStatus) {
            map.set(conn.connection, conn);
        }
        return map;
    }, [allConnStatus]);

    // Merge RPC list with connections.json so the Remote section is not empty when
    // ConnListCommand fails, returns late, or omits hosts that only live in config.
    const connList = useMemo(() => {
        const fromConfig = connectionNamesFromConfig(fullConfig);
        return Array.from(new Set([...rpcConnList, ...fromConfig]));
    }, [rpcConnList, fullConfig]);

    // Positioning
    const updatePosition = useCallback(() => {
        const anchor = anchorRef?.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        setPosStyle({
            position: "fixed",
            top: rect.bottom,
            left: rect.left,
            minWidth: Math.max(rect.width, 280),
        });
    }, [anchorRef]);

    useLayoutEffect(() => {
        updatePosition();
        window.addEventListener("resize", updatePosition);
        return () => {
            window.removeEventListener("resize", updatePosition);
        };
    }, [updatePosition]);

    // Fetch connection lists independently — WSL failure must not block remotes.
    useEffect(() => {
        let cancelled = false;
        async function loadConnections() {
            const connPromise = RpcApi.ConnListCommand(TabRpcClient, { timeout: 5000 })
                .then((result) => {
                    if (!cancelled) {
                        setRpcConnList(result || []);
                    }
                })
                .catch((e) => {
                    console.error("Failed to load connections:", e);
                });
            const wslPromise = RpcApi.WslListCommand(TabRpcClient, { timeout: 2000 })
                .then((result) => {
                    if (!cancelled) {
                        setWslList(result || []);
                    }
                })
                .catch((_e) => {
                    // WSL not available on non-Windows — fail silently
                });
            await Promise.allSettled([connPromise, wslPromise]);
            if (!cancelled) {
                setLoading(false);
            }
        }
        loadConnections();
        return () => {
            cancelled = true;
        };
    }, []);

    // Autofocus input on mount
    useEffect(() => {
        // Defer one frame so the portal is in the DOM
        const id = requestAnimationFrame(() => {
            inputRef.current?.focus();
        });
        return () => cancelAnimationFrame(id);
    }, []);

    // Click outside to close
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            const anchor = anchorRef?.current;
            if (anchor && anchor.contains(e.target as Node)) return;
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                onClose();
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [onClose, anchorRef]);

    // Build suggestions
    const onEditConnections = useCallback(() => {
        onClose();
        createBlock({ meta: { view: "waveconfig", file: "connections.json" } }, false, true);
    }, [onClose]);

    const onCreate = useCallback(
        (connName: string) => {
            onClose();
            onSelect(connName);
        },
        [onClose, onSelect]
    );

    const { suggestions, selectionList, newConnectionIndex }: NewTabSuggestionsResult =
        buildNewTabSuggestions(connList, wslList, filterText, fullConfig ?? ({} as FullConfigType), connStatusMap, {
            localName: localName ?? "local",
            onCreate,
            onEditConnections,
        });

    // Real connections / Edit Connections — not the guarded New Connection item
    const selectableCount =
        newConnectionIndex !== null ? selectionList.length - 1 : selectionList.length;

    // Clamp rowIndex when suggestions change
    useEffect(() => {
        setRowIndex((idx) => clampNewTabRowIndex(idx, selectableCount, newConnectionIndex));
    }, [filterText, selectableCount, newConnectionIndex]);

    // Keyboard handler
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (keyutil.checkKeyPressed(e.nativeEvent as unknown as WaveKeyboardEvent, "Enter")) {
                e.preventDefault();
                // No highlight (e.g. only New Connection shown, user has not ↓) — do nothing.
                // Prevents fast type + Enter from creating a new connection (spec S6).
                if (rowIndex < 0 || selectionList.length === 0) {
                    return;
                }
                const item = selectionList[rowIndex];
                if (!item) {
                    return;
                }
                if ("onSelect" in item && item.onSelect) {
                    item.onSelect(item.value);
                } else {
                    onClose();
                    onSelect(item.value);
                }
                return;
            }
            if (keyutil.checkKeyPressed(e.nativeEvent as unknown as WaveKeyboardEvent, "Escape")) {
                onClose();
                return;
            }
            if (keyutil.checkKeyPressed(e.nativeEvent as unknown as WaveKeyboardEvent, "ArrowUp")) {
                e.preventDefault();
                setRowIndex((idx) => Math.max(idx - 1, -1));
                return;
            }
            if (keyutil.checkKeyPressed(e.nativeEvent as unknown as WaveKeyboardEvent, "ArrowDown")) {
                e.preventDefault();
                setRowIndex((idx) => {
                    // From no-highlight (-1): first ↓ selects first real item, or New Connection
                    // if that is the only entry.
                    if (idx < 0) {
                        if (selectableCount > 0) {
                            return 0;
                        }
                        if (newConnectionIndex !== null) {
                            return newConnectionIndex;
                        }
                        return -1;
                    }
                    // At last real item → allow one more ↓ onto New Connection
                    const maxSelectable = selectableCount - 1;
                    if (idx >= maxSelectable && newConnectionIndex !== null) {
                        return newConnectionIndex;
                    }
                    return Math.min(idx + 1, selectionList.length - 1);
                });
                return;
            }
        },
        [selectionList, rowIndex, selectableCount, newConnectionIndex, onClose, onSelect]
    );

    // Click handler for items
    const handleItemClick = useCallback(
        (item: SuggestionConnectionItem) => {
            if ("onSelect" in item && item.onSelect) {
                item.onSelect(item.value);
            } else {
                onClose();
                onSelect(item.value);
            }
        },
        [onClose, onSelect]
    );

    return createPortal(
        <div ref={dropdownRef} className="connection-dropdown" style={posStyle}>
            <InputGroup className="connection-dropdown-filter mb-1">
                <InputLeftElement>
                    <i className="fa fa-solid fa-magnifying-glass" style={{ color: "var(--grey-text-color)" }} />
                </InputLeftElement>
                <Input
                    ref={inputRef}
                    placeholder="Type to filter connections..."
                    value={filterText}
                    onChange={(value: string) => setFilterText(value)}
                    onKeyDown={handleKeyDown}
                    autoFocus
                />
            </InputGroup>
            {loading && connList.length === 0 ? (
                <div className="connection-dropdown-item">
                    <span className="typeahead-item-name">Loading...</span>
                </div>
            ) : (
                <div className="suggestions">
                    {suggestions.map((suggestion, sectionIdx) => {
                        if ("items" in suggestion) {
                            return (
                                <div key={sectionIdx}>
                                    {suggestion.headerText && (
                                        <div className="suggestion-header">{suggestion.headerText}</div>
                                    )}
                                    {suggestion.items.map((item, itemIdx) => {
                                        // Compute global index for this item
                                        let globalIdx = 0;
                                        for (let si = 0; si < sectionIdx; si++) {
                                            const s = suggestions[si];
                                            if ("items" in s) {
                                                globalIdx += s.items.length;
                                            } else {
                                                globalIdx += 1;
                                            }
                                        }
                                        globalIdx += itemIdx;
                                        return (
                                            <div
                                                key={itemIdx}
                                                onClick={() => handleItemClick(item)}
                                                className={clsx("suggestion-item", {
                                                    selected: rowIndex === globalIdx,
                                                })}
                                            >
                                                <div className="typeahead-item-name ellipsis">
                                                    {item.icon && (
                                                        <i
                                                            className={`fa fa-solid fa-${item.icon}`}
                                                            style={{ color: item.iconColor }}
                                                        />
                                                    )}
                                                    {item.label}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        }
                        // Single item (Edit Connections, New Connection)
                        const singleItem = suggestion as SuggestionConnectionItem;
                        // Compute global index
                        let globalIdx = 0;
                        for (let si = 0; si < sectionIdx; si++) {
                            const s = suggestions[si];
                            if ("items" in s) {
                                globalIdx += s.items.length;
                            } else {
                                globalIdx += 1;
                            }
                        }
                        return (
                            <div
                                key={sectionIdx}
                                onClick={() => handleItemClick(singleItem)}
                                className={clsx("suggestion-item", {
                                    selected: rowIndex === globalIdx,
                                })}
                            >
                                <div className="typeahead-item-name ellipsis">
                                    {singleItem.icon && (
                                        <i
                                            className={`fa fa-solid fa-${singleItem.icon}`}
                                            style={{ color: singleItem.iconColor }}
                                        />
                                    )}
                                    {singleItem.label}
                                </div>
                            </div>
                        );
                    })}
                    {suggestions.length === 0 && !loading && (
                        <div className="connection-dropdown-item">
                            <span className="typeahead-item-name">No connections found</span>
                        </div>
                    )}
                </div>
            )}
        </div>,
        document.body
    );
});
