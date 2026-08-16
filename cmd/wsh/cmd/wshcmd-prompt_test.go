// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

func TestParseOptionsFlag(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    []string
		wantErr bool
	}{
		{
			name: "empty returns nil",
			in:   "",
			want: nil,
		},
		{
			name: "whitespace only returns nil",
			in:   "   ",
			want: nil,
		},
		{
			name: "single option",
			in:   "yes",
			want: []string{"yes"},
		},
		{
			name: "two options",
			in:   "yes,no",
			want: []string{"yes", "no"},
		},
		{
			name: "three options",
			in:   "a,b,c",
			want: []string{"a", "b", "c"},
		},
		{
			name: "trims whitespace",
			in:   " yes , no , maybe ",
			want: []string{"yes", "no", "maybe"},
		},
		{
			name:    "empty option errors",
			in:      "a,,b",
			wantErr: true,
		},
		{
			name:    "leading comma errors",
			in:      ",a",
			wantErr: true,
		},
		{
			name:    "trailing comma errors",
			in:      "a,",
			wantErr: true,
		},
		{
			name:    "comma with spaces errors",
			in:      "a, ,b",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseOptionsFlag(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseOptionsFlag(%q) expected error, got nil", tt.in)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseOptionsFlag(%q) unexpected error: %v", tt.in, err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("parseOptionsFlag(%q) = %v, want %v", tt.in, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("parseOptionsFlag(%q)[%d] = %q, want %q", tt.in, i, got[i], tt.want[i])
				}
			}
		})
	}
}
