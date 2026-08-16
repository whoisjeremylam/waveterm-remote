// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// BlockLayoutInfo holds per-block layout facts computed from a tab's layout
// tree. All maps are keyed by blockId. A block only appears in a map when the
// corresponding fact is known (e.g. Geometry stays empty for a malformed tree,
// while Index is still populated from LeafOrder).
type BlockLayoutInfo struct {
	Geometry  map[string]*wshrpc.BlockGeometry
	Focused   map[string]bool
	Magnified map[string]bool
	Index     map[string]int
}

// NewBlockLayoutInfo returns an empty (non-nil) BlockLayoutInfo.
func NewBlockLayoutInfo() *BlockLayoutInfo {
	return &BlockLayoutInfo{
		Geometry:  make(map[string]*wshrpc.BlockGeometry),
		Focused:   make(map[string]bool),
		Magnified: make(map[string]bool),
		Index:     make(map[string]int),
	}
}

// ComputeBlockGeometry loads the layout state for the given tab and computes
// flat geometry (x/y/w/h fractions), focused, magnified, and 1-indexed leaf
// order for every leaf block. It never fails on a missing/malformed tree: such
// tabs yield an empty (but non-nil) BlockLayoutInfo.
func ComputeBlockGeometry(ctx context.Context, tabId string) (*BlockLayoutInfo, error) {
	info := NewBlockLayoutInfo()

	tabObj, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return nil, fmt.Errorf("unable to load tab %s for geometry: %w", tabId, err)
	}
	if tabObj == nil || tabObj.LayoutState == "" {
		return info, nil
	}

	layoutState, err := wstore.DBGet[*waveobj.LayoutState](ctx, tabObj.LayoutState)
	if err != nil {
		return nil, fmt.Errorf("unable to load layout state %s for geometry: %w", tabObj.LayoutState, err)
	}
	if layoutState == nil {
		return info, nil
	}

	var leafOrder []waveobj.LeafOrderEntry
	if layoutState.LeafOrder != nil {
		leafOrder = *layoutState.LeafOrder
	}

	computeBlockLayoutInfo(info, layoutState.RootNode, leafOrder, layoutState.FocusedNodeId, layoutState.MagnifiedNodeId)
	return info, nil
}

// FindBlockInDirection returns the blockId geometrically to the given
// direction of sourceBlockId, or "" if none. geoms is a map of block geometry
// keyed by blockId (as produced by ComputeBlockGeometry). Direction must be one
// of "left", "right", "above", "below"; any other value returns "".
//
// Candidate selection uses center-point comparison plus axis overlap:
//   - right: candidate center-x is to the right AND vertical overlap; the
//     candidate with the smallest center-x (closest) wins.
//   - left: center-x to the left AND vertical overlap; largest center-x wins.
//   - above: center-y above AND horizontal overlap; largest center-y wins.
//   - below: center-y below AND horizontal overlap; smallest center-y wins.
//
// The source block itself is always skipped.
func FindBlockInDirection(geoms map[string]*wshrpc.BlockGeometry, sourceBlockId, direction string) string {
	src := geoms[sourceBlockId]
	if src == nil {
		return ""
	}
	srcCX := src.X + src.W/2
	srcCY := src.Y + src.H/2

	var bestId string
	bestDist := 0.0
	haveBest := false

	for blockId, cand := range geoms {
		if blockId == sourceBlockId || cand == nil {
			continue
		}
		candCX := cand.X + cand.W/2
		candCY := cand.Y + cand.H/2

		// dist is the candidate's center coordinate, negated when "closest"
		// means the largest coordinate, so a single minimum search works for
		// every direction.
		var dist float64
		switch direction {
		case "right":
			if candCX <= srcCX {
				continue
			}
			if !(cand.Y < src.Y+src.H && cand.Y+cand.H > src.Y) {
				continue
			}
			dist = candCX
		case "left":
			if candCX >= srcCX {
				continue
			}
			if !(cand.Y < src.Y+src.H && cand.Y+cand.H > src.Y) {
				continue
			}
			dist = -candCX
		case "above":
			if candCY >= srcCY {
				continue
			}
			if !(cand.X < src.X+src.W && cand.X+cand.W > src.X) {
				continue
			}
			dist = -candCY
		case "below":
			if candCY <= srcCY {
				continue
			}
			if !(cand.X < src.X+src.W && cand.X+cand.W > src.X) {
				continue
			}
			dist = candCY
		default:
			return ""
		}

		if !haveBest || dist < bestDist {
			haveBest = true
			bestDist = dist
			bestId = blockId
		}
	}

	if !haveBest {
		return ""
	}
	return bestId
}

