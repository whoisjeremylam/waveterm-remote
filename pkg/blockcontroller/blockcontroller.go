// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"encoding/base64"
	"fmt"
	"io/fs"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/blocklogger"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/util/ds"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wslconn"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	BlockController_Shell   = "shell"
	BlockController_Cmd     = "cmd"
	BlockController_Tsunami = "tsunami"
)

const (
	Status_Running = "running"
	Status_Done    = "done"
	Status_Init    = "init"
)

const (
	DefaultTermMaxFileSize = 2 * 1024 * 1024
	DefaultHtmlMaxFileSize = 256 * 1024
	MaxInitScriptSize      = 50 * 1024
)

const DefaultTimeout = 2 * time.Second
const DefaultGracefulKillWait = 400 * time.Millisecond

type BlockInputUnion struct {
	InputData []byte            `json:"inputdata,omitempty"`
	SigName   string            `json:"signame,omitempty"`
	TermSize  *waveobj.TermSize `json:"termsize,omitempty"`
}

type BlockControllerRuntimeStatus struct {
	BlockId           string `json:"blockid"`
	Version           int64  `json:"version"`
	ShellProcStatus   string `json:"shellprocstatus,omitempty"`
	ShellProcConnName string `json:"shellprocconnname,omitempty"`
	ShellProcExitCode int    `json:"shellprocexitcode"`
	TsunamiPort       int    `json:"tsunamiport,omitempty"`
}

// Controller interface that all block controllers must implement
type Controller interface {
	Start(ctx context.Context, blockMeta waveobj.MetaMapType, rtOpts *waveobj.RuntimeOpts, force bool) error
	Stop(graceful bool, newStatus string, destroy bool)
	GetRuntimeStatus() *BlockControllerRuntimeStatus // does not return nil
	GetConnName() string
	SendInput(input *BlockInputUnion) error
}

// Registry for all controllers
var (
	controllerRegistry  = make(map[string]Controller)
	registryLock        sync.RWMutex
	blockResyncMutexMap = ds.MakeSyncMap[*sync.Mutex]()
)

func getBlockResyncMutex(blockId string) *sync.Mutex {
	return blockResyncMutexMap.GetOrCreate(blockId, func() *sync.Mutex {
		return &sync.Mutex{}
	})
}

// Registry operations
func getController(blockId string) Controller {
	registryLock.RLock()
	defer registryLock.RUnlock()
	return controllerRegistry[blockId]
}

func registerController(blockId string, controller Controller) {
	var existingController Controller

	registryLock.Lock()
	existing, exists := controllerRegistry[blockId]
	if exists {
		existingController = existing
	}
	controllerRegistry[blockId] = controller
	registryLock.Unlock()

	if existingController != nil {
		existingController.Stop(false, Status_Done, true)
		wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId))
	}
}

func deleteController(blockId string) {
	registryLock.Lock()
	defer registryLock.Unlock()
	delete(controllerRegistry, blockId)
}

func getAllControllers() map[string]Controller {
	registryLock.RLock()
	defer registryLock.RUnlock()
	// Return a copy to avoid lock issues
	result := make(map[string]Controller)
	for k, v := range controllerRegistry {
		result[k] = v
	}
	return result
}

func InitBlockController() {
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, handleBlockCloseEvent)
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{
		Event:     wps.Event_BlockClose,
		AllScopes: true,
	}, nil)
}

