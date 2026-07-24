// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package remote

import (
	"context"
	"testing"
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
