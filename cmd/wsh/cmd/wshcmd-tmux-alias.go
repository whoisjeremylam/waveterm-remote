// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"github.com/spf13/cobra"
)

// Top-level tmux-parity aliases. Agents trained on tmux can pattern-match
// these noun/verb pairs immediately; each is a thin wrapper delegating to the
// canonical "wsh block <verb>" form (sharing the same RunE and flags).

var capturePaneCmd = &cobra.Command{
	Use:   "capture-pane [block_ref]",
	Short: "Capture terminal scrollback from a block",
	Long: `Capture the terminal scrollback from a terminal block (tmux-parity alias).

This is a thin wrapper over "wsh block capture"; it shares the same flags and
behavior. See "wsh block capture --help" for details.`,
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  blockCaptureRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var sendKeysCmd = &cobra.Command{
	Use:   "send-keys <block_ref> [text]",
	Short: "Send keystrokes to a terminal block",
	Long: `Send keystrokes to a terminal block as if typed (tmux-parity alias).

This is a thin wrapper over "wsh block send-keys"; it shares the same flags
and behavior. See "wsh block send-keys --help" for details.`,
	Args:                  cobra.MaximumNArgs(2),
	RunE:                  blockSendKeysRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var splitPaneCmd = &cobra.Command{
	Use:   "split-pane <block_ref> --direction left|right|above|below",
	Short: "Create a new block by splitting an existing block",
	Long: `Create a new block by splitting an existing block (tmux-parity alias).

This is a thin wrapper over "wsh block split". Like that command it requires
exactly one block reference and a --direction; it does not invent tmux-style
defaults. See "wsh block split --help" for details.`,
	Args:                  cobra.ExactArgs(1),
	RunE:                  blockSplitRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var selectPaneCmd = &cobra.Command{
	Use:   "select-pane [block_ref]",
	Short: "Focus a block in the current tab",
	Long: `Focus the referenced block in the current tab (tmux-parity alias).

This is a thin wrapper over "wsh block select"; it shares the same behavior.
The block reference defaults to "this" when omitted.`,
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  blockSelectRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var killPaneCmd = &cobra.Command{
	Use:   "kill-pane <block_ref> [--force]",
	Short: "Delete a block",
	Long: `Delete the referenced block (tmux-parity alias).

This is a thin wrapper over "wsh block kill"; it shares the same flags and
behavior. See "wsh block kill --help" for details.`,
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  blockKillRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var renamePaneCmd = &cobra.Command{
	Use:   "rename-pane <block_ref> <name>",
	Short: "Rename a block",
	Long: `Set a block's title (frame:title) so it can be found by name later
(tmux-parity alias).

This is a thin wrapper over "wsh block rename"; it shares the same behavior.
See "wsh block rename --help" for details.`,
	Args:                  cobra.ExactArgs(2),
	RunE:                  blockRenameRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var listPanesCmd = &cobra.Command{
	Use:   "list-panes",
	Short: "List blocks in workspaces/windows",
	Long: `List blocks with optional filtering by workspace, window, tab, or view type
(tmux-parity alias).

This is a thin wrapper over "wsh block list"; it shares the same flags and
behavior. See "wsh block list --help" for details.`,
	RunE:         blocksListRun,
	PreRunE:      preRunSetupRpcClient,
	SilenceUsage: true,
}

func init() {
	addCaptureFlags(capturePaneCmd)
	addSendKeysFlags(sendKeysCmd)
	addSplitFlags(splitPaneCmd)
	addKillFlags(killPaneCmd)
	addBlockListFlags(listPanesCmd)

	rootCmd.AddCommand(capturePaneCmd)
	rootCmd.AddCommand(sendKeysCmd)
	rootCmd.AddCommand(splitPaneCmd)
	rootCmd.AddCommand(selectPaneCmd)
	rootCmd.AddCommand(killPaneCmd)
	rootCmd.AddCommand(renamePaneCmd)
	rootCmd.AddCommand(listPanesCmd)
}
