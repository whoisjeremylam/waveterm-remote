// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

func TestResolveAgentSplitRelativeTo(t *testing.T) {
	tests := []struct {
		name           string
		split          string
		relativeTo     string
		focusedBlockId string
		want           string
		wantErr        bool
	}{
		{name: "no split no relative-to", split: "", relativeTo: "", want: ""},
		{name: "split with relative-to", split: "right", relativeTo: "block:abc", want: "block:abc"},
		{name: "split defaults to focused block", split: "right", relativeTo: "", focusedBlockId: "block:focused", want: "block:focused"},
		{name: "relative-to without split errors", split: "", relativeTo: "block:abc", wantErr: true},
		{name: "split without relative-to and no focused block errors", split: "right", relativeTo: "", wantErr: true},
		{name: "explicit relative-to wins over focused block", split: "below", relativeTo: "block:explicit", focusedBlockId: "block:focused", want: "block:explicit"},
		{name: "empty relative-to treated as unset even with focused block", split: "left", relativeTo: "", focusedBlockId: "block:focused", want: "block:focused"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveAgentSplitRelativeTo(tt.split, tt.relativeTo, tt.focusedBlockId)
			if (err != nil) != tt.wantErr {
				t.Errorf("resolveAgentSplitRelativeTo(%q, %q, %q) error = %v, wantErr %v",
					tt.split, tt.relativeTo, tt.focusedBlockId, err, tt.wantErr)
				return
			}
			if err != nil {
				return
			}
			if got != tt.want {
				t.Errorf("resolveAgentSplitRelativeTo(%q, %q, %q) = %q, want %q",
					tt.split, tt.relativeTo, tt.focusedBlockId, got, tt.want)
			}
		})
	}
}

func TestAssemblePromptInput(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		want   string
	}{
		{name: "plain prompt appends enter", prompt: "Fix the build error", want: "Fix the build error\r"},
		{name: "empty prompt is just enter", prompt: "", want: "\r"},
		{name: "prompt with trailing newline still appends enter", prompt: "hello\n", want: "hello\n\r"},
		{name: "multi-line prompt", prompt: "line1\nline2", want: "line1\nline2\r"},
		{name: "prompt already ending in CR gets another", prompt: "done\r", want: "done\r\r"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := assemblePromptInput(tt.prompt)
			if got != tt.want {
				t.Errorf("assemblePromptInput(%q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}
