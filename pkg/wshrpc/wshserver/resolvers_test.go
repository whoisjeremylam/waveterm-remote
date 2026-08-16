// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"reflect"
	"strings"
	"testing"
)

func TestMatchBlockTitles(t *testing.T) {
	tests := []struct {
		name        string
		titles      map[string]string
		query       string
		want        []string
		wantErr     bool
		errContains string
		errExact    string
	}{
		{
			name:   "exact match",
			titles: map[string]string{"b1": "claude"},
			query:  "claude",
			want:   []string{"b1"},
		},
		{
			name:   "substring match",
			titles: map[string]string{"b1": "Claude Code"},
			query:  "claude",
			want:   []string{"b1"},
		},
		{
			name:   "case-insensitive both directions",
			titles: map[string]string{"b1": "CLAUDE"},
			query:  "claude",
			want:   []string{"b1"},
		},
		{
			name:   "case-insensitive query",
			titles: map[string]string{"b1": "claude"},
			query:  "CLAUDE",
			want:   []string{"b1"},
		},
		{
			name:   "substring in middle of title",
			titles: map[string]string{"b1": "prod-server: ~/project"},
			query:  "server",
			want:   []string{"b1"},
		},
		{
			name:        "no match",
			titles:      map[string]string{"b1": "claude", "b2": "term"},
			query:       "zebra",
			wantErr:     true,
			errContains: `no block found with title containing "zebra"`,
		},
		{
			name:        "empty titles map",
			titles:      map[string]string{},
			query:       "claude",
			wantErr:     true,
			errContains: `no block found with title containing "claude"`,
		},
		{
			name:        "empty query never matches",
			titles:      map[string]string{"b1": "claude"},
			query:       "",
			wantErr:     true,
			errContains: `no block found with title containing ""`,
		},
		{
			name:   "empty title never matches",
			titles: map[string]string{"b1": "", "b2": "claude"},
			query:  "claude",
			want:   []string{"b2"},
		},
		{
			name:   "single match among many",
			titles: map[string]string{"b1": "term", "b2": "claude-code", "b3": "web"},
			query:  "claude",
			want:   []string{"b2"},
		},
		{
			name:        "multiple matches ambiguous",
			titles:      map[string]string{"b1": "claude-1", "b2": "claude-2", "b3": "other"},
			query:       "claude",
			wantErr:     true,
			errContains: `ambiguous: 2 blocks match title "claude"`,
		},
		{
			name:     "ambiguous error lists ids and titles deterministically",
			titles:   map[string]string{"b2": "Claude Two", "b1": "claude one"},
			query:    "claude",
			wantErr:  true,
			errExact: `ambiguous: 2 blocks match title "claude": b1 (claude one), b2 (Claude Two)`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := matchBlockTitles(tc.titles, tc.query)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got none (matches: %v)", got)
				}
				if tc.errExact != "" {
					if err.Error() != tc.errExact {
						t.Fatalf("expected error %q, got %q", tc.errExact, err.Error())
					}
				} else if !strings.Contains(err.Error(), tc.errContains) {
					t.Fatalf("expected error containing %q, got %q", tc.errContains, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("expected %v, got %v", tc.want, got)
			}
		})
	}
}

func TestParseSimpleId_TitleFallback(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantDisc string
		wantVal  string
	}{
		{"hyphenated string falls back to title", "claude-code", "title", "claude-code"},
		{"spaces fall back to title", "claude code", "title", "claude code"},
		{"uppercase falls back to title", "Claude", "title", "Claude"},
		{"mixed digits and letters fall back to title", "server2", "title", "server2"},
		{"empty string falls back to title", "", "title", ""},
		{"number still resolves to blocknum", "3", "blocknum", "3"},
		{"bare lowercase word still resolves to view", "term", "view", "term"},
		{"view with instance still resolves to view", "term:2", "view", "term:2"},
		{"tab index still resolves to tabnum", "tab:2", "tabnum", "tab:2"},
		{"uuid still resolves to uuid", "12345678-1234-1234-1234-123456789012", "uuid", "12345678-1234-1234-1234-123456789012"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			disc, val, err := parseSimpleId(tc.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if disc != tc.wantDisc || val != tc.wantVal {
				t.Fatalf("parseSimpleId(%q) = (%q, %q), want (%q, %q)", tc.input, disc, val, tc.wantDisc, tc.wantVal)
			}
		})
	}
}
