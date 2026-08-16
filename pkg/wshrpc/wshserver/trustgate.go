// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// originConnName returns the connection name the RPC request originated from
// ("" if unknown). The origin connection is the connection the invoking `wsh`
// runs on: empty/"local" for local, the SSH host name for remote.
func originConnName(ctx context.Context) string {
	handler := wshutil.GetRpcResponseHandlerFromContext(ctx)
	if handler != nil {
		return handler.GetRpcContext().Conn
	}
	wshRpc := wshutil.GetWshRpcFromContext(ctx)
	if wshRpc != nil {
		return wshRpc.GetRpcContext().Conn
	}
	return ""
}

// isRemoteOrigin reports whether the origin connection is a remote (SSH)
// connection. WSL and local/empty origins are treated as local-origin for the
// trust gate.
func isRemoteOrigin(connName string) bool {
	return !conncontroller.IsLocalConnName(connName) && !conncontroller.IsWslConnName(connName) && connName != ""
}

// shouldAllowRemoteLocalControl is the pure decision function for the trust
// gate. It returns true unless the request originates from a remote (SSH)
// connection, targets the local connection, and the allow setting is false.
func shouldAllowRemoteLocalControl(originConn, targetConn string, allowSetting bool) bool {
	if !isRemoteOrigin(originConn) {
		return true
	}
	if !conncontroller.IsLocalConnName(targetConn) {
		return true
	}
	return allowSetting
}

// checkRemoteToLocalControl rejects the request if it originates from a remote
// connection and targets the local connection, unless agent:allowremotelocalcontrol
// is enabled.
func checkRemoteToLocalControl(ctx context.Context, targetConnName string) error {
	origin := originConnName(ctx)
	allowSetting := wconfig.GetWatcher().GetFullConfig().Settings.AgentAllowRemoteLocalControl
	if shouldAllowRemoteLocalControl(origin, targetConnName, allowSetting) {
		return nil
	}
	return fmt.Errorf("remote-to-local control is disabled (set agent:allowremotelocalcontrol to enable)")
}

// getBlockConnName loads the block and returns the connection it runs on ("" means local).
func getBlockConnName(ctx context.Context, blockId string) (string, error) {
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return "", err
	}
	return block.Meta.GetString(waveobj.MetaKey_Connection, ""), nil
}
