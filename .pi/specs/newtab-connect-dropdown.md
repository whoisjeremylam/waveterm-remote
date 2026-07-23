# New-Tab Connection Dropdown: Typeahead + Frecency Sort

**Date:** 2026-07-21
**Status:** Ready
**Related:** `.pi/specs/tab-name-from-connection.md` (tab naming, already shipped)

## [S1] Problem

Three issues with the `+ New Tab` connection dropdown and the terminal-block-header connection dropdown:

1. **No keyboard-driven filtering.** The `+ New Tab` dropdown (`frontend/app/tab/connectiondropdown.tsx`) is a bare static list — no text entry, no filter, no arrow-key navigation, no Enter-to-select. The block-header dropdown (`conntypeahead.tsx`) already has a `TypeAheadModal`, but the new-tab dropdown does not, so they behave differently.
2. **`Cmd-t` opens a local tab directly**, bypassing the dropdown. Users with many SSH connections cannot use the keyboard to pick a remote host for a new tab.
3. **Unpredictable sort order.** The new-tab dropdown renders connections in backend order (`conncontroller.GetConnectionsList()`), which concatenates four buckets (currentlyRunning, hasConnected, fromInternal, fromConfig) with first-seen dedup. Within the top three buckets the order is **non-deterministic** (Go map iteration), so the list reshuffles between runs. The block-header dropdown sorts by `display:order` only. Neither learns from usage.
4. **Missing "Edit Connections" in `+ New Tab`** — the block-header dropdown has it; the new-tab dropdown does not.
5. **"Disconnect" item in the block-header dropdown** is being removed per product decision (disconnect is reachable elsewhere; the dropdown should be for switching/opening, not tearing down).

## [S2] Goals

- `+ New Tab` dropdown becomes a **typeahead**: text input auto-focused on open, case-insensitive substring filter, ↑/↓ navigation, Enter selects, Escape closes.
- **`Cmd-t` opens the dropdown** instead of creating a local tab directly.
- **Frecency sort** (frequency + recency) ranks connections by usage, with `display:order` → name as tie-break. Same ranking in both dropdowns.
- **Persist usage counts** across restarts so frecency accumulates over time.
- **"New Connection" fallback** when the typed text matches nothing — but **not highlighted by default**; the user must arrow down to it before Enter can create it (prevents accidental creates from fast typing).
- **"Edit Connections"** added to the `+ New Tab` dropdown (opens `connections.json` in the **current** tab); **removed** from the block-header dropdown.
- Horizontal (`tabbar.tsx`) and vertical (`vtabbar.tsx`) tab bars behave identically.

## [S3] Architecture

### Shared suggestion module

Extract the suggestion-building helpers from `conntypeahead.tsx` into a new shared module: `frontend/app/modals/conn-suggestions.ts`.

Moved/exported from `conntypeahead.tsx`:
- `filterConnections(connList, filterText, fullConfig, filterOutNowsh)` — **made case-insensitive** (current impl is case-sensitive; change `conn.includes(connSelected)` to a case-insensitive match).
- `sortConnSuggestionItems(items, fullConfig, connStatusMap)` — **rewritten** to compute frecency score (see [S4]) using `connStatusMap` for `ConnectCount`/`LastConnectTime`, tie-break by `display:order` then name.
- `createRemoteSuggestionItems(...)`, `createWslSuggestionItems(...)`, `createFilteredLocalSuggestionItem(...)`, `getNewConnectionSuggestionItem(...)`, `getConnectionsEditItem(...)`.

New (new-tab only):
- `buildNewTabSuggestions(connList, wslList, connSelected, fullConfig, connStatusMap, opts)` → returns `SuggestionsType[]` for the new-tab dropdown: `[Local section, Remote section, Edit Connections, New Connection (if no match)]`. **No** Reconnect, **no** Disconnect.

`conntypeahead.tsx` keeps its block-specific helpers (`getReconnectItem`) and imports the shared ones. It **removes** `getDisconnectItem` from its suggestions list (and deletes the function, since nothing else uses it).

### Frecency sort

`sortConnSuggestionItems(items, fullConfig, connStatusMap)` sorts each section's items by descending frecency score:

```
score = connectCount × recencyMultiplier(now - lastConnectTime)
recencyMultiplier(age) = exp(-ageDays / 14)     // half-life 14 days
```

