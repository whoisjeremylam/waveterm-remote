// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestTailLines(t *testing.T) {
	tests := []struct {
		name     string
		lines    []string
		tail     int
		expected []string
	}{
		{
			name:     "exact tail",
			lines:    []string{"1", "2", "3", "4", "5"},
			tail:     3,
			expected: []string{"3", "4", "5"},
		},
		{
			name:     "tail larger than buffer returns all",
			lines:    []string{"1", "2", "3"},
			tail:     50,
			expected: []string{"1", "2", "3"},
		},
		{
			name:     "tail equal to buffer size returns all",
			lines:    []string{"1", "2", "3"},
			tail:     3,
			expected: []string{"1", "2", "3"},
		},
		{
			name:     "tail one returns last line",
			lines:    []string{"a", "b", "c"},
			tail:     1,
			expected: []string{"c"},
		},
		{
			name:     "tail zero returns all",
			lines:    []string{"a", "b", "c"},
			tail:     0,
			expected: []string{"a", "b", "c"},
		},
		{
			name:     "empty buffer",
			lines:    []string{},
			tail:     5,
			expected: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tailLines(tt.lines, tt.tail)
			if !reflect.DeepEqual(got, tt.expected) {
				t.Errorf("tailLines(%v, %d) = %v, want %v", tt.lines, tt.tail, got, tt.expected)
			}
		})
	}
}

func TestBlockCaptureJSONShape(t *testing.T) {
	out := blockCaptureJSONOutput{
		Lines:       []string{"line 1", "line 2"},
		TotalLines:  42,
		LastUpdated: 1690000000000,
	}
	bytes, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("json.Marshal() error: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error: %v", err)
	}

	if _, ok := decoded["lines"]; !ok {
		t.Errorf("JSON missing key %q: %s", "lines", string(bytes))
	}
	if _, ok := decoded["totallines"]; !ok {
		t.Errorf("JSON missing key %q: %s", "totallines", string(bytes))
	}
	if _, ok := decoded["lastupdated"]; !ok {
		t.Errorf("JSON missing key %q: %s", "lastupdated", string(bytes))
	}
	if totallines, ok := decoded["totallines"].(float64); !ok || int(totallines) != 42 {
		t.Errorf("totallines = %v, want 42", decoded["totallines"])
	}
	if lastupdated, ok := decoded["lastupdated"].(float64); !ok || int64(lastupdated) != 1690000000000 {
		t.Errorf("lastupdated = %v, want 1690000000000", decoded["lastupdated"])
	}
	lines, ok := decoded["lines"].([]interface{})
	if !ok || len(lines) != 2 || lines[0] != "line 1" || lines[1] != "line 2" {
		t.Errorf("lines = %v, want [\"line 1\" \"line 2\"]", decoded["lines"])
	}
}

func TestValidateCaptureFlags(t *testing.T) {
	tests := []struct {
		name     string
		tailSet  bool
		startSet bool
		endSet   bool
		tail     int
		wantErr  bool
	}{
		{
			name:    "no flags is valid",
			wantErr: false,
		},
		{
			name:     "start only is valid",
			startSet: true,
			wantErr:  false,
		},
		{
			name:    "end only is valid",
			endSet:  true,
			wantErr: false,
		},
		{
			name:     "start and end is valid",
			startSet: true,
			endSet:   true,
			wantErr:  false,
		},
		{
			name:    "tail alone is valid",
			tailSet: true,
			tail:    10,
			wantErr: false,
		},
		{
			name:     "tail with start is invalid",
			tailSet:  true,
			startSet: true,
			tail:     10,
			wantErr:  true,
		},
		{
			name:    "tail with end is invalid",
			tailSet: true,
			endSet:  true,
			tail:    10,
			wantErr: true,
		},
		{
			name:     "tail with start and end is invalid",
			tailSet:  true,
			startSet: true,
			endSet:   true,
			tail:     10,
			wantErr:  true,
		},
		{
			name:    "tail zero is invalid",
			tailSet: true,
			tail:    0,
			wantErr: true,
		},
		{
			name:    "tail negative is invalid",
			tailSet: true,
			tail:    -5,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateCaptureFlags(tt.tailSet, tt.startSet, tt.endSet, tt.tail)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateCaptureFlags(%v, %v, %v, %d) error = %v, wantErr %v",
					tt.tailSet, tt.startSet, tt.endSet, tt.tail, err, tt.wantErr)
			}
		})
	}
}

