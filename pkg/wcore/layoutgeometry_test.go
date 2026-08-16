// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"math"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func leafNode(id, blockId string) map[string]any {
	return map[string]any{
		"id":            id,
		"flexDirection": "row",
		"size":          10.0,
		"data":          map[string]any{"blockId": blockId},
	}
}

func splitNode(id, flexDirection string, size float64, children ...map[string]any) map[string]any {
	kids := make([]any, len(children))
	for i, c := range children {
		kids[i] = c
	}
	return map[string]any{
		"id":            id,
		"flexDirection": flexDirection,
		"size":          size,
		"children":      kids,
	}
}

func closeEnough(a, b float64) bool {
	return math.Abs(a-b) < 1e-9
}

type geomWant struct {
	x, y, w, h float64
}

func TestComputeBlockLayoutInfo(t *testing.T) {
	tests := []struct {
		name            string
		rootNode        any
		leafOrder       []waveobj.LeafOrderEntry
		focusedNodeId   string
		magnifiedNodeId string
		wantGeometry    map[string]geomWant
		wantIndex       map[string]int
		wantFocused     map[string]bool
		wantMagnified   map[string]bool
	}{
		{
			name:      "single leaf",
			rootNode:  leafNode("n1", "b1"),
			leafOrder: []waveobj.LeafOrderEntry{{NodeId: "n1", BlockId: "b1"}},
			wantGeometry: map[string]geomWant{
				"b1": {0, 0, 1, 1},
			},
			wantIndex: map[string]int{"b1": 1},
		},
		{
			name: "row split two children",
			rootNode: splitNode("root", "row", 20,
				leafNode("n1", "b1"),
				leafNode("n2", "b2"),
			),
			leafOrder:     []waveobj.LeafOrderEntry{{NodeId: "n1", BlockId: "b1"}, {NodeId: "n2", BlockId: "b2"}},
			focusedNodeId: "n1",
			wantGeometry: map[string]geomWant{
				"b1": {0, 0, 0.5, 1},
				"b2": {0.5, 0, 0.5, 1},
			},
			wantIndex:   map[string]int{"b1": 1, "b2": 2},
			wantFocused: map[string]bool{"b1": true},
		},
		{
			name: "column split two children",
			rootNode: splitNode("root", "column", 20,
				leafNode("n1", "b1"),
				leafNode("n2", "b2"),
			),
			leafOrder:       []waveobj.LeafOrderEntry{{NodeId: "n1", BlockId: "b1"}, {NodeId: "n2", BlockId: "b2"}},
			magnifiedNodeId: "n2",
			wantGeometry: map[string]geomWant{
				"b1": {0, 0, 1, 0.5},
				"b2": {0, 0.5, 1, 0.5},
			},
			wantIndex:     map[string]int{"b1": 1, "b2": 2},
			wantMagnified: map[string]bool{"b2": true},
		},
		{
			name: "nested split",
			rootNode: splitNode("root", "row", 20,
				splitNode("left", "column", 10,
					leafNode("n1", "b1"),
					leafNode("n2", "b2"),
				),
				leafNode("n3", "b3"),
			),
			leafOrder: []waveobj.LeafOrderEntry{
				{NodeId: "n1", BlockId: "b1"},
				{NodeId: "n2", BlockId: "b2"},
				{NodeId: "n3", BlockId: "b3"},
			},
			wantGeometry: map[string]geomWant{
				"b1": {0, 0, 0.5, 0.5},
				"b2": {0, 0.5, 0.5, 0.5},
				"b3": {0.5, 0, 0.5, 1},
			},
			wantIndex: map[string]int{"b1": 1, "b2": 2, "b3": 3},
		},
		{
			name: "unequal sizes in row",
			rootNode: splitNode("root", "row", 30,
				splitNode("left", "row", 20, leafNode("n1", "b1")),
				splitNode("right", "row", 10, leafNode("n2", "b2")),
			),
			leafOrder: []waveobj.LeafOrderEntry{{NodeId: "n1", BlockId: "b1"}, {NodeId: "n2", BlockId: "b2"}},
			wantGeometry: map[string]geomWant{
				"b1": {0, 0, 2.0 / 3.0, 1},
				"b2": {2.0 / 3.0, 0, 1.0 / 3.0, 1},
			},
			wantIndex: map[string]int{"b1": 1, "b2": 2},
		},
		{
			name:         "empty tree nil root",
			rootNode:     nil,
			leafOrder:    []waveobj.LeafOrderEntry{{NodeId: "n1", BlockId: "b1"}},
			wantGeometry: map[string]geomWant{},
			wantIndex:    map[string]int{"b1": 1},
		},
		{
			name:         "malformed root non-map",
			rootNode:     "not-a-node",
			leafOrder:    []waveobj.LeafOrderEntry{{NodeId: "n1", BlockId: "b1"}},
			wantGeometry: map[string]geomWant{},
			wantIndex:    map[string]int{"b1": 1},
		},
		{
			name: "unknown flexDirection defaults to row",
			rootNode: map[string]any{
				"id":            "root",
				"flexDirection": "bogus",
				"size":          20.0,
				"children": []any{
					leafNode("n1", "b1"),
					leafNode("n2", "b2"),
				},
			},
			leafOrder: []waveobj.LeafOrderEntry{{NodeId: "n1", BlockId: "b1"}, {NodeId: "n2", BlockId: "b2"}},
			wantGeometry: map[string]geomWant{
				"b1": {0, 0, 0.5, 1},
				"b2": {0.5, 0, 0.5, 1},
			},
			wantIndex: map[string]int{"b1": 1, "b2": 2},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info := NewBlockLayoutInfo()
			computeBlockLayoutInfo(info, tc.rootNode, tc.leafOrder, tc.focusedNodeId, tc.magnifiedNodeId)

			if len(info.Geometry) != len(tc.wantGeometry) {
				t.Fatalf("geometry entry count = %d, want %d", len(info.Geometry), len(tc.wantGeometry))
			}
			for bid, want := range tc.wantGeometry {
				got := info.Geometry[bid]
				if got == nil {
					t.Errorf("block %s: geometry missing", bid)
					continue
				}
				if !closeEnough(got.X, want.x) || !closeEnough(got.Y, want.y) || !closeEnough(got.W, want.w) || !closeEnough(got.H, want.h) {
					t.Errorf("block %s: geometry = {x:%v y:%v w:%v h:%v}, want {x:%v y:%v w:%v h:%v}", bid, got.X, got.Y, got.W, got.H, want.x, want.y, want.w, want.h)
				}
			}

			assertIntMap(t, "index", info.Index, tc.wantIndex)
			assertBoolMap(t, "focused", info.Focused, tc.wantFocused)
			assertBoolMap(t, "magnified", info.Magnified, tc.wantMagnified)
		})
	}
}