// StartupReconnectDurableShells proactively establishes SSH connections
// and reconnects jobs for all blocks with durable shells.
// This is called once at startup to ensure connections for non-active
// tabs are established before the user switches to them.
func StartupReconnectDurableShells(ctx context.Context) {
	log.Printf("[startup] scanning blocks for durable shell reconnection")
	allBlocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		log.Printf("[startup] error getting blocks: %v", err)
		return
	}

	type durableBlock struct {
		BlockId  string
		ConnName string
		JobId    string
	}
	var durableBlocks []durableBlock
	for _, block := range allBlocks {
		if !jobcontroller.IsBlockTermDurable(block) {
			continue
		}
		connName := block.Meta.GetString(waveobj.MetaKey_Connection, "")
		if conncontroller.IsLocalConnName(connName) {
			continue
		}
		durableBlocks = append(durableBlocks, durableBlock{
			BlockId:  block.OID,
			ConnName: connName,
			JobId:    block.JobId,
		})
	}

	if len(durableBlocks) == 0 {
		log.Printf("[startup] no durable shell blocks found")
		return
	}

	log.Printf("[startup] found %d durable shell blocks, establishing connections", len(durableBlocks))

	// Collect unique connections and establish them
	establishedConns := make(map[string]bool)
	for _, db := range durableBlocks {
		if establishedConns[db.ConnName] {
			continue
		}
		establishedConns[db.ConnName] = true
		go func(connName string) {
			defer func() {
				panichandler.PanicHandler("jobcontroller:StartupReconnectDurableShells-conn", recover())
			}()
			// Connections that need interactive auth (password prompt) must NOT
			// use a timeout context — the password prompt needs to stay up until
			// the user responds. Only use a timeout for key-based connections.
			var connCtx context.Context
			var cancel context.CancelFunc
			if conncontroller.NeedsInteractiveAuth(connName) {
				connCtx, cancel = context.WithCancel(context.Background())
			} else {
				connCtx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
			}
			defer cancel()
			err := conncontroller.EnsureConnection(connCtx, connName)
			if err != nil {
				log.Printf("[startup] failed to establish connection %q: %v", connName, err)
				return
			}
			log.Printf("[startup] connection %q established", connName)
		}(db.ConnName)
	}

	// Wait for connections to be established, then reconnect jobs
	// Use a polling approach with a timeout to wait for connections
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer waitCancel()
	for connName := range establishedConns {
		waitForConn(waitCtx, connName)
	}

	// Reconnect jobs for all durable blocks
	for _, db := range durableBlocks {
		if db.JobId == "" {
			continue
		}
		go func(blockId, jobId, connName string) {
			defer func() {
				panichandler.PanicHandler("jobcontroller:StartupReconnectDurableShells-reconnect", recover())
			}()
			isConnected, err := conncontroller.IsConnected(connName)
			if err != nil || !isConnected {
				log.Printf("[startup] connection %q not ready for block %s job %s, skipping reconnect", connName, blockId, jobId)
				return
			}
			reconnectCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			err = jobcontroller.ReconnectJob(reconnectCtx, jobId, nil)
			if err != nil {
				log.Printf("[startup] failed to reconnect job %s for block %s: %v", jobId, blockId, err)
			} else {
				log.Printf("[startup] reconnected job %s for block %s", jobId, blockId)
			}
		}(db.BlockId, db.JobId, db.ConnName)
	}
}

func waitForConn(ctx context.Context, connName string) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			isConnected, err := conncontroller.IsConnected(connName)
			if err == nil && isConnected {
				return
			}
		}
	}
}

func handleBlockCloseEvent(event *wps.WaveEvent) {
	blockId, ok := event.Data.(string)
	if !ok {
		log.Printf("[blockclose] invalid event data type")
		return
	}
	go DestroyBlockController(blockId)
}

// Public API Functions

