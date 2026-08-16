// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var blockKillCmd = &cobra.Command{
	Use:   "kill <block_ref> [--force]",
	Short: "Delete a block",
	Long: `Delete the referenced block.

The block reference defaults to "this" when omitted. This is the singular
"block" counterpart to the legacy "deleteblock" command. The --force flag is
reserved for forward compatibility.`,
	Aliases:               []string{"close"},
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  blockKillRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var blockKillForce bool

func init() {
	addKillFlags(blockKillCmd)
	blockCmd.AddCommand(blockKillCmd)
}

// addKillFlags registers the kill command flags on cmd. It is shared between
// "block kill" and the top-level "kill-pane" alias.
func addKillFlags(cmd *cobra.Command) {
	cmd.Flags().BoolVar(&blockKillForce, "force", false, "force deletion (reserved; the backend currently always deletes)")
}

func blockKillRun(cmd *cobra.Command, args []string) error {
	blockRef := ""
	if len(args) > 0 {
		blockRef = args[0]
	}
	fullORef, err := resolveBlockArgWithOverride(blockRef)
	if err != nil {
		return err
	}
	if fullORef.OType != "block" {
		return fmt.Errorf("object reference is not a block")
	}
	deleteBlockData := &wshrpc.CommandDeleteBlockData{
		BlockId: fullORef.OID,
	}
	err = wshclient.DeleteBlockCommand(RpcClient, *deleteBlockData, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("delete block failed: %v", err)
	}
	WriteStdout("block deleted\n")
	return nil
}
