// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var connectionCmd = &cobra.Command{
	Use:     "connection",
	Aliases: []string{"connections"},
	Short:   "manage Wave Terminal connections",
	Long:    "Commands to manage Wave Terminal SSH and WSL connections",
}

var connectionListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "list connections and their status",
	Args:    cobra.NoArgs,
	RunE:    connectionListRun,
	PreRunE: preRunSetupRpcClient,
}

var connectionConnectCmd = &cobra.Command{
	Use:     "connect CONNECTION",
	Short:   "connect to a connection",
	Args:    cobra.ExactArgs(1),
	RunE:    connectionConnectRun,
	PreRunE: preRunSetupRpcClient,
}

var connectionDisconnectCmd = &cobra.Command{
	Use:     "disconnect CONNECTION",
	Short:   "disconnect a connection",
	Args:    cobra.ExactArgs(1),
	RunE:    connectionDisconnectRun,
	PreRunE: preRunSetupRpcClient,
}

var connectionListJSON bool

func init() {
	connectionListCmd.Flags().BoolVar(&connectionListJSON, "json", false, "output as JSON")
	connectionCmd.AddCommand(connectionListCmd)
	connectionCmd.AddCommand(connectionConnectCmd)
	connectionCmd.AddCommand(connectionDisconnectCmd)
	rootCmd.AddCommand(connectionCmd)
}

// connectionListEntry is the JSON shape for a single `wsh connection list --json` row.
type connectionListEntry struct {
	Name       string `json:"name"`
	Connected  bool   `json:"connected"`
	Status     string `json:"status"`
	WshEnabled bool   `json:"wshenabled"`
	Error      string `json:"error,omitempty"`
}

// connectionEntryFromStatus maps a raw ConnStatus into the clean,
// agent-friendly list entry subset.
func connectionEntryFromStatus(conn wshrpc.ConnStatus) connectionListEntry {
	return connectionListEntry{
		Name:       conn.Connection,
		Connected:  conn.Connected,
		Status:     conn.Status,
		WshEnabled: conn.WshEnabled,
		Error:      conn.Error,
	}
}

func connectionListRun(cmd *cobra.Command, args []string) error {
	// getAllConnStatus merges SSH (ConnStatusCommand) and WSL (WslStatusCommand)
	// status, matching the existing `wsh conn status` behavior.
	allResp, err := getAllConnStatus()
	if err != nil {
		return fmt.Errorf("getting connection status: %w", err)
	}
	entries := make([]connectionListEntry, 0, len(allResp))
	for _, conn := range allResp {
		entries = append(entries, connectionEntryFromStatus(conn))
	}

	if connectionListJSON {
		barr, err := json.MarshalIndent(entries, "", "  ")
		if err != nil {
			return fmt.Errorf("marshaling connection list: %w", err)
		}
		WriteStdout("%s\n", string(barr))
		return nil
	}

	if len(entries) == 0 {
		WriteStdout("no connections\n")
		return nil
	}
	WriteStdout("%-30s %-12s %s\n", "NAME", "CONNECTED", "STATUS")
	for _, e := range entries {
		str := fmt.Sprintf("%-30s %-12v %s", e.Name, e.Connected, e.Status)
		if e.Error != "" {
			str += fmt.Sprintf(" (%s)", e.Error)
		}
		WriteStdout("%s\n", str)
	}
	return nil
}

func connectionConnectRun(cmd *cobra.Command, args []string) error {
	connName := args[0]
	if err := validateConnectionName(connName); err != nil {
		return err
	}
	data := wshrpc.ConnRequest{
		Host:       connName,
		LogBlockId: RpcContext.BlockId,
	}
	err := wshclient.ConnConnectCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 60000})
	if err != nil {
		return fmt.Errorf("connecting connection: %w", err)
	}
	WriteStdout("connected connection %q\n", connName)
	return nil
}

func connectionDisconnectRun(cmd *cobra.Command, args []string) error {
	connName := args[0]
	if err := validateConnectionName(connName); err != nil {
		return err
	}
	err := wshclient.ConnDisconnectCommand(RpcClient, connName, &wshrpc.RpcOpts{Timeout: 10000})
	if err != nil {
		return fmt.Errorf("disconnecting %q error: %w", connName, err)
	}
	WriteStdout("disconnected %q\n", connName)
	return nil
}