func TestDecodeEscapes(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "plain text unchanged", input: "hello", want: "hello"},
		{name: "empty", input: "", want: ""},
		{name: "newline escape", input: "a\\nb", want: "a\nb"},
		{name: "tab escape", input: "a\\tb", want: "a\tb"},
		{name: "carriage return escape", input: "a\\rb", want: "a\rb"},
		{name: "literal backslash", input: "a\\\\b", want: "a\\b"},
		{name: "unicode ascii", input: "\\u0041", want: "A"},
		{name: "unicode e-acute", input: "\\u00e9", want: "é"},
		{name: "unicode escape sequence", input: "\\u001b[A", want: "\x1b[A"},
		{name: "mixed escapes", input: "x\\u0041\\ny", want: "xA\ny"},
		{name: "invalid escape letter", input: "a\\qb", wantErr: true},
		{name: "trailing backslash", input: "a\\", wantErr: true},
		{name: "unicode too few digits", input: "\\u12", wantErr: true},
		{name: "unicode non-hex", input: "\\u12G4", wantErr: true},
		{name: "unicode trailing backslash", input: "\\u", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decodeEscapes(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("decodeEscapes(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if err != nil {
				return
			}
			if got != tt.want {
				t.Errorf("decodeEscapes(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestValidateSendKeysInput(t *testing.T) {
	tests := []struct {
		name    string
		textSet bool
		secret  string
		wantErr bool
	}{
		{name: "text only is valid", textSet: true, secret: ""},
		{name: "secret only is valid", textSet: false, secret: "api-key"},
		{name: "neither is valid", textSet: false, secret: ""},
		{name: "text and secret is invalid", textSet: true, secret: "api-key", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateSendKeysInput(tt.textSet, tt.secret)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateSendKeysInput(%v, %q) error = %v, wantErr %v", tt.textSet, tt.secret, err, tt.wantErr)
			}
		})
	}
}

func TestMapProcessState(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "done maps to exited", input: "done", want: "exited"},
		{name: "running maps to running", input: "running", want: "running"},
		{name: "init maps to running", input: "init", want: "running"},
		{name: "empty maps to running", input: "", want: "running"},
		{name: "unknown maps to running", input: "bogus", want: "running"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mapProcessState(tt.input)
			if got != tt.want {
				t.Errorf("mapProcessState(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestLookupConnStatus(t *testing.T) {
	tests := []struct {
		name       string
		connStatus []wshrpc.ConnStatus
		connection string
		want       string
	}{
		{name: "empty connection is connected", connection: "", want: "connected"},
		{name: "local is connected", connection: "local", want: "connected"},
		{name: "local prefix is connected", connection: "local:dev", want: "connected"},
		{name: "wsl is connected", connection: "wsl://Ubuntu", want: "connected"},
		{
			name: "remote connected",
			connStatus: []wshrpc.ConnStatus{
				{Connection: "prod-server", Connected: true, Status: "connected"},
			},
			connection: "prod-server",
			want:       "connected",
		},
		{
			name: "remote not connected uses status",
			connStatus: []wshrpc.ConnStatus{
				{Connection: "prod-server", Connected: false, Status: "reconnecting"},
			},
			connection: "prod-server",
			want:       "reconnecting",
		},
		{
			name: "remote not connected empty status",
			connStatus: []wshrpc.ConnStatus{
				{Connection: "prod-server", Connected: false},
			},
			connection: "prod-server",
			want:       "disconnected",
		},
		{
			name: "remote not found",
			connStatus: []wshrpc.ConnStatus{
				{Connection: "other", Connected: true, Status: "connected"},
			},
			connection: "prod-server",
			want:       "disconnected",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := lookupConnStatus(tt.connStatus, tt.connection)
			if got != tt.want {
				t.Errorf("lookupConnStatus(%v, %q) = %q, want %q", tt.connStatus, tt.connection, got, tt.want)
			}
		})
	}
}

func TestAssembleInputBytes(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		enter   bool
		escapes bool
		want    string
		wantErr bool
	}{
		{name: "plain text no enter", text: "echo hi", want: "echo hi"},
		{name: "enter appends carriage return", text: "echo hi", enter: true, want: "echo hi\r"},
		{name: "enter only", enter: true, want: "\r"},
		{name: "escapes decodes newline", text: "a\\nb", escapes: true, want: "a\nb"},
		{name: "escapes off leaves literal", text: "a\\nb", escapes: false, want: "a\\nb"},
		{name: "escapes and enter", text: "a\\n", enter: true, escapes: true, want: "a\n\r"},
		{name: "invalid escape errors", text: "a\\qb", escapes: true, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := assembleInputBytes(tt.text, tt.enter, tt.escapes)
			if (err != nil) != tt.wantErr {
				t.Errorf("assembleInputBytes(%q, %v, %v) error = %v, wantErr %v", tt.text, tt.enter, tt.escapes, err, tt.wantErr)
				return
			}
			if err != nil {
				return
			}
			if string(got) != tt.want {
				t.Errorf("assembleInputBytes(%q, %v, %v) = %q, want %q", tt.text, tt.enter, tt.escapes, string(got), tt.want)
			}
		})
	}
}