func ResyncController(ctx context.Context, tabId string, blockId string, rtOpts *waveobj.RuntimeOpts, force bool) error {
	if tabId == "" || blockId == "" {
		return fmt.Errorf("invalid tabId or blockId passed to ResyncController")
	}

	mu := getBlockResyncMutex(blockId)
	mu.Lock()
	defer mu.Unlock()

	blockData, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return fmt.Errorf("error getting block: %w", err)
	}

	controllerName := blockData.Meta.GetString(waveobj.MetaKey_Controller, "")
	connName := blockData.Meta.GetString(waveobj.MetaKey_Connection, "")

	// Get existing controller
	existing := getController(blockId)

	// Check for connection change FIRST - always destroy on conn change
	if existing != nil {
		existingConnName := existing.GetConnName()
		if existingConnName != connName {
			log.Printf("stopping blockcontroller %s due to conn change (from %q to %q)\n", blockId, existingConnName, connName)
			DestroyBlockController(blockId)
			time.Sleep(100 * time.Millisecond)
			existing = nil
		}
	}

	// If no controller needed, stop existing if present
	if controllerName == "" {
		if existing != nil {
			DestroyBlockController(blockId)
		}
		return nil
	}

	// Determine if we should use DurableShellController vs ShellController
	shouldUseDurableShellController := controllerName == BlockController_Shell && jobcontroller.IsBlockIdTermDurable(blockId)

	// Check if we need to morph controller type
	if existing != nil {
		needsReplace := false

		switch existing.(type) {
		case *ShellController:
			if controllerName != BlockController_Shell && controllerName != BlockController_Cmd {
				needsReplace = true
			} else if shouldUseDurableShellController {
				needsReplace = true
			}
		case *DurableShellController:
			if !shouldUseDurableShellController {
				needsReplace = true
			}
		case *TsunamiController:
			if controllerName != BlockController_Tsunami {
				needsReplace = true
			}
		}

		if needsReplace {
			log.Printf("stopping blockcontroller %s due to controller type change\n", blockId)
			DestroyBlockController(blockId)
			time.Sleep(100 * time.Millisecond)
			existing = nil
		}
	}

	// Force restart if requested
	if force && existing != nil {
		DestroyBlockController(blockId)
		time.Sleep(100 * time.Millisecond)
		existing = nil
	}

	// Destroy done controllers before restarting
	if existing != nil {
		status := existing.GetRuntimeStatus()
		if status.ShellProcStatus == Status_Done {
			log.Printf("destroying blockcontroller %s with done status before restart\n", blockId)
			DestroyBlockController(blockId)
			time.Sleep(100 * time.Millisecond)
			existing = nil
		}
	}

	// Create or restart controller
	var controller Controller
	if existing != nil {
		controller = existing
	} else {
		// Create new controller based on type
		switch controllerName {
		case BlockController_Shell, BlockController_Cmd:
			if shouldUseDurableShellController {
				controller = MakeDurableShellController(tabId, blockId, controllerName, connName)
			} else {
				controller = MakeShellController(tabId, blockId, controllerName, connName)
			}
			registerController(blockId, controller)

		case BlockController_Tsunami:
			controller = MakeTsunamiController(tabId, blockId, connName)
			registerController(blockId, controller)

		default:
			return fmt.Errorf("unknown controller type %q", controllerName)
		}
	}

	// Check if we need to start/restart
	status := controller.GetRuntimeStatus()
	if status.ShellProcStatus == Status_Init {
		// For shell/cmd, check connection status first (for non-local connections)
		if controllerName == BlockController_Shell || controllerName == BlockController_Cmd {
			if !conncontroller.IsLocalConnName(connName) {
				err = CheckConnStatus(blockId)
				if err != nil {
					return fmt.Errorf("cannot start shellproc: %w", err)
				}
			}
		}

		// Start controller
		err = controller.Start(ctx, blockData.Meta, rtOpts, force)
		if err != nil {
			return fmt.Errorf("error starting controller: %w", err)
		}
	}

	return nil
}

func GetBlockControllerRuntimeStatus(blockId string) *BlockControllerRuntimeStatus {
	controller := getController(blockId)
	if controller == nil {
		return nil
	}
	return controller.GetRuntimeStatus()
}

func DestroyBlockController(blockId string) {
	controller := getController(blockId)
	if controller == nil {
		return
	}
	controller.Stop(true, Status_Done, true)
	wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId))
	deleteController(blockId)
}

func sendConnMonitorInputNotification(controller Controller) {
	connName := controller.GetConnName()
	if connName == "" || conncontroller.IsLocalConnName(connName) || conncontroller.IsWslConnName(connName) {
		return
	}

	connOpts, parseErr := remote.ParseOpts(connName)
	if parseErr != nil {
		return
	}
	sshConn := conncontroller.MaybeGetConn(connOpts)
	if sshConn != nil {
		monitor := sshConn.GetMonitor()
		if monitor != nil {
			monitor.NotifyInput()
		}
	}
}

func SendInput(blockId string, inputUnion *BlockInputUnion) error {
	controller := getController(blockId)
	if controller == nil {
		return fmt.Errorf("no controller found for block %s", blockId)
	}
	sendConnMonitorInputNotification(controller)
	return controller.SendInput(inputUnion)
}

// only call this on shutdown
func StopAllBlockControllersForShutdown() {
	controllers := getAllControllers()
	for blockId, controller := range controllers {
		status := controller.GetRuntimeStatus()
		if status != nil && status.ShellProcStatus == Status_Running {
			go func(id string, c Controller) {
				c.Stop(true, Status_Done, false)
				wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, id))
			}(blockId, controller)
		}
	}
}

func getBoolFromMeta(meta map[string]any, key string, def bool) bool {
	ival, found := meta[key]
	if !found || ival == nil {
		return def
	}
	if val, ok := ival.(bool); ok {
		return val
	}
	return def
}

func getTermSize(bdata *waveobj.Block) waveobj.TermSize {
	if bdata.RuntimeOpts != nil {
		return bdata.RuntimeOpts.TermSize
	} else {
		return waveobj.TermSize{
			Rows: 25,
			Cols: 80,
		}
	}
}

