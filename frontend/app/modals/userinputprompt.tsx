// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/app/element/button";
import { Markdown } from "@/element/markdown";
import { modalsModel } from "@/store/modalmodel";
import * as keyutil from "@/util/keyutil";
import { fireAndForget } from "@/util/util";
import { useCallback, useMemo, useRef, useState } from "react";
import { UserInputService } from "../store/services";
import "./userinputprompt.scss";

interface UserInputPromptProps extends UserInputRequest {
    blockId?: string;
}

const UserInputPrompt = (userInputRequest: UserInputPromptProps) => {
    const [responseText, setResponseText] = useState("");
    const checkboxRef = useRef<HTMLInputElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const connName = userInputRequest.connname;
    const blockId = userInputRequest.blockId;

    const handleDismiss = useCallback(() => {
        if (connName) {
            modalsModel.dismissUserInputPrompt(connName);
        } else {
            modalsModel.popModal();
        }
    }, [connName]);

    const handleSendErrResponse = useCallback(() => {
        fireAndForget(() =>
            UserInputService.SendUserInputResponse({
                type: "userinputresp",
                requestid: userInputRequest.requestid,
                errormsg: "Canceled by the user",
            })
        );
        handleDismiss();
    }, [userInputRequest, handleDismiss]);

    const handleSendText = useCallback(() => {
        fireAndForget(() =>
            UserInputService.SendUserInputResponse({
                type: "userinputresp",
                requestid: userInputRequest.requestid,
                text: responseText,
                checkboxstat: checkboxRef?.current?.checked ?? false,
            })
        );
        handleDismiss();
    }, [responseText, userInputRequest, handleDismiss]);

    const handleSendConfirm = useCallback(
        (response: boolean) => {
            fireAndForget(() =>
                UserInputService.SendUserInputResponse({
                    type: "userinputresp",
                    requestid: userInputRequest.requestid,
                    confirm: response,
                    checkboxstat: checkboxRef?.current?.checked ?? false,
                })
            );
            handleDismiss();
        },
        [userInputRequest, handleDismiss]
    );

    const handleSubmit = useCallback(() => {
        switch (userInputRequest.responsetype) {
            case "text":
                handleSendText();
                break;
            case "confirm":
                handleSendConfirm(true);
                break;
        }
    }, [handleSendConfirm, handleSendText, userInputRequest.responsetype]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const waveEvent = keyutil.adaptFromReactOrNativeKeyEvent(e);
            if (keyutil.checkKeyPressed(waveEvent, "Escape")) {
                handleSendErrResponse();
                return;
            }
            if (keyutil.checkKeyPressed(waveEvent, "Enter")) {
                handleSubmit();
            }
        },
        [handleSendErrResponse, handleSubmit]
    );

    const queryText = useMemo(() => {
        if (userInputRequest.markdown) {
            return <Markdown text={userInputRequest.querytext} />;
        }
        return <span>{userInputRequest.querytext}</span>;
    }, [userInputRequest.markdown, userInputRequest.querytext]);

    const inputBox = useMemo(() => {
        if (userInputRequest.responsetype === "confirm") {
            return <></>;
        }
        return (
            <input
                ref={inputRef}
                type={userInputRequest.publictext ? "text" : "password"}
                onChange={(e) => setResponseText(e.target.value)}
                value={responseText}
                maxLength={400}
                className="resize-none bg-panel rounded-md border border-border py-1.5 pl-4 min-h-[30px] text-inherit cursor-text focus:ring-2 focus:ring-accent focus:outline-none"
                autoFocus={true}
                onKeyDown={handleKeyDown}
            />
        );
    }, [userInputRequest.responsetype, userInputRequest.publictext, responseText, handleKeyDown, setResponseText]);

    const optionalCheckbox = useMemo(() => {
        if (userInputRequest.checkboxmsg == "") {
            return <></>;
        }
        return (
            <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                    <input
                        type="checkbox"
                        id={`uicheckbox-${userInputRequest.requestid}`}
                        className="accent-accent cursor-pointer"
                        ref={checkboxRef}
                    />
                    <label htmlFor={`uicheckbox-${userInputRequest.requestid}`} className="cursor-pointer">{userInputRequest.checkboxmsg}</label>
                </div>
            </div>
        );
    }, []);

    const handleNegativeResponse = useCallback(() => {
        switch (userInputRequest.responsetype) {
            case "text":
                handleSendErrResponse();
                break;
            case "confirm":
                handleSendConfirm(false);
                break;
        }
    }, [userInputRequest.responsetype, handleSendErrResponse, handleSendConfirm]);

    const renderPrompt = () => (
        <div className="userinput-prompt-wrapper">
            <div className="userinput-prompt" onKeyDown={handleKeyDown}>
                <div className="userinput-prompt-header">
                    <div className="font-bold text-primary">{userInputRequest.title}</div>
                </div>
                <div className="userinput-prompt-body">
                    {queryText}
                    {inputBox}
                    {optionalCheckbox}
                </div>
                <div className="userinput-prompt-footer">
                    <Button className="grey ghost" onClick={handleNegativeResponse}>
                        {userInputRequest.cancellabel || "Cancel"}
                    </Button>
                    <Button onClick={() => handleSubmit()}>
                        {userInputRequest.oklabel || "Ok"}
                    </Button>
                </div>
            </div>
        </div>
    );

    return renderPrompt();
};

UserInputPrompt.displayName = "UserInputPrompt";

export { UserInputPrompt };