// layoutRect is a rectangle in fractions of the tab (0..1).
type layoutRect struct {
	x, y, w, h float64
}

// computeBlockLayoutInfo walks the layout tree and populates info. It is pure
// (no DB access) so tests can pass synthetic trees.
func computeBlockLayoutInfo(info *BlockLayoutInfo, rootNode any, leafOrder []waveobj.LeafOrderEntry, focusedNodeId, magnifiedNodeId string) {
	// Index is the 1-indexed position in LeafOrder. Focused/magnified are
	// stored by node id on the layout state, so map node id -> block id here.
	for i, entry := range leafOrder {
		if entry.BlockId == "" {
			continue
		}
		info.Index[entry.BlockId] = i + 1
		if focusedNodeId != "" && entry.NodeId == focusedNodeId {
			info.Focused[entry.BlockId] = true
		}
		if magnifiedNodeId != "" && entry.NodeId == magnifiedNodeId {
			info.Magnified[entry.BlockId] = true
		}
	}

	root, ok := asLayoutNode(rootNode)
	if !ok {
		return
	}
	walkLayoutGeometry(info, root, layoutRect{0, 0, 1, 1})
}

// walkLayoutGeometry recursively computes each leaf's rect. For a split node,
// "row" divides the width among children (side-by-side) and "column" divides
// the height (stacked), matching frontend/layout/lib/layoutModel.ts.
func walkLayoutGeometry(info *BlockLayoutInfo, node map[string]any, r layoutRect) {
	// Leaf: data.blockId identifies the block whose rect is r.
	if data, ok := asLayoutNode(node["data"]); ok {
		if blockId := layoutNodeString(data, "blockId"); blockId != "" {
			info.Geometry[blockId] = &wshrpc.BlockGeometry{X: r.x, Y: r.y, W: r.w, H: r.h}
		}
		return
	}

	children, ok := node["children"].([]any)
	if !ok || len(children) == 0 {
		return
	}

	total := 0.0
	for _, c := range children {
		if cm, ok := asLayoutNode(c); ok {
			total += layoutNodeFloat(cm, "size")
		}
	}
	if total <= 0 {
		return
	}

	// Default (missing/unknown) flexDirection matches the frontend default "row".
	isColumn := layoutNodeString(node, "flexDirection") == "column"

	x, y := r.x, r.y
	for _, c := range children {
		cm, ok := asLayoutNode(c)
		if !ok {
			continue
		}
		size := layoutNodeFloat(cm, "size")
		var childRect layoutRect
		if isColumn {
			h := r.h * size / total
			childRect = layoutRect{r.x, y, r.w, h}
			y += h
		} else {
			w := r.w * size / total
			childRect = layoutRect{x, r.y, w, r.h}
			x += w
		}
		walkLayoutGeometry(info, cm, childRect)
	}
}

// asLayoutNode asserts that v is a JSON object (map[string]any).
func asLayoutNode(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

// layoutNodeString returns the string value at key, or "".
func layoutNodeString(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// layoutNodeFloat returns the numeric value at key as a float64, or 0. JSON
// numbers unmarshal into float64, but accept int/int64/float32 too for
// synthetic trees built in tests.
func layoutNodeFloat(m map[string]any, key string) float64 {
	switch v := m[key].(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	default:
		return 0
	}
}
