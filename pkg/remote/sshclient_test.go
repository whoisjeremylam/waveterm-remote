// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package remote

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func TestIsPermanentConnError(t *testing.T) {
	t.Parallel()

	permanent := []string{
		ConnErrCode_HostKeyChanged,
		ConnErrCode_HostKeyRevoked,
		ConnErrCode_HostKeyVerify,
		ConnErrCode_KnownHostsNone,
		ConnErrCode_KnownHostsFmt,
		ConnErrCode_ConfigParse,
		ConnErrCode_ConfigDefault,
		ConnErrCode_ProxyDepth,
		ConnErrCode_ProxyParse,
	}
	for _, code := range permanent {
		t.Run(code, func(t *testing.T) {
			t.Parallel()
			if !IsPermanentConnError(code) {
				t.Fatalf("expected IsPermanentConnError(%q)=true", code)
			}
		})
	}

	transient := []string{
		ConnErrCode_Dial,
		ConnErrCode_AuthFailed,
		ConnErrCode_UserCancelled,
		ConnErrCode_UserTimeout,
		ConnErrCode_Unknown,
		"",
	}
	for _, code := range transient {
		t.Run("not_"+code, func(t *testing.T) {
			t.Parallel()
			if IsPermanentConnError(code) {
				t.Fatalf("expected IsPermanentConnError(%q)=false", code)
			}
		})
	}
}

func TestContextWithCachedPassword(t *testing.T) {
	t.Parallel()

	t.Run("nil password returns same context", func(t *testing.T) {
		t.Parallel()
		ctx := context.Background()
		result := ContextWithCachedPassword(ctx, nil)
		if result != ctx {
			t.Error("expected same context for nil password")
		}
	})

	t.Run("stores password in context", func(t *testing.T) {
		t.Parallel()
		pw := "secret123"
		ctx := ContextWithCachedPassword(context.Background(), &pw)
		got := GetCachedPassword(ctx)
		if got == nil {
			t.Fatal("expected non-nil password")
		}
		if *got != "secret123" {
			t.Errorf("expected 'secret123', got %q", *got)
		}
	})

	t.Run("returns nil when no password in context", func(t *testing.T) {
		t.Parallel()
		got := GetCachedPassword(context.Background())
		if got != nil {
			t.Errorf("expected nil, got %q", *got)
		}
	})
}

func TestAuthTracker(t *testing.T) {
	t.Parallel()

	t.Run("initial state", func(t *testing.T) {
		t.Parallel()
		tracker := &AuthTracker{}
		if tracker.PasswordUsed {
			t.Error("expected PasswordUsed to be false initially")
		}
		if tracker.Password != "" {
			t.Errorf("expected empty Password, got %q", tracker.Password)
		}
	})

	t.Run("tracks password usage", func(t *testing.T) {
		t.Parallel()
		tracker := &AuthTracker{}
		tracker.Password = "mypass"
		tracker.PasswordUsed = true

		if !tracker.PasswordUsed {
			t.Error("expected PasswordUsed to be true")
		}
		if tracker.Password != "mypass" {
			t.Errorf("expected 'mypass', got %q", tracker.Password)
		}
		// password from secret/store is replayable — not an interactive prompt
		if tracker.InteractivePromptUsed() {
			t.Error("expected InteractivePromptUsed to be false for replayed password")
		}
	})

	t.Run("password from prompt is interactive", func(t *testing.T) {
		t.Parallel()
		tracker := &AuthTracker{}
		tracker.Password = "mypass"
		tracker.PasswordUsed = true
		tracker.PasswordFromPrompt = true
		if !tracker.InteractivePromptUsed() {
			t.Error("expected InteractivePromptUsed to be true for user-typed password")
		}
	})

	t.Run("passphrase prompt is interactive", func(t *testing.T) {
		t.Parallel()
		tracker := &AuthTracker{}
		tracker.PassphrasePrompted = true
		if !tracker.InteractivePromptUsed() {
			t.Error("expected InteractivePromptUsed to be true for passphrase prompt")
		}
	})

	t.Run("keyboard-interactive is interactive", func(t *testing.T) {
		t.Parallel()
		tracker := &AuthTracker{}
		tracker.KbdInteractiveUsed = true
		if !tracker.InteractivePromptUsed() {
			t.Error("expected InteractivePromptUsed to be true for keyboard-interactive")
		}
	})

	t.Run("nil tracker is safe", func(t *testing.T) {
		t.Parallel()
		var tracker *AuthTracker
		if tracker.InteractivePromptUsed() {
			t.Error("expected nil tracker to report no interactive prompt")
		}
	})
}

func TestClassifyConnError_HandshakeFailedIsDialNotAuth(t *testing.T) {
	t.Parallel()
	code, sub := ClassifyConnError(fmt.Errorf("ssh: handshake failed: read tcp 1.2.3.4:22: connection reset by peer"))
	if code != ConnErrCode_Dial {
		t.Fatalf("expected dial-error for handshake failed IO, got %q/%q", code, sub)
	}
	if IsCredentialRejected(code, sub) {
		t.Fatal("handshake failed must not be credential rejection")
	}
}

func TestClassifyConnError_UnableToAuthIsCredentialRejected(t *testing.T) {
	t.Parallel()
	code, sub := ClassifyConnError(fmt.Errorf("ssh: unable to authenticate, attempted methods [none password]"))
	if code != ConnErrCode_AuthFailed || sub != AuthSubCode_UnableToAuth {
		t.Fatalf("expected auth-failed/unable-to-auth, got %q/%q", code, sub)
	}
	if !IsCredentialRejected(code, sub) {
		t.Fatal("expected IsCredentialRejected")
	}
}