func assertIntMap(t *testing.T, label string, got map[string]int, want map[string]int) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s entry count = %d, want %d", label, len(got), len(want))
		return
	}
	for k, wantV := range want {
		if got[k] != wantV {
			t.Errorf("%s[%s] = %d, want %d", label, k, got[k], wantV)
		}
	}
}

func assertBoolMap(t *testing.T, label string, got map[string]bool, want map[string]bool) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s entry count = %d, want %d", label, len(got), len(want))
		return
	}
	for k, wantV := range want {
		if got[k] != wantV {
			t.Errorf("%s[%s] = %v, want %v", label, k, got[k], wantV)
		}
	}
}

func geom(x, y, w, h float64) *wshrpc.BlockGeometry {
	return &wshrpc.BlockGeometry{X: x, Y: y, W: w, H: h}
}

func TestFindBlockInDirection(t *testing.T) {
	tests := []struct {
		name      string
		geoms     map[string]*wshrpc.BlockGeometry
		source    string
		direction string
		want      string
	}{
		{
			name: "right of left pane in horizontal split",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.5, 1),
				"b2": geom(0.5, 0, 0.5, 1),
			},
			source: "b1", direction: "right", want: "b2",
		},
		{
			name: "right of rightmost is boundary",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.5, 1),
				"b2": geom(0.5, 0, 0.5, 1),
			},
			source: "b2", direction: "right", want: "",
		},
		{
			name: "left of right pane in horizontal split",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.5, 1),
				"b2": geom(0.5, 0, 0.5, 1),
			},
			source: "b2", direction: "left", want: "b1",
		},
		{
			name: "above of bottom pane in vertical split",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 1, 0.5),
				"b2": geom(0, 0.5, 1, 0.5),
			},
			source: "b2", direction: "above", want: "b1",
		},
		{
			name: "below of top pane in vertical split",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 1, 0.5),
				"b2": geom(0, 0.5, 1, 0.5),
			},
			source: "b1", direction: "below", want: "b2",
		},
		{
			name: "right picks closest candidate",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.33, 1),
				"b2": geom(0.33, 0, 0.34, 1),
				"b3": geom(0.67, 0, 0.33, 1),
			},
			source: "b1", direction: "right", want: "b2",
		},
		{
			name: "left picks closest candidate",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.33, 1),
				"b2": geom(0.33, 0, 0.34, 1),
				"b3": geom(0.67, 0, 0.33, 1),
			},
			source: "b3", direction: "left", want: "b2",
		},
		{
			name: "below picks closest candidate",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 1, 0.33),
				"b2": geom(0, 0.33, 1, 0.34),
				"b3": geom(0, 0.67, 1, 0.33),
			},
			source: "b1", direction: "below", want: "b2",
		},
		{
			name: "nested big block right of two stacked blocks (top)",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.5, 0.5),
				"b2": geom(0, 0.5, 0.5, 0.5),
				"b3": geom(0.5, 0, 0.5, 1),
			},
			source: "b1", direction: "right", want: "b3",
		},
		{
			name: "nested big block right of two stacked blocks (bottom)",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.5, 0.5),
				"b2": geom(0, 0.5, 0.5, 0.5),
				"b3": geom(0.5, 0, 0.5, 1),
			},
			source: "b2", direction: "right", want: "b3",
		},
		{
			name: "no vertical overlap excludes candidate",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.5, 0.5),
				"b2": geom(0.5, 0, 0.5, 0.5),
				"b3": geom(0, 0.5, 0.5, 0.5),
			},
			source: "b3", direction: "right", want: "",
		},
		{
			name: "source self skip",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 1, 1),
			},
			source: "b1", direction: "right", want: "",
		},
		{
			name: "zero size candidate does not match",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.5, 1),
				"b2": geom(0.5, 0, 0.5, 0),
			},
			source: "b1", direction: "right", want: "",
		},
		{
			name: "invalid direction returns empty",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 0.5, 1),
				"b2": geom(0.5, 0, 0.5, 1),
			},
			source: "b1", direction: "sideways", want: "",
		},
		{
			name: "missing source returns empty",
			geoms: map[string]*wshrpc.BlockGeometry{
				"b1": geom(0, 0, 1, 1),
			},
			source: "nope", direction: "right", want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := FindBlockInDirection(tt.geoms, tt.source, tt.direction)
			if got != tt.want {
				t.Errorf("FindBlockInDirection(%q, %q) = %q, want %q", tt.source, tt.direction, got, tt.want)
			}
		})
	}
}

