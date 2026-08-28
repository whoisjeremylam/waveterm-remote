// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

func TestPortForwardRuleJSON(t *testing.T) {
	t.Parallel()

	t.Run("unmarshal bare string", func(t *testing.T) {
		t.Parallel()
		var r PortForwardRule
		if err := json.Unmarshal([]byte(`"8080 localhost:80"`), &r); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if r.Rule != "8080 localhost:80" || r.Note != "" || r.Enabled != nil {
			t.Errorf("unexpected result: %+v", r)
		}
	})

	t.Run("unmarshal object", func(t *testing.T) {
		t.Parallel()
		var r PortForwardRule
		if err := json.Unmarshal([]byte(`{"rule":"8080 localhost:80","note":"web","enabled":false}`), &r); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if r.Rule != "8080 localhost:80" || r.Note != "web" {
			t.Errorf("unexpected rule/note: %+v", r)
		}
		if r.Enabled == nil || *r.Enabled {
			t.Errorf("expected enabled=false, got %v", r.Enabled)
		}
	})

	t.Run("marshal bare string when no note or enabled", func(t *testing.T) {
		t.Parallel()
		r := PortForwardRule{Rule: "8080 localhost:80"}
		b, err := json.Marshal(r)
		if err != nil {
			t.Fatalf("marshal error: %v", err)
		}
		if string(b) != `"8080 localhost:80"` {
			t.Errorf("expected bare string, got %s", string(b))
		}
	})

	t.Run("marshal object when note set and roundtrip", func(t *testing.T) {
		t.Parallel()
		r := PortForwardRule{Rule: "8080 localhost:80", Note: "web"}
		b, err := json.Marshal(r)
		if err != nil {
			t.Fatalf("marshal error: %v", err)
		}
		var back PortForwardRule
		if err := json.Unmarshal(b, &back); err != nil {
			t.Fatalf("roundtrip unmarshal error: %v", err)
		}
		if back.Rule != "8080 localhost:80" || back.Note != "web" {
			t.Errorf("roundtrip mismatch: %+v", back)
		}
	})

	t.Run("marshal excludes source", func(t *testing.T) {
		t.Parallel()
		r := PortForwardRule{Rule: "8080 localhost:80", Note: "web", Source: PortForwardSourceSshConfig}
		b, err := json.Marshal(r)
		if err != nil {
			t.Fatalf("marshal error: %v", err)
		}
		if strings.Contains(string(b), "source") || strings.Contains(string(b), "sshconfig") {
			t.Errorf("source should not be serialized: %s", string(b))
		}
	})
}

// TestPortForwardRuleReadPath exercises the full config read path: raw JSON →
// readConfigHelper (untyped MetaMapType) → utilfn.ReUnmarshal into the typed
// Connections map. This is the exact path ReadFullConfig uses, so it verifies
// the string-or-object PortForwardRule form survives the reflection roundtrip.
func TestPortForwardRuleReadPath(t *testing.T) {
	t.Parallel()

	raw := []byte(`{"myhost": {"ssh:localforward": ["8080 localhost:80", {"rule":"9090 localhost:90","note":"web","enabled":false}], "ssh:remoteforward": ["3000 localhost:3000"]}}`)
	meta, cerrs := readConfigHelper("connections.json", raw, nil)
	if len(cerrs) > 0 {
		t.Fatalf("config errors: %v", cerrs)
	}
	var conns map[string]ConnKeywords
	if err := utilfn.ReUnmarshal(&conns, meta); err != nil {
		t.Fatalf("reunmarshal error: %v", err)
	}
	myhost, ok := conns["myhost"]
	if !ok {
		t.Fatal("missing myhost")
	}

	if len(myhost.SshLocalForward) != 2 {
		t.Fatalf("expected 2 local forwards, got %d", len(myhost.SshLocalForward))
	}
	if myhost.SshLocalForward[0].Rule != "8080 localhost:80" {
		t.Errorf("unexpected rule 0: %+v", myhost.SshLocalForward[0])
	}
	if myhost.SshLocalForward[1].Rule != "9090 localhost:90" || myhost.SshLocalForward[1].Note != "web" {
		t.Errorf("unexpected rule 1: %+v", myhost.SshLocalForward[1])
	}
	if myhost.SshLocalForward[1].Enabled == nil || *myhost.SshLocalForward[1].Enabled {
		t.Errorf("expected enabled=false, got %v", myhost.SshLocalForward[1].Enabled)
	}
	if myhost.SshLocalForward[1].Source != "" {
		t.Errorf("expected empty source for connections.json rule, got %q", myhost.SshLocalForward[1].Source)
	}
	if len(myhost.SshRemoteForward) != 1 || myhost.SshRemoteForward[0].Rule != "3000 localhost:3000" {
		t.Errorf("unexpected remote forwards: %+v", myhost.SshRemoteForward)
	}
}
