// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Block } from "@/app/block/block";
import { CenteredDiv } from "@/element/quickelems";
import { ContentRenderer, NodeModel, PreviewRenderer, TileLayout } from "@/layout/index";
import { TileLayoutContents } from "@/layout/lib/types";
import { atoms, getApi, globalStore, getBlockMetaKeyAtom } from "@/store/global";
import * as services from "@/store/services";
import * as WOS from "@/store/wos";
import { atom, useAtomValue } from "jotai";
import * as React from "react";
import { useMemo, useEffect, useRef } from "react";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { RpcApi } from "@/app/store/wshclientapi";
import { isLocalConnName } from "@/util/util";

const tileGapSizeAtom = atom((get) => {
    const settings = get(atoms.settingsAtom);
    return settings["window:tilegapsize"];
});

const TabContent = React.memo(({ tabId, noTopPadding }: { tabId: string; noTopPadding?: boolean }) => {
    const oref = useMemo(() => WOS.makeORef("tab", tabId), [tabId]);
    const loadingAtom = useMemo(() => WOS.getWaveObjectLoadingAtom(oref), [oref]);
    const tabLoading = useAtomValue(loadingAtom);
    const tabAtom = useMemo(() => WOS.getWaveObjectAtom<Tab>(oref), [oref]);
    const tabData = useAtomValue(tabAtom);
    const tileGapSize = useAtomValue(tileGapSizeAtom);
    const hasTriggeredReconnect = useRef(false);

    // On tab activation (mount), trigger reconnect for disconnected connections.
    // This closes the gap where the scheduler gave up (5 min max) and the user
    // switches to the tab expecting the connection to retry automatically.
    useEffect(() => {
        if (hasTriggeredReconnect.current || !tabData?.blockids?.length) {
            return;
        }
        hasTriggeredReconnect.current = true;
        const seenConns = new Set<string>();
        for (const blockId of tabData.blockids) {
            const connAtom = getBlockMetaKeyAtom(blockId, "connection");
            const connName = globalStore.get(connAtom);
            if (!connName || typeof connName !== "string" || isLocalConnName(connName) || seenConns.has(connName)) {
                continue;
            }
            seenConns.add(connName);
            RpcApi.ConnEnsureCommand(
                TabRpcClient,
                { connname: connName, logblockid: blockId },
                { timeout: 60000 }
            ).catch((e: unknown) => {
                console.log("tab activation: error ensuring connection", blockId, connName, e);
            });
        }
    }, [tabData?.blockids]);

    const tileLayoutContents = useMemo(() => {
        const renderContent: ContentRenderer = (nodeModel: NodeModel) => {
            return <Block key={nodeModel.blockId} nodeModel={nodeModel} preview={false} />;
        };

        const renderPreview: PreviewRenderer = (nodeModel: NodeModel) => {
            return <Block key={nodeModel.blockId} nodeModel={nodeModel} preview={true} />;
        };

        function onNodeDelete(data: TabLayoutData) {
            return services.ObjectService.DeleteBlock(data.blockId);
        }

        return {
            renderContent,
            renderPreview,
            tabId,
            onNodeDelete,
            gapSizePx: tileGapSize,
        } as TileLayoutContents;
    }, [tabId, tileGapSize]);

    let innerContent;

    if (tabLoading) {
        innerContent = <CenteredDiv>Tab Loading</CenteredDiv>;
    } else if (!tabData) {
        innerContent = <CenteredDiv>Tab Not Found</CenteredDiv>;
    } else if (tabData?.blockids?.length == 0) {
        innerContent = null;
    } else {
        innerContent = (
            <TileLayout
                key={tabId}
                contents={tileLayoutContents}
                tabAtom={tabAtom}
                getCursorPoint={getApi().getCursorPoint}
            />
        );
    }

    return (
        <div className={`flex flex-row flex-grow min-h-0 w-full items-center justify-center overflow-hidden relative ${noTopPadding ? "" : "pt-[3px]"} pr-[3px]`}>
            {innerContent}
        </div>
    );
});

export { TabContent };