func TestBlockStatusJSONShape(t *testing.T) {
	out := blockStatusJSONOutput{
		ProcessState: "exited",
		ExitCode:     0,
		Connection:   "prod-server",
		ConnStatus:   "connected",
	}
	bytes, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("json.Marshal() error: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error: %v", err)
	}

	for _, key := range []string{"processstate", "exitcode", "connection", "connstatus"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("JSON missing key %q: %s", key, string(bytes))
		}
	}
	if ps, ok := decoded["processstate"].(string); !ok || ps != "exited" {
		t.Errorf("processstate = %v, want %q", decoded["processstate"], "exited")
	}
	if ec, ok := decoded["exitcode"].(float64); !ok || int(ec) != 0 {
		t.Errorf("exitcode = %v, want 0", decoded["exitcode"])
	}
	if conn, ok := decoded["connection"].(string); !ok || conn != "prod-server" {
		t.Errorf("connection = %v, want %q", decoded["connection"], "prod-server")
	}
	if cs, ok := decoded["connstatus"].(string); !ok || cs != "connected" {
		t.Errorf("connstatus = %v, want %q", decoded["connstatus"], "connected")
	}
}

func TestDirectionToTargetAction(t *testing.T) {
	tests := []struct {
		name      string
		direction string
		want      string
		wantErr   bool
	}{
		{name: "left", direction: "left", want: "splitleft"},
		{name: "right", direction: "right", want: "splitright"},
		{name: "above", direction: "above", want: "splitup"},
		{name: "below", direction: "below", want: "splitdown"},
		{name: "empty", direction: "", wantErr: true},
		{name: "uppercase", direction: "LEFT", wantErr: true},
		{name: "unknown", direction: "sideways", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := directionToTargetAction(tt.direction)
			if (err != nil) != tt.wantErr {
				t.Errorf("directionToTargetAction(%q) error = %v, wantErr %v", tt.direction, err, tt.wantErr)
				return
			}
			if err != nil {
				return
			}
			if got != tt.want {
				t.Errorf("directionToTargetAction(%q) = %q, want %q", tt.direction, got, tt.want)
			}
		})
	}
}

func TestValidateSplitPair(t *testing.T) {
	tests := []struct {
		name       string
		split      string
		relativeTo string
		wantErr    bool
	}{
		{name: "neither set", split: "", relativeTo: "", wantErr: false},
		{name: "both set", split: "right", relativeTo: "block:abc", wantErr: false},
		{name: "split without relative-to", split: "right", relativeTo: "", wantErr: true},
		{name: "relative-to without split", split: "", relativeTo: "block:abc", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateSplitPair(tt.split, tt.relativeTo)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateSplitPair(%q, %q) error = %v, wantErr %v", tt.split, tt.relativeTo, err, tt.wantErr)
			}
		})
	}
}

func TestValidateRenameArgs(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantRef  string
		wantName string
		wantErr  bool
	}{
		{name: "valid", args: []string{"block:abc", "fixer-agent"}, wantRef: "block:abc", wantName: "fixer-agent"},
		{name: "zero args", args: nil, wantErr: true},
		{name: "one arg", args: []string{"block:abc"}, wantErr: true},
		{name: "three args", args: []string{"block:abc", "name", "extra"}, wantErr: true},
		{name: "empty name", args: []string{"block:abc", ""}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotRef, gotName, err := validateRenameArgs(tt.args)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateRenameArgs(%v) error = %v, wantErr %v", tt.args, err, tt.wantErr)
				return
			}
			if err != nil {
				return
			}
			if gotRef != tt.wantRef || gotName != tt.wantName {
				t.Errorf("validateRenameArgs(%v) = (%q, %q), want (%q, %q)", tt.args, gotRef, gotName, tt.wantRef, tt.wantName)
			}
		})
	}
}