where:
- `connectCount` and `lastConnectTime` come from `ConnStatus` (new fields — see [S5]).
- `ageDays = (now - lastConnectTime) / 86400000`, clamped to ≥ 0. If `lastConnectTime == 0` (never connected), `recencyMultiplier = 0`.
- Tie-break: ascending `display:order` (from `connections[connName]["display:order"]`, default `0`), then ascending `connName` (locale-aware `localeCompare`).

Within-section sort only. Section order (Local, Remote, ...) is fixed. The "Local" section's single item (the localhost display name) has no frecency — it stays at the top of the Local section.

### New-tab typeahead renderer

Replace `frontend/app/tab/connectiondropdown.tsx` with a typeahead renderer. It portals to `document.body` and anchors to the `+` button ref (reuse the existing fixed-position anchoring from `connectiondropdown.tsx`). It does **not** use `TypeAheadModal` directly, because `TypeAheadModal` portals into a `blockRef` and positions relative to a block — there is no block in the tab bar. Instead, build a self-contained typeahead component (`NewTabConnTypeahead`) that:
- Autofocuses its `<input>` on mount (unconditional — no block focus gating).
- Reuses the shared `buildNewTabSuggestions` + `filterConnections` + `sortConnSuggestionItems`.
- Renders `SuggestionsType[]` (sections + items) the same way `Suggestions` in `typeaheadmodal.tsx` does.
- Keyboard: ↑/↓ moves `rowIndex` across the flattened `selectionList`; Enter selects `selectionList[rowIndex]` **if `rowIndex` points at a selectable item** (see [S6] for the New Connection guard); Escape closes.
- Click backdrop closes.

Both `tabbar.tsx` and `vtabbar.tsx` render `<NewTabConnTypeahead>` when the dropdown atom is open, anchored to their respective `+` button refs.

### Global dropdown-open atom

Add to `frontend/app/store/global-atoms.ts`:

```ts
const newTabDropdownOpenAtom = atom(false) as PrimitiveAtom<boolean>;
```

Export it via the `atoms` object (same pattern as `modalOpen`, `reinitVersion`). `TabBar`/`VTabBar` read this atom instead of local `useState`, so `Cmd-t` (in `keymodel.ts`) can open it.

`keymodel.ts` `Cmd:t` handler changes from:
```ts
createTab();
```
to:
```ts
globalStore.set(atoms.newTabDropdownOpenAtom, true);
```

The `+` button `onClick` toggles the same atom. Selecting an item / closing the backdrop / Escape sets it back to `false`.

## [S4] Frecency data flow

```
conncontroller.go (on successful connect)
    conn.LastConnectTime = now
    conn.ConnectCount++                      // new in-memory field
    wconfig.SetConnectionsConfigValue(name, {
        "conn:connectcount":  conn.ConnectCount,
        "conn:lastconnecttime": conn.LastConnectTime,
    })                                        // persist to connections.json

ConnStatus (RPC) exposes ConnectCount + LastConnectTime
    ↓ frontend connStatusMap (existing)
sortConnSuggestionItems reads connStatusMap.get(connName) → score
```

`ConnectCount` is loaded from `connections.json` into `ConnController` at startup (in the existing connection-init path that reads `ConnKeywords`), so it survives restarts. `LastConnectTime` remains in-memory (it's a runtime timestamp; persisting it would conflict with the in-memory `Status` lifecycle and isn't needed for frecency across restarts — `ConnectCount` carries the long-term signal, and `LastConnectTime` re-populates within seconds of reconnect).

**Rationale for splitting persistence:** `LastConnectTime` is already overwritten on every connect and is meaningless before the first post-restart connect. Persisting only `ConnectCount` keeps the schema minimal and avoids a stale-timestamp edge case where a freshly-restarted app shows a host as "last used 3 days ago" until you reconnect. `ConnectCount` is the durable frequency signal; `LastConnectTime` is the session-scoped recency signal. Both feed the score, and the math degrades gracefully: after restart, a host with `ConnectCount=20` but `LastConnectTime=0` scores `20 × 0 = 0` until first reconnect — acceptable, because on a fresh session the user hasn't demonstrated recency for *any* host yet, so `display:order` → name takes over as tie-break (deterministic, predictable cold start).

## [S5] Files changed

### Backend (Go)

