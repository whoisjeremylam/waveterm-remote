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

var MainUserInputHandler = UserInputHandler{
	Channels:         make(map[string](chan *UserInputResponse), 1),
	AuthRequestConns: make(map[string]string),
}

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
	// AuthRequestConns maps requestId → connName for SSH auth prompts so we can
	// cancel every pending password/passphrase/kbd prompt for one connection
	// (A3: one Cancel dismisses all prompts for that conn).
	AuthRequestConns map[string]string
}

// OrphanedPasswords stores user-submitted passwords that arrived after the
// original GetUserInput goroutine timed out. Keyed by connName.
var OrphanedPasswords = make(map[string]string)
var orphanedPasswordsLock sync.Mutex

// windowPromptLocks provides per-window serialization for SSH auth prompts
// (password, keyboard-interactive, passphrase). When visibility-driven
// reconnect fires EnsureConnection for multiple disconnected password
// connections on the same tab, each Connect() may reach its password
// callback concurrently. Without serialization, the frontend would show
// all prompts simultaneously. By acquiring a per-window lock before
// sending the prompt to the frontend, only one prompt is shown at a time;
// the next connection's prompt appears after the first resolves (connect,
// cancel, or timeout).
var windowPromptLocks = make(map[string]*sync.Mutex)
var windowPromptLocksMu sync.Mutex

// acquireWindowPromptLock returns (and lazily creates) the per-window mutex
// for serializing SSH auth prompts. The caller must unlock it.
func acquireWindowPromptLock(windowId string) *sync.Mutex {
	windowPromptLocksMu.Lock()
	defer windowPromptLocksMu.Unlock()
	if lock, ok := windowPromptLocks[windowId]; ok {
		return lock
	}
	lock := &sync.Mutex{}
	windowPromptLocks[windowId] = lock
	return lock
}

// isSSHAuthPrompt returns true if the prompt type is an SSH authentication
// prompt that should be serialized per-window (password, keyboard-interactive,
// or passphrase). Confirm dialogs and other prompt types are not serialized.
func isSSHAuthPrompt(promptType string) bool {
	return promptType == "password" || promptType == "keyboard-interactive" || promptType == "passphrase"
}

type FrontendProvider struct{}

func (ui *UserInputHandler) registerChannel(connName string, isAuthPrompt bool) (string, chan *UserInputResponse) {
	ui.Lock.Lock()
	defer ui.Lock.Unlock()

	id := uuid.New().String()
	uich := make(chan *UserInputResponse, 1)

	ui.Channels[id] = uich
	if isAuthPrompt && connName != "" {
		if ui.AuthRequestConns == nil {
			ui.AuthRequestConns = make(map[string]string)
		}
		ui.AuthRequestConns[id] = connName
	}
	return id, uich
}

func (ui *UserInputHandler) unregisterChannel(id string) {
	ui.Lock.Lock()
	defer ui.Lock.Unlock()

	delete(ui.Channels, id)
	delete(ui.AuthRequestConns, id)
}

