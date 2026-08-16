// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"github.com/spf13/cobra"
)

// blockListCmd is the singular "block list" command. It delegates to the
// existing "blocks list" logic (blocksListRun) and shares the same flags.
var blockListCmd = &cobra.Command{
	Use:   "list",
	Short: "List blocks in workspaces/windows",
	Long: `List blocks with optional filtering by workspace, window, tab, or view type.

This is the singular "block" counterpart to "blocks list". --connection and
--tab <tab_ref> filters, plus block geometry, arrive in a later phase.`,
	RunE:         blocksListRun,
	PreRunE:      preRunSetupRpcClient,
	SilenceUsage: true,
}

func init() {
	addBlockListFlags(blockListCmd)
	blockCmd.AddCommand(blockListCmd)
}
