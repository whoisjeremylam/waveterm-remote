// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./connectiondropdown.scss";

type ConnectionDropdownProps = {
    onSelect: (connName: string) => void;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement>;
};

export const ConnectionDropdown = memo(function ConnectionDropdown({
    onSelect,
    onClose,
    anchorRef,
}: ConnectionDropdownProps) {
    const [connections, setConnections] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [posStyle, setPosStyle] = useState<React.CSSProperties>({});
    const dropdownRef = useRef<HTMLDivElement>(null);

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

    useEffect(() => {
        updatePosition();
        window.addEventListener("resize", updatePosition);
        return () => {
            window.removeEventListener("resize", updatePosition);
        };
    }, [updatePosition]);

    useEffect(() => {
        async function loadConnections() {
            try {
                const result = await RpcApi.ConnListCommand(TabRpcClient, { timeout: 2000 });
                setConnections(result || []);
            } catch (e) {
                console.error("Failed to load connections:", e);
            } finally {
                setLoading(false);
            }
        }
        loadConnections();
    }, []);

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

    return createPortal(
        <div ref={dropdownRef} className="connection-dropdown" style={posStyle}>
            {loading ? (
                <div className="connection-dropdown-item">
                    <span className="typeahead-item-name">Loading...</span>
                </div>
            ) : (
                <>
                    <div className="connection-dropdown-header">Local</div>
                    <div className="connection-dropdown-item" onClick={() => onSelect("")}>
                        <span className="typeahead-item-name">
                            <i className="fa fa-solid fa-laptop" /> Local
                        </span>
                    </div>
                    {connections.length > 0 && (
                        <>
                            <div className="connection-dropdown-header">Remote</div>
                            {connections.map((conn) => (
                                <div
                                    key={conn}
                                    className="connection-dropdown-item"
                                    onClick={() => onSelect(conn)}
                                >
                                    <span className="typeahead-item-name">
                                        <i className="fa fa-solid fa-arrows-left-right" /> {conn}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}
                </>
            )}
        </div>,
        document.body
    );
});
