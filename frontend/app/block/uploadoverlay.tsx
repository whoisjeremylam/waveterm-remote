// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockUploadState, getBlockUploadStateAtom } from "@/app/store/global";
import { NodeModel } from "@/layout/index";
import * as jotai from "jotai";
import * as React from "react";
import { BlockOverlay } from "./blockoverlay";

interface UploadOverlayProps {
    nodeModel: NodeModel;
}

export const UploadOverlay = React.memo(({ nodeModel }: UploadOverlayProps) => {
    const uploadAtom = React.useMemo(() => getBlockUploadStateAtom(nodeModel.blockId), [nodeModel.blockId]);
    const uploadState = jotai.useAtomValue(uploadAtom);

    if (!uploadState?.active) {
        return null;
    }

    return (
        <BlockOverlay>
            <i className="fa-solid fa-spinner fa-spin text-info text-base shrink-0" title="Uploading"></i>
            <div className="text-[11px] font-semibold leading-4 tracking-[0.11px] text-white min-w-0 flex-1 break-words @max-xxs:hidden">
                Uploading {uploadState.fileName}…
            </div>
            <div className="flex-1 hidden @max-xxs:block"></div>
        </BlockOverlay>
    );
});
UploadOverlay.displayName = "UploadOverlay";
