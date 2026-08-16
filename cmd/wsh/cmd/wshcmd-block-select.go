// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var blockSelectCmd = &cobra.Command{
	Use:   "select <block_ref>",
	Short: "Focus a block in the current tab",
	Long: `Focus the referenced block in the current tab.

The block reference defaults to "this" when omitted. This is the singular
"block" counterpart to the legacy "focusblock" command.`,
	Aliases:               []string{"focus"},
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  blockSelectRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

func init() {
	blockCmd.AddCommand(blockSelectCmd)
}

func blockSelectRun(cmd *cobra.Command, args []string) error {
	tabId := os.Getenv("WAVETERM_TABID")
	if tabId == "" {
		return fmt.Errorf("no tab id specified (set WAVETERM_TABID environment variable)")
	}

	blockRef := ""
	if len(args) > 0 {
		blockRef = args[0]
	}
	fullORef, err := resolveBlockArgWithOverride(blockRef)
	if err != nil {
		return err
	}

	route := fmt.Sprintf("tab:%s", tabId)
	err = wshclient.SetBlockFocusCommand(RpcClient, fullORef.OID, &wshrpc.RpcOpts{
		Route:   route,
		Timeout: 2000,
	})
	if err != nil {
		return fmt.Errorf("focusing block: %v", err)
	}
	return nil
}
