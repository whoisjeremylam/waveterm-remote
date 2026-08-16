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

The block reference defaults to "this" when omitted. Directional addressing
(--left-of/--right-of/--above/--below) focuses the block geometrically adjacent
to a reference block, computed server-side from the tab layout. This is the
singular "block" counterpart to the legacy "focusblock" command.`,
	Aliases:               []string{"focus"},
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  blockSelectRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var (
	blockSelectLeftOf  string
	blockSelectRightOf string
	blockSelectAboveOf string
	blockSelectBelowOf string
)

func init() {
	addDirectionalFlags(blockSelectCmd)
	blockCmd.AddCommand(blockSelectCmd)
}

// addDirectionalFlags registers the directional addressing flags on cmd. It is
// shared between "block select" and the top-level "select-pane" alias, which
// both delegate to blockSelectRun.
func addDirectionalFlags(cmd *cobra.Command) {
	cmd.Flags().StringVar(&blockSelectLeftOf, "left-of", "", "focus the block to the left of <block_ref>")
	cmd.Flags().StringVar(&blockSelectRightOf, "right-of", "", "focus the block to the right of <block_ref>")
	cmd.Flags().StringVar(&blockSelectAboveOf, "above", "", "focus the block above <block_ref>")
	cmd.Flags().StringVar(&blockSelectBelowOf, "below", "", "focus the block below <block_ref>")
}

// validateSelectAddressing enforces that `block select` uses exactly one
// addressing form: a positional block reference or a single directional flag.
// It returns the directional form (direction + base reference) when a
// directional flag is set, or empty strings when the positional form (or the
// default "this") applies.
func validateSelectAddressing(leftOf, rightOf, aboveOf, belowOf, positional string) (direction string, baseRef string, err error) {
	type form struct {
		direction string
		ref       string
	}
	var forms []form
	appendForm := func(dir, ref string) {
		if ref != "" {
			forms = append(forms, form{dir, ref})
		}
	}
	appendForm("left", leftOf)
	appendForm("right", rightOf)
	appendForm("above", aboveOf)
	appendForm("below", belowOf)
	appendForm("", positional)

	if len(forms) > 1 {
		return "", "", fmt.Errorf("block select accepts exactly one addressing form: a positional block reference or one of --left-of/--right-of/--above/--below")
	}
	if len(forms) == 0 || forms[0].direction == "" {
		// No form given (defaults to "this") or a positional reference.
		return "", "", nil
	}
	return forms[0].direction, forms[0].ref, nil
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

	direction, baseRef, err := validateSelectAddressing(blockSelectLeftOf, blockSelectRightOf, blockSelectAboveOf, blockSelectBelowOf, blockRef)
	if err != nil {
		return err
	}

	var targetOID string
	if direction != "" {
		baseORef, err := resolveBlockArgWithOverride(baseRef)
		if err != nil {
			return err
		}
		oref, err := wshclient.ResolveDirectionalCommand(RpcClient, wshrpc.CommandResolveDirectionalData{
			BlockId:   baseORef.OID,
			Direction: direction,
		}, &wshrpc.RpcOpts{Timeout: 2000})
		if err != nil {
			return fmt.Errorf("resolving directional block: %w", err)
		}
		targetOID = oref.OID
	} else {
		fullORef, err := resolveBlockArgWithOverride(blockRef)
		if err != nil {
			return err
		}
		targetOID = fullORef.OID
	}

	route := fmt.Sprintf("tab:%s", tabId)
	err = wshclient.SetBlockFocusCommand(RpcClient, targetOID, &wshrpc.RpcOpts{
		Route:   route,
		Timeout: 2000,
	})
	if err != nil {
		return fmt.Errorf("focusing block: %v", err)
	}
	return nil
}
