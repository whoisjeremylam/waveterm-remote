// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/base64"
	"fmt"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const (
	agentPromptPollInterval = 100 * time.Millisecond
	agentPromptTimeout      = 5 * time.Second
)

// agentCmd is the "agent" command group, the entry point for the Agent Control
// Fabric. It exposes `spawn` (syntactic sugar over `wsh block new`) and `help`
// (discovery of all agent-capable commands).
var agentCmd = &cobra.Command{
	Use:   "agent",
	Short: "Agent control fabric commands",
	Long: `Commands for AI coding agents orchestrating Wave Terminal.

Use "wsh agent help" to discover the full set of agent-capable commands
across wsh.`,
}

var agentSpawnCmd = &cobra.Command{
	Use:   "spawn",
	Short: "Spawn an agent in a new terminal block",
	Long: `Spawn an agent process (e.g. claude, pi) in a new terminal block.

This is syntactic sugar over "wsh block new --view term --cmd". The block is
created with the given command running as a persistent process. Use --prompt to
send an initial prompt to the agent once its controller is ready. Use
--split to create the block by splitting an existing block; without
--relative-to the split is made relative to the currently focused block.`,
	Example: "  wsh agent spawn --connection prod --cmd \"claude\"\n" +
		"  wsh agent spawn --connection prod --cmd \"claude\" --prompt \"Fix the build error\"\n" +
		"  wsh agent spawn --cmd \"claude\" --split right",
	Args:                  cobra.NoArgs,
	RunE:                  agentSpawnRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var agentHelpCmd = &cobra.Command{
	Use:   "help",
	Short: "List agent-capable commands",
	Long: `Print a static reference of every agent-capable command in wsh, with a
one-line description and a short example each. Intended for discovery: an
agent that starts here can pattern-match onto the commands it needs.`,
	Args: cobra.NoArgs,
	RunE: agentHelpRun,
}

var (
	agentSpawnConnection string
	agentSpawnCmdStr     string
	agentSpawnPrompt     string
	agentSpawnSplit      string
	agentSpawnRelativeTo string
	agentSpawnJSON       bool
)

func init() {
	agentSpawnCmd.Flags().StringVar(&agentSpawnConnection, "connection", "", "connection name to attach the block to")
	agentSpawnCmd.Flags().StringVar(&agentSpawnCmdStr, "cmd", "", "agent command to run in the block (required)")
	agentSpawnCmd.Flags().StringVar(&agentSpawnPrompt, "prompt", "", "prompt text to send to the spawned agent")
	agentSpawnCmd.Flags().StringVar(&agentSpawnSplit, "split", "", "split direction: left, right, above, below (defaults to relative to the focused block)")
	agentSpawnCmd.Flags().StringVar(&agentSpawnRelativeTo, "relative-to", "", "block reference to split (requires --split)")
	agentSpawnCmd.Flags().BoolVar(&agentSpawnJSON, "json", false, "output as JSON")

	agentCmd.AddCommand(agentSpawnCmd)
	agentCmd.AddCommand(agentHelpCmd)
	rootCmd.AddCommand(agentCmd)
}

func agentSpawnRun(cmd *cobra.Command, args []string) error {
	if agentSpawnCmdStr == "" {
		return fmt.Errorf("--cmd is required (the agent command to run)")
	}

	// Resolve the focused block only when needed: --split without --relative-to
	// defaults to splitting relative to the currently focused block.
	focusedBlockId := ""
	if agentSpawnSplit != "" && agentSpawnRelativeTo == "" {
		focused, err := getFocusedBlockId()
		if err != nil {
			return err
		}
		focusedBlockId = focused
	}

	relativeTo, err := resolveAgentSplitRelativeTo(agentSpawnSplit, agentSpawnRelativeTo, focusedBlockId)
	if err != nil {
		return err
	}

	oref, err := createBlockNew(blockNewOptions{
		viewType:   "term",
		connection: agentSpawnConnection,
		cmd:        agentSpawnCmdStr,
		magnified:  false,
		split:      agentSpawnSplit,
		relativeTo: relativeTo,
		tabRef:     "",
	})
	if err != nil {
		return err
	}

	if agentSpawnPrompt != "" {
		if err := sendPromptToBlock(oref.OID, agentSpawnPrompt); err != nil {
			return err
		}
	}

	return writeBlockNewOutput(oref, agentSpawnJSON)
}

// resolveAgentSplitRelativeTo returns the effective relative-to block reference
// for a split. It enforces the same pairing rules as validateSplitPair, with one
// exception: a --split given without --relative-to defaults to focusedBlockId
// (the focused block). focusedBlockId is empty when no focused block was
// resolved, which is an error for that case.
func resolveAgentSplitRelativeTo(split, relativeTo, focusedBlockId string) (string, error) {
	if split == "" && relativeTo == "" {
		return "", nil
	}
	if split == "" && relativeTo != "" {
		return "", fmt.Errorf("--relative-to requires --split")
	}
	if relativeTo != "" {
		return relativeTo, nil
	}
	// split != "" && relativeTo == ""
	if focusedBlockId == "" {
		return "", fmt.Errorf("--split requires --relative-to (no focused block available)")
	}
	return focusedBlockId, nil
}

// getFocusedBlockId returns the block id of the currently focused block via the
// getfocusedblockdata RPC. That RPC is handled by the frontend (tab) client, so
// it must be routed to the current tab.
func getFocusedBlockId() (string, error) {
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return "", fmt.Errorf("no tab id specified (set WAVETERM_TABID environment variable)")
	}
	focused, err := wshclient.GetFocusedBlockDataCommand(RpcClient, &wshrpc.RpcOpts{
		Route:   fmt.Sprintf("tab:%s", tabId),
		Timeout: 2000,
	})
	if err != nil {
		return "", fmt.Errorf("getting focused block: %w", err)
	}
	if focused == nil || focused.BlockId == "" {
		return "", fmt.Errorf("no focused block (use --relative-to to specify one)")
	}
	return focused.BlockId, nil
}

