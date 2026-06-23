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
	ch := userinput.MainUserInputHandler.Channels[response.RequestId]
	if ch == nil {
		log.Printf("[PW-RESP] channel not found for requestId=%q (may have timed out)", response.RequestId)
		return
	}
	select {
	case ch <- response:
		log.Printf("[PW-RESP] response sent for requestId=%q", response.RequestId)
	default:
		log.Printf("[PW-RESP] channel full for requestId=%q, dropping response", response.RequestId)
	}
}
