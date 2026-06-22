// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package userinputservice

import (
	"log"

	"github.com/wavetermdev/waveterm/pkg/userinput"
)

type UserInputService struct {
}

func (uis *UserInputService) SendUserInputResponse(response *userinput.UserInputResponse) {
	log.Printf("[DEBUG] userinputservice: SendUserInputResponse requestId=%q", response.RequestId)
	ch := userinput.MainUserInputHandler.Channels[response.RequestId]
	if ch == nil {
		log.Printf("[DEBUG] userinputservice: channel not found for requestId=%q (may have timed out)", response.RequestId)
		return
	}
	select {
	case ch <- response:
		log.Printf("[DEBUG] userinputservice: response sent to channel for requestId=%q", response.RequestId)
	default:
		log.Printf("[DEBUG] userinputservice: channel full for requestId=%q, dropping response", response.RequestId)
	}
}