// assemblePromptInput appends the Enter key (0x0d) to the prompt text so the
// agent's REPL actually executes the prompt.
func assemblePromptInput(prompt string) string {
	return prompt + "\r"
}

// sendPromptToBlock waits for the block controller to reach the "running" state
// and then sends the prompt (plus Enter) to the block. Polling is required
// because the block's controller may not be ready immediately after
// createBlockNew returns; sending input too early fails with "no controller
// found for block <id>".
func sendPromptToBlock(blockId, prompt string) error {
	deadline := time.Now().Add(agentPromptTimeout)
	for {
		status, err := wshclient.BlockControllerStatusCommand(RpcClient, blockId, &wshrpc.RpcOpts{Timeout: 2000})
		if err == nil && status != nil {
			if status.ShellProcStatus == "running" {
				break
			}
			if status.ShellProcStatus == "done" {
				return fmt.Errorf("block %s controller exited before the prompt could be sent (exit code %d)", blockId, status.ShellProcExitCode)
			}
		}
		if time.Now().After(deadline) {
			lastStatus := "unknown"
			if status != nil {
				lastStatus = status.ShellProcStatus
			}
			return fmt.Errorf("timed out waiting for block %s controller to start (last status: %s)", blockId, lastStatus)
		}
		time.Sleep(agentPromptPollInterval)
	}

	input := assemblePromptInput(prompt)
	err := wshclient.ControllerInputCommand(RpcClient, wshrpc.CommandBlockInputData{
		BlockId:     blockId,
		InputData64: base64.StdEncoding.EncodeToString([]byte(input)),
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("sending prompt to block %s: %w", blockId, err)
	}
	return nil
}

// agentHelpText is the static discovery text printed by `wsh agent help`. It is
// pure static output: no RPC is made.
const agentHelpText = `Agent Control Fabric — agent-capable commands
============================================

WAVE_TERMINAL=1 is set in every Wave Terminal session; agents can detect
Wave Terminal by checking for that environment variable.

Block control (tmux-style, asynchronous)
----------------------------------------
wsh block list                          List blocks (workspaces/windows); --json includes geometry
wsh block capture <block_ref> --tail N  Capture terminal scrollback; --json, --last-command, --output
wsh block send-keys <block_ref> "text"  Send keystrokes; --enter, --escapes, --secret
wsh block status <block_ref> --json     Process + connection status of a block
wsh block split <block_ref> --direction left|right|above|below
wsh block new --view term --connection <conn> --cmd "..." --split right --relative-to <ref>
wsh block rename <block_ref> <name>     Rename a block (find it by title later)
wsh block select <block_ref>            Focus a block (alias: focus)
wsh block kill <block_ref> --force      Delete a block

Synchronous execution
---------------------
wsh run --wait --json -- <cmd>          Run a command; print stdout/stderr/exitcode/duration
wsh run --wait --json --connection <conn> -- <cmd>

Configuration
-------------
wsh config get <key> --json             Read a config value
wsh config list --json                  List all config keys with types
wsh config set <key> <value>            Set a config value

Ask the user
------------
wsh prompt "Deploy to production?" --options "yes,no"   Modal prompt; answer on stdout

Agent orchestration
-------------------
wsh agent spawn --connection prod --cmd "claude"
wsh agent spawn --connection prod --cmd "claude" --prompt "Fix the build error"
wsh agent spawn --cmd "claude" --split right   # relative to the focused block by default

Connections
-----------
wsh connection list --json              List connections and their status

tmux aliases (same commands, tmux vocabulary)
---------------------------------------------
wsh capture-pane    -> wsh block capture
wsh send-keys       -> wsh block send-keys
wsh split-pane      -> wsh block split
wsh select-pane     -> wsh block select
wsh kill-pane       -> wsh block kill
wsh rename-pane     -> wsh block rename
wsh list-panes      -> wsh block list
`

func agentHelpRun(cmd *cobra.Command, args []string) error {
	WriteStdout("%s", agentHelpText)
	return nil
}
