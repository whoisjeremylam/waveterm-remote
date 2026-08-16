// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import "testing"

func TestShouldAllowRemoteLocalControl(t *testing.T) {
	tests := []struct {
		name         string
		originConn   string
		targetConn   string
		allowSetting bool
		want         bool
	}{
		// Test 28: local origin targeting local, setting off → allowed (gate is a no-op).
		{name: "local origin targets local, off", originConn: "", targetConn: "", allowSetting: false, want: true},
		{name: "local origin \"local\" targets local, off", originConn: "local", targetConn: "", allowSetting: false, want: true},
		{name: "local origin targets local:* , off", originConn: "local", targetConn: "local:foo", allowSetting: false, want: true},

		// Test 26: remote origin targeting local, setting off → denied.
		{name: "remote origin targets local, off", originConn: "host1", targetConn: "", allowSetting: false, want: false},
		{name: "remote origin targets local:* , off", originConn: "host1", targetConn: "local:foo", allowSetting: false, want: false},

		// Test 27: remote origin targeting local, setting on → allowed.
		{name: "remote origin targets local, on", originConn: "host1", targetConn: "", allowSetting: true, want: true},

		// Remote origin targeting remote → allowed regardless of setting.
		{name: "remote origin targets remote, off", originConn: "host1", targetConn: "host2", allowSetting: false, want: true},

		// WSL origin targeting local → allowed (WSL counts as local-origin).
		{name: "wsl origin targets local, off", originConn: "wsl://Ubuntu", targetConn: "", allowSetting: false, want: true},

		// Empty origin targeting local → allowed (unknown origin treated as local).
		{name: "empty origin targets local, off", originConn: "", targetConn: "", allowSetting: false, want: true},

		// Remote origin targeting wsl → allowed (wsl is not the local connection).
		{name: "remote origin targets wsl, off", originConn: "host1", targetConn: "wsl://Ubuntu", allowSetting: false, want: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldAllowRemoteLocalControl(tc.originConn, tc.targetConn, tc.allowSetting)
			if got != tc.want {
				t.Fatalf("shouldAllowRemoteLocalControl(%q, %q, %v) = %v, want %v", tc.originConn, tc.targetConn, tc.allowSetting, got, tc.want)
			}
		})
	}
}

func TestIsRemoteOrigin(t *testing.T) {
	tests := []struct {
		name     string
		connName string
		want     bool
	}{
		{name: "empty", connName: "", want: false},
		{name: "local", connName: "local", want: false},
		{name: "local prefix", connName: "local:foo", want: false},
		{name: "wsl", connName: "wsl://Ubuntu", want: false},
		{name: "remote ssh host", connName: "host1", want: true},
		{name: "remote ssh conn string", connName: "user@host1:22", want: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isRemoteOrigin(tc.connName)
			if got != tc.want {
				t.Fatalf("isRemoteOrigin(%q) = %v, want %v", tc.connName, got, tc.want)
			}
		})
	}
}
