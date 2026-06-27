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
		// If the original GetUserInput goroutine timed out, cache the password
		// so the next connect attempt can use it without re-prompting.
		if response.Text != "" && response.ConnName != "" {
			userinput.CacheOrphanedPassword(response.ConnName, response.Text)
			log.Printf("[PW-RESP] cached orphaned password for conn=%q", response.ConnName)
		}
		return
	}
	select {
	case ch <- response:
		log.Printf("[PW-RESP] response sent for requestId=%q", response.RequestId)
	default:
		log.Printf("[PW-RESP] channel full for requestId=%q, dropping response", response.RequestId)
	}
}