// CancelAllAuthPromptsForConn fails every pending SSH auth prompt (password,
// passphrase, keyboard-interactive) for connName with a cancel error so all
// GetUserInput waiters return. Used when the user Cancels one password dialog
// for a connection shared by multiple tabs/blocks.
func CancelAllAuthPromptsForConn(connName string) int {
	if connName == "" {
		return 0
	}
	ui := &MainUserInputHandler
	ui.Lock.Lock()
	var ids []string
	for id, cn := range ui.AuthRequestConns {
		if cn == connName {
			ids = append(ids, id)
		}
	}
	ui.Lock.Unlock()

	canceled := 0
	for _, id := range ids {
		ui.Lock.Lock()
		ch := ui.Channels[id]
		ui.Lock.Unlock()
		if ch == nil {
			continue
		}
		resp := &UserInputResponse{
			Type:      "userinputresp",
			RequestId: id,
			ErrorMsg:  "Canceled by the user",
			ConnName:  connName,
		}
		select {
		case ch <- resp:
			canceled++
		default:
			// already answered or buffer full
		}
	}
	return canceled
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
	connData := genconn.GetConnData(ctx)
	if connData != nil && request.ConnName == "" {
		request.ConnName = connData.GetConnName()
	}

	isAuth := isSSHAuthPrompt(request.PromptType)
	id, uiCh := MainUserInputHandler.registerChannel(request.ConnName, isAuth)
	defer MainUserInputHandler.unregisterChannel(id)
	request.RequestId = id
	request.TimeoutMs = int(utilfn.TimeoutFromContext(ctx, 30*time.Second).Milliseconds())

	log.Printf("[PW-PROMPT] GetUserInput: connName=%q requestId=%q promptType=%q", request.ConnName, request.RequestId, request.PromptType)

	scopes, scopesErr := determineScopes(ctx)
	if scopesErr != nil {
		blocklogger.Infof(ctx, "user input scopes could not be found: %v", scopesErr)
		// Try to find windows by connection name (used during reconnect)
		if request.ConnName != "" {
			scopes = findWindowsForConnection(ctx, request.ConnName)
		}
		if len(scopes) == 0 {
			allWindows, err := wstore.DBGetAllOIDsByType(ctx, "window")
			if err != nil {
				blocklogger.Infof(ctx, "unable to find windows for user input: %v", err)
				return nil, fmt.Errorf("unable to find windows for user input: %v", err)
			}
			scopes = allWindows
		}
	}

	// Serialize SSH auth prompts (password, keyboard-interactive, passphrase)
	// per-window: only one such prompt is shown at a time per window. This
	// prevents multiple disconnected connections on the same tab from prompting
	// simultaneously during visibility-driven reconnect. The user sees one
	// prompt at a time; the next connection's prompt appears after this one
	// resolves (connect, cancel, or timeout).
	//
	// Best-effort: if we couldn't determine a single window (fallback to
	// all-windows), skip serialization — prompts may appear simultaneously,
	// which is the pre-existing behavior. Non-auth prompts (confirm dialogs)
	// are never serialized.
	//
	// Note: the SSH handshake timeout (60s, DefaultConnectionTimeout) covers
	// the password callback. If a previous prompt holds the lock for a long
	// time, a later connection's handshake may time out while waiting. That
	// connection will retry on the next visibility-driven reconnect event —
	// acceptable degradation in exchange for one-prompt-at-a-time UX.
	var windowPromptLock *sync.Mutex
	if isSSHAuthPrompt(request.PromptType) && len(scopes) >= 1 {
		windowPromptLock = acquireWindowPromptLock(scopes[0])
		windowPromptLock.Lock()
		defer windowPromptLock.Unlock()
		log.Printf("[PW-PROMPT] acquired window prompt lock for window=%q connName=%q requestId=%q", scopes[0], request.ConnName, request.RequestId)
	}

	MainUserInputHandler.sendRequestToFrontend(request, scopes)

	var response *UserInputResponse
	var err error
	select {
	case resp := <-uiCh:
		response = resp
	case <-ctx.Done():
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

// CacheOrphanedPassword stores a password from a user input response that arrived
// after the original GetUserInput goroutine timed out. The conncontroller checks
// this cache in connectInternal before prompting the user.
func CacheOrphanedPassword(connName string, password string) {
	if connName == "" || password == "" {
		return
	}
	orphanedPasswordsLock.Lock()
	defer orphanedPasswordsLock.Unlock()
	OrphanedPasswords[connName] = password
}

// GetOrphanedPassword retrieves and clears a cached orphaned password for connName.
// Returns nil if no orphaned password exists.
func GetOrphanedPassword(connName string) *string {
	orphanedPasswordsLock.Lock()
	defer orphanedPasswordsLock.Unlock()
	pw, ok := OrphanedPasswords[connName]
	if !ok {
		return nil
	}
	delete(OrphanedPasswords, connName)
	return &pw
}