// TestFocusedMagnifiedMapping verifies node-id -> block-id resolution for the
// focused/magnified flags when the layout tree is missing entirely.
func TestFocusedMagnifiedMapping(t *testing.T) {
	leafOrder := []waveobj.LeafOrderEntry{
		{NodeId: "node-a", BlockId: "block-1"},
		{NodeId: "node-b", BlockId: "block-2"},
		{NodeId: "node-c", BlockId: "block-3"},
	}
	info := NewBlockLayoutInfo()
	computeBlockLayoutInfo(info, nil, leafOrder, "node-b", "node-c")

	if len(info.Index) != 3 {
		t.Fatalf("index count = %d, want 3", len(info.Index))
	}
	if info.Index["block-1"] != 1 || info.Index["block-2"] != 2 || info.Index["block-3"] != 3 {
		t.Errorf("index = %v, want block-1=1 block-2=2 block-3=3", info.Index)
	}
	if !info.Focused["block-2"] {
		t.Errorf("block-2 not focused")
	}
	if info.Focused["block-1"] || info.Focused["block-3"] {
		t.Errorf("unexpected focused flags: %v", info.Focused)
	}
	if !info.Magnified["block-3"] {
		t.Errorf("block-3 not magnified")
	}
	if info.Magnified["block-1"] || info.Magnified["block-2"] {
		t.Errorf("unexpected magnified flags: %v", info.Magnified)
	}
	if len(info.Geometry) != 0 {
		t.Errorf("geometry should be empty for nil root, got %v", info.Geometry)
	}
}
