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
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./connectiondropdown.scss";

type NewTabConnTypeaheadProps = {
    anchorRef: React.RefObject<HTMLElement>;
    onSelect: (connName: string) => void;
    onClose: () => void;
};

export const NewTabConnTypeahead = memo(function NewTabConnTypeahead({
    anchorRef,
    onSelect,
    onClose,
}: NewTabConnTypeaheadProps) {
    const [connList, setConnList] = useState<string[]>([]);
    const [wslList, setWslList] = useState<string[]>([]);
    const [filterText, setFilterText] = useState("");
    const [rowIndex, setRowIndex] = useState(0);
    const [loading, setLoading] = useState(true);
    const [posStyle, setPosStyle] = useState<React.CSSProperties>({});
    const dropdownRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const fullConfig = useAtom(atoms.fullConfigAtom)[0];
    const allConnStatus = useAtom(atoms.allConnStatus)[0];
    const localName = useAtom(getLocalHostDisplayNameAtom())[0];

    // Build connStatusMap from allConnStatus
    const connStatusMap = new Map<string, ConnStatus>();
    for (const conn of allConnStatus) {
        connStatusMap.set(conn.connection, conn);
    }

    // Positioning
    const updatePosition = useCallback(() => {
        const anchor = anchorRef?.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        setPosStyle({
            position: "fixed",
            top: rect.bottom,
            left: rect.left,
        });
    }, [anchorRef]);

    useLayoutEffect(() => {
        updatePosition();
        window.addEventListener("resize", updatePosition);
        return () => {
            window.removeEventListener("resize", updatePosition);
        };
    }, [updatePosition]);

    // Fetch connection lists
    useEffect(() => {
        async function loadConnections() {
            try {
                const connResult = await RpcApi.ConnListCommand(TabRpcClient, { timeout: 2000 });
                setConnList(connResult || []);
            } catch (e) {
                console.error("Failed to load connections:", e);
            }
            try {
                const wslResult = await RpcApi.WslListCommand(TabRpcClient, { timeout: 2000 });
                setWslList(wslResult || []);
            } catch (_e) {
                // WSL not available on non-Windows — fail silently
            }
            setLoading(false);
        }
        loadConnections();
    }, []);

    // Autofocus input on mount
    useEffect(() => {
        inputRef.current?.focus();
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
        buildNewTabSuggestions(connList, wslList, filterText, fullConfig, connStatusMap, {
            localName,
            onCreate,
            onEditConnections,
        });

    // Compute selectable items (all items except New Connection)
    const selectableCount = newConnectionIndex !== null
        ? selectionList.length - 1
        : selectionList.length;

    // Clamp rowIndex when suggestions change
    useEffect(() => {
        setRowIndex((idx) => {
            if (selectableCount === 0) return 0;
            return Math.min(idx, selectableCount - 1);
        });
    }, [filterText, selectableCount]);

    // Keyboard handler
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (keyutil.checkKeyPressed(e.nativeEvent as unknown as WaveKeyboardEvent, "Enter")) {
                e.preventDefault();
                if (selectionList.length === 0) {
                    // No items — do nothing (preserve typed text per spec S6)
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
                setRowIndex((idx) => Math.max(idx - 1, 0));
                return;
            }
            if (keyutil.checkKeyPressed(e.nativeEvent as unknown as WaveKeyboardEvent, "ArrowDown")) {
                e.preventDefault();
                setRowIndex((idx) => {
                    // If we're at the last selectable item and New Connection exists,
                    // allow moving to it. Otherwise clamp to selectable range.
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
            <InputGroup className="mb-1">
                <InputLeftElement>
                    <i className="fa fa-solid fa-magnifying-glass" style={{ color: "var(--grey-text-color)" }} />
                </InputLeftElement>
                <Input
                    ref={inputRef}
                    placeholder="Connect to (username@host)..."
                    value={filterText}
                    onChange={(value: string) => setFilterText(value)}
                    onKeyDown={handleKeyDown}
                    autoFocus
                />
            </InputGroup>
            {loading ? (
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