func TestIsCredentialRejected(t *testing.T) {
	t.Parallel()
	if !IsCredentialRejected(ConnErrCode_AuthFailed, AuthSubCode_UnableToAuth) {
		t.Fatal("expected true for unable-to-auth")
	}
	if IsCredentialRejected(ConnErrCode_AuthFailed, AuthSubCode_HandshakeFailed) {
		t.Fatal("handshake-failed subcode alone must not reject credentials")
	}
	if IsCredentialRejected(ConnErrCode_Dial, AuthSubCode_HandshakeFailed) {
		t.Fatal("dial+handshake-failed must not reject credentials")
	}
}

func TestMergeKeywords_ForwardingMerge(t *testing.T) {
	t.Parallel()

	t.Run("localforward appends new to old preserving order", func(t *testing.T) {
		t.Parallel()
		localA := wconfig.PortForwardRule{Rule: "8080 localhost:80", Source: wconfig.PortForwardSourceSshConfig}
		localB := wconfig.PortForwardRule{Rule: "9090 localhost:90", Note: "Postgres", Source: wconfig.PortForwardSourceConnections}
		old := &wconfig.ConnKeywords{SshLocalForward: []wconfig.PortForwardRule{localA}}
		new := &wconfig.ConnKeywords{SshLocalForward: []wconfig.PortForwardRule{localB}}
		got := mergeKeywords(old, new)
		want := []wconfig.PortForwardRule{localA, localB}
		if !reflect.DeepEqual(got.SshLocalForward, want) {
			t.Errorf("expected %v, got %v", want, got.SshLocalForward)
		}
	})

	t.Run("remoteforward appends new to old", func(t *testing.T) {
		t.Parallel()
		remoteA := wconfig.PortForwardRule{Rule: "9090 localhost:3000", Source: wconfig.PortForwardSourceSshConfig}
		remoteB := wconfig.PortForwardRule{Rule: "9999 localhost:9000", Source: wconfig.PortForwardSourceConnections}
		old := &wconfig.ConnKeywords{SshRemoteForward: []wconfig.PortForwardRule{remoteA}}
		new := &wconfig.ConnKeywords{SshRemoteForward: []wconfig.PortForwardRule{remoteB}}
		got := mergeKeywords(old, new)
		want := []wconfig.PortForwardRule{remoteA, remoteB}
		if !reflect.DeepEqual(got.SshRemoteForward, want) {
			t.Errorf("expected %v, got %v", want, got.SshRemoteForward)
		}
	})

	t.Run("nil new preserves old", func(t *testing.T) {
		t.Parallel()
		old := &wconfig.ConnKeywords{
			SshLocalForward:  []wconfig.PortForwardRule{{Rule: "8080 localhost:80", Source: wconfig.PortForwardSourceSshConfig}},
			SshRemoteForward: []wconfig.PortForwardRule{{Rule: "9090 localhost:3000", Source: wconfig.PortForwardSourceSshConfig}},
		}
		new := &wconfig.ConnKeywords{}
		got := mergeKeywords(old, new)
		if !reflect.DeepEqual(got.SshLocalForward, old.SshLocalForward) {
			t.Errorf("expected localforward %v, got %v", old.SshLocalForward, got.SshLocalForward)
		}
		if !reflect.DeepEqual(got.SshRemoteForward, old.SshRemoteForward) {
			t.Errorf("expected remoteforward %v, got %v", old.SshRemoteForward, got.SshRemoteForward)
		}
	})

	t.Run("note enabled and source survive merge", func(t *testing.T) {
		t.Parallel()
		enabled := false
		old := &wconfig.ConnKeywords{SshLocalForward: []wconfig.PortForwardRule{{Rule: "8080 localhost:80", Source: wconfig.PortForwardSourceSshConfig}}}
		new := &wconfig.ConnKeywords{SshLocalForward: []wconfig.PortForwardRule{{Rule: "9090 localhost:90", Note: "web", Enabled: &enabled, Source: wconfig.PortForwardSourceConnections}}}
		got := mergeKeywords(old, new)
		if len(got.SshLocalForward) != 2 {
			t.Fatalf("expected 2 rules, got %d", len(got.SshLocalForward))
		}
		gotNew := got.SshLocalForward[1]
		if gotNew.Note != "web" {
			t.Errorf("expected note %q, got %q", "web", gotNew.Note)
		}
		if gotNew.Enabled == nil || *gotNew.Enabled {
			t.Errorf("expected enabled=false, got %v", gotNew.Enabled)
		}
		if gotNew.Source != wconfig.PortForwardSourceConnections {
			t.Errorf("expected source %q, got %q", wconfig.PortForwardSourceConnections, gotNew.Source)
		}
	})

	t.Run("append does not mutate old backing array", func(t *testing.T) {
		t.Parallel()
		// Give old extra capacity so an in-place append would leak into it.
		old := &wconfig.ConnKeywords{SshLocalForward: append([]wconfig.PortForwardRule{{Rule: "8080 localhost:80", Source: wconfig.PortForwardSourceSshConfig}}, make([]wconfig.PortForwardRule, 0, 4)...)}
		new := &wconfig.ConnKeywords{SshLocalForward: []wconfig.PortForwardRule{{Rule: "9090 localhost:90", Source: wconfig.PortForwardSourceConnections}}}
		got := mergeKeywords(old, new)
		if !reflect.DeepEqual(old.SshLocalForward, []wconfig.PortForwardRule{{Rule: "8080 localhost:80", Source: wconfig.PortForwardSourceSshConfig}}) {
			t.Errorf("old slice was mutated: %v", old.SshLocalForward)
		}
		if len(got.SshLocalForward) != 2 {
			t.Fatalf("expected 2 rules, got %d", len(got.SshLocalForward))
		}
	})
}
