// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package genconn

import (
	"context"
	"testing"
)

func TestContextWithConnData(t *testing.T) {
	t.Parallel()

	t.Run("returns same context when blockId is empty", func(t *testing.T) {
		t.Parallel()
		ctx := context.Background()
		result := ContextWithConnData(ctx, "")
		if result != ctx {
			t.Error("expected same context returned for empty blockId")
		}
	})

	t.Run("stores blockId in context", func(t *testing.T) {
		t.Parallel()
		ctx := ContextWithConnData(context.Background(), "block-123")
		data := GetConnData(ctx)
		if data == nil {
			t.Fatal("expected connData to be non-nil")
		}
		if data.BlockId != "block-123" {
			t.Errorf("expected BlockId 'block-123', got %q", data.BlockId)
		}
		if data.ConnName != "" {
			t.Errorf("expected empty ConnName, got %q", data.ConnName)
		}
	})
}

func TestContextWithConnDataAndName(t *testing.T) {
	t.Parallel()

	t.Run("returns same context when both empty", func(t *testing.T) {
		t.Parallel()
		ctx := context.Background()
		result := ContextWithConnDataAndName(ctx, "", "")
		if result != ctx {
			t.Error("expected same context returned for empty blockId and connName")
		}
	})

	t.Run("stores blockId and connName", func(t *testing.T) {
		t.Parallel()
		ctx := ContextWithConnDataAndName(context.Background(), "block-123", "user@host")
		data := GetConnData(ctx)
		if data == nil {
			t.Fatal("expected connData to be non-nil")
		}
		if data.BlockId != "block-123" {
			t.Errorf("expected BlockId 'block-123', got %q", data.BlockId)
		}
		if data.ConnName != "user@host" {
			t.Errorf("expected ConnName 'user@host', got %q", data.ConnName)
		}
	})

	t.Run("stores connName when blockId is empty", func(t *testing.T) {
		t.Parallel()
		ctx := ContextWithConnDataAndName(context.Background(), "", "user@host")
		data := GetConnData(ctx)
		if data == nil {
			t.Fatal("expected connData to be non-nil")
		}
		if data.ConnName != "user@host" {
			t.Errorf("expected ConnName 'user@host', got %q", data.ConnName)
		}
	})

	t.Run("stores blockId when connName is empty", func(t *testing.T) {
		t.Parallel()
		ctx := ContextWithConnDataAndName(context.Background(), "block-123", "")
		data := GetConnData(ctx)
		if data == nil {
			t.Fatal("expected connData to be non-nil")
		}
		if data.BlockId != "block-123" {
			t.Errorf("expected BlockId 'block-123', got %q", data.BlockId)
		}
	})

	t.Run("overwrites previous connData", func(t *testing.T) {
		t.Parallel()
		ctx := ContextWithConnDataAndName(context.Background(), "block-1", "first@host")
		ctx = ContextWithConnDataAndName(ctx, "block-2", "second@host")
		data := GetConnData(ctx)
		if data == nil {
			t.Fatal("expected connData to be non-nil")
		}
		if data.BlockId != "block-2" {
			t.Errorf("expected BlockId 'block-2', got %q", data.BlockId)
		}
		if data.ConnName != "second@host" {
			t.Errorf("expected ConnName 'second@host', got %q", data.ConnName)
		}
	})
}

func TestGetConnData(t *testing.T) {
	t.Parallel()

	t.Run("returns nil for nil context", func(t *testing.T) {
		t.Parallel()
		data := GetConnData(nil)
		if data != nil {
			t.Error("expected nil for nil context")
		}
	})

	t.Run("returns nil when no connData in context", func(t *testing.T) {
		t.Parallel()
		data := GetConnData(context.Background())
		if data != nil {
			t.Error("expected nil when no connData in context")
		}
	})
}

func TestGetConnName(t *testing.T) {
	t.Parallel()

	t.Run("returns empty string for nil connData", func(t *testing.T) {
		t.Parallel()
		var cd *connData
		if cd.GetConnName() != "" {
			t.Error("expected empty string for nil connData")
		}
	})

	t.Run("returns connName from connData", func(t *testing.T) {
		t.Parallel()
		cd := &connData{ConnName: "user@host"}
		if cd.GetConnName() != "user@host" {
			t.Errorf("expected 'user@host', got %q", cd.GetConnName())
		}
	})

	t.Run("returns empty string when connName is empty", func(t *testing.T) {
		t.Parallel()
		cd := &connData{BlockId: "block-123"}
		if cd.GetConnName() != "" {
			t.Errorf("expected empty string, got %q", cd.GetConnName())
		}
	})
}