func TestBuildBlockNewMeta(t *testing.T) {
	t.Run("plain terminal block", func(t *testing.T) {
		meta := buildBlockNewMeta("term", "", "/home/user", "prod")
		if meta[waveobj.MetaKey_View] != "term" {
			t.Errorf("view = %v, want %q", meta[waveobj.MetaKey_View], "term")
		}
		if meta[waveobj.MetaKey_Controller] != "shell" {
			t.Errorf("controller = %v, want %q", meta[waveobj.MetaKey_Controller], "shell")
		}
		if meta[waveobj.MetaKey_CmdCwd] != "/home/user" {
			t.Errorf("cmd:cwd = %v, want %q", meta[waveobj.MetaKey_CmdCwd], "/home/user")
		}
		if meta[waveobj.MetaKey_Connection] != "prod" {
			t.Errorf("connection = %v, want %q", meta[waveobj.MetaKey_Connection], "prod")
		}
		for _, key := range []string{waveobj.MetaKey_Cmd, waveobj.MetaKey_CmdRunOnStart, waveobj.MetaKey_CmdRunOnce, waveobj.MetaKey_CmdCloseOnExit} {
			if _, ok := meta[key]; ok {
				t.Errorf("plain term block should not have key %q", key)
			}
		}
	})

	t.Run("command block is persistent", func(t *testing.T) {
		meta := buildBlockNewMeta("term", "tail -f /var/log/syslog", "/home/user", "prod")
		if meta[waveobj.MetaKey_View] != "term" {
			t.Errorf("view = %v, want %q", meta[waveobj.MetaKey_View], "term")
		}
		if meta[waveobj.MetaKey_Controller] != "cmd" {
			t.Errorf("controller = %v, want %q", meta[waveobj.MetaKey_Controller], "cmd")
		}
		if meta[waveobj.MetaKey_Cmd] != "tail -f /var/log/syslog" {
			t.Errorf("cmd = %v, want %q", meta[waveobj.MetaKey_Cmd], "tail -f /var/log/syslog")
		}
		if meta[waveobj.MetaKey_CmdRunOnStart] != true {
			t.Errorf("cmd:runonstart = %v, want true", meta[waveobj.MetaKey_CmdRunOnStart])
		}
		if meta[waveobj.MetaKey_CmdShell] != true {
			t.Errorf("cmd:shell = %v, want true", meta[waveobj.MetaKey_CmdShell])
		}
		if meta[waveobj.MetaKey_CmdClearOnStart] != true {
			t.Errorf("cmd:clearonstart = %v, want true", meta[waveobj.MetaKey_CmdClearOnStart])
		}
		args, ok := meta[waveobj.MetaKey_CmdArgs].([]string)
		if !ok || len(args) != 0 {
			t.Errorf("cmd:args = %v (%T), want empty []string", meta[waveobj.MetaKey_CmdArgs], meta[waveobj.MetaKey_CmdArgs])
		}
		// Persistent: the block stays open after the command exits.
		for _, key := range []string{waveobj.MetaKey_CmdRunOnce, waveobj.MetaKey_CmdCloseOnExit, waveobj.MetaKey_CmdCloseOnExitForce} {
			if _, ok := meta[key]; ok {
				t.Errorf("persistent command block should not have key %q", key)
			}
		}
	})

	t.Run("non-term view without cmd", func(t *testing.T) {
		meta := buildBlockNewMeta("web", "", "/home/user", "")
		if meta[waveobj.MetaKey_View] != "web" {
			t.Errorf("view = %v, want %q", meta[waveobj.MetaKey_View], "web")
		}
		if _, ok := meta[waveobj.MetaKey_Controller]; ok {
			t.Errorf("non-term view should not have controller, got %v", meta[waveobj.MetaKey_Controller])
		}
		if _, ok := meta[waveobj.MetaKey_Connection]; ok {
			t.Errorf("non-term view with empty connection should not have connection key")
		}
	})
}

func TestBuildEnvContent(t *testing.T) {
	content := buildEnvContent([]string{"A=1", "B=hello world", "NOVALUE"})
	for _, want := range []string{"A=1\x00", "B=hello world\x00"} {
		if !strings.Contains(content, want) {
			t.Errorf("buildEnvContent() = %q, want it to contain %q", content, want)
		}
	}
	if strings.Contains(content, "NOVALUE") {
		t.Errorf("buildEnvContent() = %q, should not include malformed env var without '='", content)
	}
}

func TestBlockNewJSONShape(t *testing.T) {
	out := blockNewJSONOutput{BlockId: "1234"}
	bytes, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("json.Marshal() error: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error: %v", err)
	}
	if id, ok := decoded["blockid"].(string); !ok || id != "1234" {
		t.Errorf("blockid = %v, want %q", decoded["blockid"], "1234")
	}
}
