// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package remote

import (
	"context"
	"testing"
)

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

func TestPasswordUsedTracker(t *testing.T) {
	t.Parallel()

	t.Run("initial state", func(t *testing.T) {
		t.Parallel()
		tracker := &PasswordUsedTracker{}
		if tracker.Used {
			t.Error("expected Used to be false initially")
		}
		if tracker.Password != "" {
			t.Errorf("expected empty Password, got %q", tracker.Password)
		}
	})

	t.Run("tracks password usage", func(t *testing.T) {
		t.Parallel()
		tracker := &PasswordUsedTracker{}
		tracker.Password = "mypass"
		tracker.Used = true

		if !tracker.Used {
			t.Error("expected Used to be true")
		}
		if tracker.Password != "mypass" {
			t.Errorf("expected 'mypass', got %q", tracker.Password)
		}
	})
}
