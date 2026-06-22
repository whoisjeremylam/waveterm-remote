// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package userinput

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/blocklogger"
	"github.com/wavetermdev/waveterm/pkg/genconn"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var MainUserInputHandler = UserInputHandler{Channels: make(map[string](chan *UserInputResponse), 1)}

var defaultProvider UserInputProvider = &FrontendProvider{}

type UserInputProvider interface {
	GetUserInput(ctx context.Context, request *UserInputRequest) (*UserInputResponse, error)
}

type UserInputRequest struct {
	RequestId    string `json:"requestid"`
	QueryText    string `json:"querytext"`
	ResponseType string `json:"responsetype"`
	Title        string `json:"title"`
	Markdown     bool   `json:"markdown"`
	TimeoutMs    int    `json:"timeoutms"`
	CheckBoxMsg  string `json:"checkboxmsg"`
	PublicText   bool   `json:"publictext"`
	OkLabel      string `json:"oklabel,omitempty"`
	CancelLabel  string `json:"cancellabel,omitempty"`
	ConnName     string `json:"connname,omitempty"`
	PromptType   string `json:"prompttype,omitempty"` // "password", "confirm", etc.
}

type UserInputResponse struct {
	Type         string `json:"type"`
	RequestId    string `json:"requestid"`
	Text         string `json:"text,omitempty"`
	Confirm      bool   `json:"confirm,omitempty"`
	ErrorMsg     string `json:"errormsg,omitempty"`
	CheckboxStat bool   `json:"checkboxstat,omitempty"`
	ConnName     string `json:"connname,omitempty"`
}

type UserInputHandler struct {
	Lock     sync.Mutex
	Channels map[string](chan *UserInputResponse)
}

type FrontendProvider struct{}

func (ui *UserInputHandler) registerChannel() (string, chan *UserInputResponse) {
	ui.Lock.Lock()
	defer ui.Lock.Unlock()

	id := uuid.New().String()
	uich := make(chan *UserInputResponse, 1)

	ui.Channels[id] = uich
	return id, uich
}

func (ui *UserInputHandler) unregisterChannel(id string) {
	ui.Lock.Lock()
	defer ui.Lock.Unlock()

	delete(ui.Channels, id)
}

func (ui *UserInputHandler) sendRequestToFrontend(request *UserInputRequest, scopes []string) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_UserInput,
		Data:   request,
		Scopes: scopes,
	})
}

func determineScopes(ctx context.Context) ([]string, error) {
	connData := genconn.GetConnData(ctx)
	if connData == nil {
		return nil, fmt.Errorf("context did not contain connection info")
	}
	// resolve windowId from blockId
	tabId, err := wstore.DBFindTabForBlockId(ctx, connData.BlockId)
	if err != nil {
		return nil, fmt.Errorf("unabled to determine tab for route: %w", err)
	}
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return nil, fmt.Errorf("unabled to determine workspace for route: %w", err)
	}
	windowId, err := wstore.DBFindWindowForWorkspaceId(ctx, workspaceId)
	if err != nil {
		return nil, fmt.Errorf("unabled to determine window for route: %w", err)
	}

	return []string{windowId}, nil
}

// findWindowsForConnection finds all windows that contain blocks using the given connection.
// Used as a fallback when determineScopes fails (e.g., during reconnect without BlockId in context).
func findWindowsForConnection(ctx context.Context, connName string) []string {
	blockIds, err := wstore.DBFindBlocksByConnection(ctx, connName)
	if err != nil || len(blockIds) == 0 {
		return nil
	}
	windowSet := make(map[string]bool)
	for _, blockId := range blockIds {
		tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
		if err != nil {
			continue
		}
		workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
		if err != nil {
			continue
		}
		windowId, err := wstore.DBFindWindowForWorkspaceId(ctx, workspaceId)
		if err != nil {
			continue
		}
		if windowId != "" {
			windowSet[windowId] = true
		}
	}
	windows := make([]string, 0, len(windowSet))
	for w := range windowSet {
		windows = append(windows, w)
	}
	return windows
}

func (p *FrontendProvider) GetUserInput(ctx context.Context, request *UserInputRequest) (*UserInputResponse, error) {
	id, uiCh := MainUserInputHandler.registerChannel()
	defer MainUserInputHandler.unregisterChannel(id)
	request.RequestId = id
	request.TimeoutMs = int(utilfn.TimeoutFromContext(ctx, 30*time.Second).Milliseconds())

	connData := genconn.GetConnData(ctx)
	if connData != nil && request.ConnName == "" {
		request.ConnName = connData.GetConnName()
	}

	log.Printf("[DEBUG] GetUserInput called: connName=%q promptType=%q requestId=%q", request.ConnName, request.PromptType, request.RequestId)

	scopes, scopesErr := determineScopes(ctx)
	if scopesErr != nil {
		log.Printf("[DEBUG] determineScopes failed: %v", scopesErr)
		blocklogger.Infof(ctx, "user input scopes could not be found: %v", scopesErr)
		// Try to find windows by connection name (used during reconnect)
		if request.ConnName != "" {
			scopes = findWindowsForConnection(ctx, request.ConnName)
			log.Printf("[DEBUG] findWindowsForConnection returned %d scopes for %q", len(scopes), request.ConnName)
		}
		if len(scopes) == 0 {
			allWindows, err := wstore.DBGetAllOIDsByType(ctx, "window")
			if err != nil {
				blocklogger.Infof(ctx, "unable to find windows for user input: %v", err)
				return nil, fmt.Errorf("unable to find windows for user input: %v", err)
			}
			log.Printf("[DEBUG] falling back to all %d windows", len(allWindows))
			scopes = allWindows
		}
	} else {
		log.Printf("[DEBUG] determineScopes returned %d scopes: %v", len(scopes), scopes)
	}

	log.Printf("[DEBUG] sending userinput event to scopes: %v", scopes)
	MainUserInputHandler.sendRequestToFrontend(request, scopes)

	var response *UserInputResponse
	var err error
	select {
	case resp := <-uiCh:
		log.Printf("[DEBUG] received response for requestId=%q", resp.RequestId)
		response = resp
	case <-ctx.Done():
		log.Printf("[DEBUG] GetUserInput timed out for requestId=%q connName=%q", request.RequestId, request.ConnName)
		return nil, fmt.Errorf("timed out waiting for user input")
	}

	if response.ErrorMsg != "" {
		err = errors.New(response.ErrorMsg)
	}

	return response, err
}

func GetUserInput(ctx context.Context, request *UserInputRequest) (*UserInputResponse, error) {
	return defaultProvider.GetUserInput(ctx, request)
}

func SetUserInputProvider(provider UserInputProvider) {
	defaultProvider = provider
}
