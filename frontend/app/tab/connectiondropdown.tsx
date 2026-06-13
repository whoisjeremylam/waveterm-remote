// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { memo, useEffect, useRef, useState } from "react";
import "./connectiondropdown.scss";

type ConnectionDropdownProps = {
    onSelect: (connName: string) => void;
    onClose: () => void;
};

export const ConnectionDropdown = memo(function ConnectionDropdown({ onSelect, onClose }: ConnectionDropdownProps) {
    const [connections, setConnections] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const dropdownRef = useRef<HTMLDivElement>(null);

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
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                onClose();
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [onClose]);

    return (
        <div ref={dropdownRef} className="connection-dropdown">
            {loading ? (
                <div className="connection-dropdown-item">Loading...</div>
            ) : (
                <>
                    <div className="connection-dropdown-header">Local</div>
                    <div className="connection-dropdown-item" onClick={() => onSelect("")}>
                        <i className="fa fa-solid fa-laptop" /> Local
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
                                    <i className="fa fa-solid fa-arrows-left-right" /> {conn}
                                </div>
                            ))}
                        </>
                    )}
                </>
            )}
        </div>
    );
});