func HandleAppendBlockFile(blockId string, blockFile string, data []byte) error {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	err := filestore.WFS.AppendData(ctx, blockId, blockFile, data)
	if err != nil {
		return fmt.Errorf("error appending to blockfile: %w", err)
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_BlockFile,
		Scopes: []string{
			waveobj.MakeORef(waveobj.OType_Block, blockId).String(),
		},
		Data: &wps.WSFileEventData{
			ZoneId:   blockId,
			FileName: blockFile,
			FileOp:   wps.FileOp_Append,
			Data64:   base64.StdEncoding.EncodeToString(data),
		},
	})
	return nil
}

func HandleTruncateBlockFile(blockId string) error {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	err := filestore.WFS.WriteFile(ctx, blockId, wavebase.BlockFile_Term, nil)
	if err == fs.ErrNotExist {
		return nil
	}
	if err != nil {
		return fmt.Errorf("error truncating blockfile: %w", err)
	}
	err = filestore.WFS.DeleteFile(ctx, blockId, wavebase.BlockFile_Cache)
	if err == fs.ErrNotExist {
		err = nil
	}
	if err != nil {
		log.Printf("error deleting cache file (continuing): %v\n", err)
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_BlockFile,
		Scopes: []string{waveobj.MakeORef(waveobj.OType_Block, blockId).String()},
		Data: &wps.WSFileEventData{
			ZoneId:   blockId,
			FileName: wavebase.BlockFile_Term,
			FileOp:   wps.FileOp_Truncate,
		},
	})
	return nil

}

func debugLog(ctx context.Context, fmtStr string, args ...interface{}) {
	blocklogger.Infof(ctx, "[conndebug] "+fmtStr, args...)
	log.Printf(fmtStr, args...)
}

func CheckConnStatus(blockId string) error {
	bdata, err := wstore.DBMustGet[*waveobj.Block](context.Background(), blockId)
	if err != nil {
		return fmt.Errorf("error getting block: %w", err)
	}
	connName := bdata.Meta.GetString(waveobj.MetaKey_Connection, "")
	if conncontroller.IsLocalConnName(connName) {
		return nil
	}
	if strings.HasPrefix(connName, "wsl://") {
		distroName := strings.TrimPrefix(connName, "wsl://")
		conn := wslconn.GetWslConn(distroName)
		connStatus := conn.DeriveConnStatus()
		if connStatus.Status != conncontroller.Status_Connected {
			return fmt.Errorf("not connected: %s", connStatus.Status)
		}
		return nil
	}
	opts, err := remote.ParseOpts(connName)
	if err != nil {
		return fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.MaybeGetConn(opts)
	if conn == nil {
		return fmt.Errorf("no connection found")
	}
	connStatus := conn.DeriveConnStatus()
	if connStatus.Status != conncontroller.Status_Connected {
		return fmt.Errorf("not connected: %s", connStatus.Status)
	}
	return nil
}

func makeSwapToken(ctx context.Context, logCtx context.Context, blockId string, blockMeta waveobj.MetaMapType, remoteName string, shellType string) *shellutil.TokenSwapEntry {
	token := &shellutil.TokenSwapEntry{
		Token: uuid.New().String(),
		Env:   make(map[string]string),
		Exp:   time.Now().Add(5 * time.Minute),
	}
	token.Env["TERM_PROGRAM"] = "waveterm"
	token.Env["WAVETERM_BLOCKID"] = blockId
	token.Env["WAVETERM_VERSION"] = wavebase.WaveVersion
	token.Env["WAVETERM"] = "1"
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		log.Printf("error finding tab for block: %v\n", err)
	} else {
		token.Env["WAVETERM_TABID"] = tabId
	}
	if tabId != "" {
		wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
		if err != nil {
			log.Printf("error finding workspace for tab: %v\n", err)
		} else {
			token.Env["WAVETERM_WORKSPACEID"] = wsId
		}
	}
	token.Env["WAVETERM_CLIENTID"] = wstore.GetClientId()
	token.Env["WAVETERM_CONN"] = remoteName
	envMap, err := resolveEnvMap(blockId, blockMeta, remoteName)
	if err != nil {
		log.Printf("error resolving env map: %v\n", err)
	}
	for k, v := range envMap {
		token.Env[k] = v
	}
	token.ScriptText = getCustomInitScript(logCtx, blockMeta, remoteName, shellType)
	return token
}
