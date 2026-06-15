// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package userinput

import (
	"encoding/json"
	"testing"
)

func TestUserInputRequestPromptType(t *testing.T) {
	t.Parallel()

	t.Run("prompttype omitted when empty", func(t *testing.T) {
		t.Parallel()
		req := &UserInputRequest{
			RequestId:    "test-id",
			QueryText:    "Enter password:",
			ResponseType: "text",
			Title:        "Password Authentication",
		}
		data, err := json.Marshal(req)
		if err != nil {
			t.Fatalf("marshal error: %v", err)
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if _, exists := parsed["prompttype"]; exists {
			t.Error("expected prompttype to be omitted when empty")
		}
	})

	t.Run("prompttype included when set", func(t *testing.T) {
		t.Parallel()
		req := &UserInputRequest{
			RequestId:    "test-id",
			QueryText:    "Enter password:",
			ResponseType: "text",
			Title:        "Password Authentication",
			PromptType:   "password",
		}
		data, err := json.Marshal(req)
		if err != nil {
			t.Fatalf("marshal error: %v", err)
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		pt, exists := parsed["prompttype"]
		if !exists {
			t.Error("expected prompttype to be present")
		}
		if pt != "password" {
			t.Errorf("expected 'password', got %v", pt)
		}
	})

	t.Run("prompttype roundtrip", func(t *testing.T) {
		t.Parallel()
		original := &UserInputRequest{
			RequestId:    "test-id",
			QueryText:    "Question?",
			ResponseType: "confirm",
			Title:        "Confirm",
			PromptType:   "passphrase",
		}
		data, err := json.Marshal(original)
		if err != nil {
			t.Fatalf("marshal error: %v", err)
		}
		var decoded UserInputRequest
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if decoded.PromptType != "passphrase" {
			t.Errorf("expected 'passphrase', got %q", decoded.PromptType)
		}
	})
}

func TestUserInputRequestConnName(t *testing.T) {
	t.Parallel()

	t.Run("connname omitted when empty", func(t *testing.T) {
		t.Parallel()
		req := &UserInputRequest{
			RequestId:    "test-id",
			QueryText:    "Enter password:",
			ResponseType: "text",
			Title:        "Password Authentication",
		}
		data, err := json.Marshal(req)
		if err != nil {
			t.Fatalf("marshal error: %v", err)
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if _, exists := parsed["connname"]; exists {
			t.Error("expected connname to be omitted when empty")
		}
	})

	t.Run("connname included when set", func(t *testing.T) {
		t.Parallel()
		req := &UserInputRequest{
			RequestId:    "test-id",
			QueryText:    "Enter password:",
			ResponseType: "text",
			Title:        "Password Authentication",
			ConnName:     "user@host:22",
		}
		data, err := json.Marshal(req)
		if err != nil {
			t.Fatalf("marshal error: %v", err)
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		cn, exists := parsed["connname"]
		if !exists {
			t.Error("expected connname to be present")
		}
		if cn != "user@host:22" {
			t.Errorf("expected 'user@host:22', got %v", cn)
		}
	})
}