| File | Change |
|---|---|
| `pkg/remote/conncontroller/conncontroller.go` | Add `ConnectCount int64` field to `ConnController` struct. On successful connect (`Status_Connected` block ~line 938), increment it and persist via `wconfig.SetConnectionsConfigValue`. Add a loader in the connection-init path that reads `conn:connectcount` from `connections.json` into the field. |
| `pkg/wshrpc/wshrpctypes.go` | Add `ConnectCount int64` and `LastConnectTime int64` fields to the `ConnStatus` struct (JSON `connectcount`, `lastconnecttime`). Populate in `DeriveConnStatus`. |
| `pkg/wconfig/settingsconfig.go` | Add `ConnConnectCount *int64` (`json:"conn:connectcount,omitempty"`) and `ConnLastConnectTime *int64` (`json:"conn:lastconnecttime,omitempty"`) to `ConnKeywords`. *(LastConnectTime persisted is optional — see [S4]; include the field for symmetry but only write it if we decide to persist. Default: don't persist, keep field for forward-compat/read.)* |

### Frontend (TS/React)

| File | Change |
|---|---|
| `frontend/app/modals/conn-suggestions.ts` (new) | Shared suggestion builders + frecency sort + `buildNewTabSuggestions`. |
| `frontend/app/modals/conntypeahead.tsx` | Import shared helpers. Remove `getDisconnectItem` and its inclusion in the suggestions list. Keep `getReconnectItem` (block-specific). Change `filterConnections` usage to case-insensitive (via shared module). |
| `frontend/app/tab/connectiondropdown.tsx` | Rewrite as `NewTabConnTypeahead` (typeahead with input, filter, keyboard nav, frecency-sorted suggestions, Edit Connections, guarded New Connection). Portals to `document.body`, anchors to `+` button ref. |
| `frontend/app/tab/tabbar.tsx` | Replace `showConnectionDropdown` `useState` with `newTabDropdownOpenAtom`. Render `<NewTabConnTypeahead anchorRef={addBtnRef} .../>` when open. `+` button toggles atom. |
| `frontend/app/tab/vtabbar.tsx` | Same changes as `tabbar.tsx`, anchored to `newTabBtnRef`. |
| `frontend/app/store/global-atoms.ts` | Add `newTabDropdownOpenAtom`. |
| `frontend/app/store/keymodel.ts` | `Cmd:t` handler: `globalStore.set(atoms.newTabDropdownOpenAtom, true)` instead of `createTab()`. |

### No version bump required

No new wsh RPC command, no breaking RPC type change (adding fields to `ConnStatus` is additive). `ConnListCommand` return shape is unchanged (still `[]string`).

## [S6] New Connection fallback — guard against accidental create

When the typed filter text matches zero connections, append a `New Connection` suggestion item:
```
label: `<text> (New Connection)`
icon: plus
```
**`onSelect`** (click or Enter): `env.electron.createTab(connName)` where `connName` is the typed text (empty string → local; non-empty → treated as an SSH host string by `CreateTab`).

**Highlight guard:** the flattened `selectionList` for keyboard navigation excludes the New Connection item from the default `rowIndex` range. Specifically:
- Compute `selectableItems` = all items **except** the New Connection item.
- `rowIndex` clamps to `[0, selectableItems.length - 1]` (so ↑ at top stays at 0, ↓ at bottom wraps or stops — match `conntypeahead`'s `Math.min(idx + 1, len - 1)` behavior).
- Enter when the New Connection item is *not* explicitly focused selects `selectableItems[rowIndex]`.
- The New Connection item is only actionable via an **explicit arrow-down past the last selectable item** (one more ↓ moves `rowIndex` to point at the New Connection item, visually highlighted distinctly) **or a mouse click**. This is the subtlety: fast typing + Enter never creates a new connection; the user must deliberately navigate to it.

This requires the renderer to track two index spaces: `selectableIndex` (for the frecency-sorted real connections) and a sentinel position for New Connection. Implementation detail left to the typeahead component, but the contract is: **Enter on the default-highlighted item never creates a new connection.**

## [S7] Keyboard map

| Key | Action |
|---|---|
| Type | Filter list (case-insensitive substring) |
| ↑ | Move highlight up (clamps to top) |
| ↓ | Move highlight down; past the last real item → highlights New Connection (if shown) |
| Enter | Select highlighted item. If highlighted is New Connection, create tab with typed text as connName. Otherwise create tab with the item's connName. |
| Escape | Close dropdown, no tab created |
| Click item | Select that item (New Connection clickable too) |
| Backdrop click | Close dropdown |

## [S8] Testing

Manual test matrix (no existing automated tests for these dropdowns — first coverage):

1. **Frecency ordering**: connect to `db` 5×, `web` 2×, `cache` 1×. Open `+ New Tab` → order should be `db, web, cache` (higher count × recency first). Connect to `cache` once more now → `cache` should jump above `web` (recency boost) even though `web` has higher count. Wait — verify: with half-life 14 days and same-session timestamps, `cache` (1×, just now) scores `1 × ~1.0 = 1.0`; `web` (2×, earlier today) scores `2 × ~0.9 = 1.8`. So `web` stays above `cache`. To force `cache` above, it needs comparable count or much more recency. **Test with controlled timestamps** in unit tests (see below).
2. **Persistence**: connect to `db` 3×, restart the app, reconnect once → `ConnectCount` should still be ≥3 (loaded from `connections.json`). Frecency ranking should reflect accumulated count.
3. **Cold start**: brand-new install, no connections ever used → all `ConnectCount=0`, `LastConnectTime=0` → sort falls back to `display:order` → name. Deterministic, not random.
4. **`display:order` tie-break**: two connections with equal frecency score (both never used) → the one with lower `display:order` sorts first; equal order → alphabetical.
5. **Typing + Enter**: type `db` → only `db`-matching items shown → Enter → new tab connects to top match. **No accidental New Connection.**
6. **No-match + Enter**: type `xyznotreal` → only `New Connection` shown, **not highlighted** → Enter does nothing (or closes, per design — see [S6]); must ↓ to highlight New Connection, then Enter → creates tab with `xyznotreal`.
7. **No-match + ↓ + Enter**: type `xyznotreal` → ↓ → New Connection highlighted → Enter → new tab, terminal connects to `xyznotreal`.
8. **`Cmd-t`**: opens dropdown with input focused (no local tab created). Type, Enter → tab created with selected connection.
9. **`+` click**: same as `Cmd-t`.
10. **Edit Connections** (`+` dropdown): click gear item → `connections.json` waveconfig block opens in current tab; dropdown closes.
11. **Edit Connections removed** (block header): open a terminal block's connection dropdown → no "Edit Connections" item in the list.
12. **Disconnect removed** (block header): open a terminal block's connection dropdown while connected → no "Disconnect" item.
13. **Reconnect kept** (block header): disconnect a durable session, open block-header dropdown → "Reconnect to …" item still present.
14. **Case-insensitive filter**: type `DB` matches `db-prod` (currently case-sensitive in block header — verify the shared filter fixes both).
15. **Vertical tab bar parity**: repeat tests 5–10 with the vertical tab bar (`window:tabstyle=vertical`) — identical behavior.

Unit tests (Go, `conncontroller_test.go`):
- `frecencyScore(connectCount, lastConnectTimeMs, now)` pure function — table-driven covering: zero count, zero time, recent high-count, old high-count, decay boundary.
- `ConnStatus.DeriveConnStatus` exposes `ConnectCount`/`LastConnectTime`.
- Persistence round-trip: `SetConnectionsConfigValue` writes `conn:connectcount`, re-read via `GetConnectionsFromInternalConfig`/config parse yields the same count.

## [S9] Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Sort algorithm | Frecency (count × recency) + `display:order`/name tie-break | Raycast/Alfred-style; learns from usage |
| Recency decay | Continuous exponential, half-life 14 days (`exp(-ageDays/14)`) | Smooth, no hard bucket edges |
| Persist `ConnectCount` | Yes, in `connections.json` via `conn:connectcount` | Frecency accumulates over weeks |
| Persist `LastConnectTime` | No (in-memory only) | Avoids stale-timestamp edge case; recency re-populates on first reconnect |
| Filter case sensitivity | Case-insensitive (both dropdowns) | Matches Raycast/Alfred; strictly better for SSH hostnames |
| New Connection guard | Not highlighted by default; explicit ↓ required | Prevents accidental creates from fast typing |
| Edit Connections (`+` dropdown) | Opens in current tab | Simple; matches block-header behavior |
| Edit Connections (block header) | Removed | Per product decision |
| Disconnect (block header) | Removed | Per product decision; reachable elsewhere |
| Reconnect (block header) | Kept | Block-specific (reconnect a disconnected durable session); not relevant to new-tab |
| `Cmd-t` | Opens dropdown (global atom) | Keyboard parity with `+` click |
| Both tab bars | Identical behavior via shared `NewTabConnTypeahead` | Parity requirement |
| No version bump | Additive `ConnStatus` fields, no new RPC | No breaking protocol change |