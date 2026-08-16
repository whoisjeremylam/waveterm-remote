# AI Agent Browsers & Browser-Control Patterns — Research Report

Date: 2026-08-16. Focus: how existing "AI agent browsers" control a browser, deep dive on `ego`/`ego-lite`, and the easiest way to control an Electron `<webview>` and expose it to agents.

---

## 1. Survey

| Project | Repo / URL | Browser-control mechanism | Observation → action loop (high level) |
|---|---|---|---|
| **ego / ego-lite** (CitroLabs) | https://github.com/citrolabs/ego-lite | Raw **CDP** through a native in-browser `globalThis.ego` bridge (no Playwright/Puppeteer). Hand-written Playwright-style JS facades. | Agent writes JS snippets (`ego-browser nodejs <<EOF`) calling `snapshot`/`snapshotText` (AX-tree text + `@N` refs), `click`, `fill`, `js`, `cdp`; browser returns text/result. Visual fallback via `captureScreenshot` + coordinates. |
| **browser-use (BrowserUse)** | https://github.com/browser-use/browser-use | Python; historically **Playwright**, now moving to its own CDP-based engine + cloud. DOM/accessibility state extraction (+ optional screenshot + vision model). | Loop: fetch "browser state" (DOM/AX + screenshot) → LLM → emit typed actions (`click`, `input`, `go_to_url`, …) → re-observe. |
| **Skyvern** | https://github.com/Skyvern-AI/skyvern | Python; **Playwright**. DOM tree + **screenshots + vision** for element localization. | Task/workflow-driven: LLM generates a sequence of browser actions from a goal; executes and re-screenshots to verify. |
| **Stagehand** (Browserbase) | https://github.com/browserbase/stagehand | TypeScript on top of **Playwright**. `act()` / `extract()` / `observe()` primitives; DOM-first + optional vision. | Developer calls `act("click login")`; framework uses LLM to map intent → Playwright actions, caches selectors. |
| **Browserbase** | https://www.browserbase.com | Cloud browser infra — remote Chromium exposed over **CDP WebSocket**; driven by Playwright/Stagehand/Puppeteer. | Not a local browser; "browser as a service". Agents connect a Playwright/Stagehand client to a remote CDP endpoint. |
| **OpenHands browser agent** | https://github.com/All-Hands-AI/OpenHands | Uses **BrowserGym** over **Playwright** (Chromium) inside a sandbox. | Agent toolkit exposes `browse`/`browse_interactive`; each step queries the browser for content and sends an action. |
| **Playwright MCP** | https://github.com/microsoft/playwright-mcp | MCP server wrapping **Playwright**; `browser_snapshot` = **ARIA accessibility snapshot**; can attach to an existing browser via `--cdp-endpoint`. | LLM calls MCP tools (`browser_navigate`, `browser_snapshot`, `browser_click` on `ref=` handles). |
| **Chrome DevTools MCP** | https://github.com/ChromeDevTools/chrome-devtools-mcp | MCP server; **Puppeteer** `connect()` to Chrome/Chromium over **CDP WebSocket**; `SnapshotFormatter` turns CDP AX tree into text with UIDs. | LLM calls tools (`navigate`, `snapshot`, `click` on uid, `evaluate`); also exposes network/console/perf. |
| **agent-browser (Vercel)** | https://github.com/vercel-labs/agent-browser | Rust CLI driving headless Chromium over **CDP**; "compressed semantic input" (AX tree). | CLI tools return a compact accessibility snapshot with refs; agent clicks/reads via refs. |

**Common threads**: almost all converge on (1) CDP as the transport, and (2) an **accessibility-tree snapshot** as the token-efficient observation, with (3) screenshots + a vision model as a fallback for canvas/visual apps. The split is only where the CDP endpoint lives (own process vs. attach-to-existing-browser) and whether the agent writes code (ego-lite, Stagehand) or emits discrete tool calls (Playwright MCP, Chrome DevTools MCP, browser-use).

---

## 2. Ego / ego-lite deep dive

### What they actually are

- **"ego"** is the commercial product (ego.app / lite.ego.app): a macOS Chromium-based "browser-based personal assistant" from CitroLabs. The full "ego" app is **closed-source**; there is **no public `ego` repo**.
- **"ego-lite"** is the free/open-source tier. The repo `citrolabs/ego-lite` (MIT) contains **only the Node.js helper runtime + agent skill package**, **not** the browser binary. The browser itself ("ego lite" / "ego-browser") is a separate free macOS download (DMG from `cdn.ego.app`).
- So "ego-lite" is **not a separate simpler code path inside the repo** — it is a branding tier. There is only one public repo to clone: `citrolabs/ego-lite`.

Verification of the org's repos (GitHub API):

```
citrolabs/ego-lite                       (the open-source runtime + skill)
citrolabs/pi-chrome-use                  "A real-browser CDP execution extension for Pi agents"
citrolabs/ego-browser-benchmark-framework
```

### How it controls the browser

Direct **raw CDP**, with **no Puppeteer and no Playwright** (stated in `CONTRIBUTING.md`: "Browser transport: Chrome DevTools Protocol (CDP) directly — **no Puppeteer / Playwright**").

The transport is unusual: the browser app exposes a native **`globalThis.ego`** runtime object to the Node helper process, with methods like `sendCDPMessage(payload)`, `listTabs()`, `createTab()`, `snapshot(...)`, `useTaskSpace()`, etc. The helper layer wraps that in a Playwright-style facade.

```
ego-browser (Chromium) -> globalThis.ego -> Playwright-style helper facades -> agent heredoc
```

The connection is **not** `--remote-debugging-port` + WebSocket. It is an in-process native bridge from the browser to a short-lived Node process. Every CLI invocation is a **fresh Node process** that re-attaches to the persistent browser via CDP (`Target.attachToTarget { flatten: true }`).

### Observation → action loop

- **Observation** (what the LLM sees):
  - `snapshotText()` / `page.snapshot()` → the browser's own `ego.snapshot({ scope, includeActionMarks, includeStableLocator })`, which returns `{ content, refs }`. `content` is a full-page **accessibility-tree-derived text snapshot** annotated with `[ref=N, loc=..., url=...]` action marks. `refs` carry `backendNodeId`, `role`, `name` (see `browserSnapshotRefsToRefMap`).
  - `captureScreenshot()` → `Page.captureScreenshot` (CDP), saved to a PNG path, for the **visual workflow** (canvas apps, rich editors, maps).
  - `pageInfo()` → `{ url, title, w, h, sx, sy, pw, ph }` (or `{ dialog: ... }` if a native dialog is open).
- **Actions** (what the agent can emit — as JavaScript, not discrete tool calls):
  - Semantic: `click('@21')`, `fillInput('@N', …)`, `page.locator(...)`, `page.getByRole/getByText/…`, using `@N` refs, CSS, `xpath=…`, or stable `loc=css:/role:/href:…` values.
  - Visual: `click([x,y])`, `typeText`, `pressKey` (coordinates + real keyboard).
  - Raw: `js(...)` = `Runtime.evaluate`, `cdp(method, params)` = arbitrary CDP.
- **The agent writes code**: the model emits a JavaScript snippet; the helper executes it in one pass and prints results via `cliLog(...)`. This is ego-lite's core design bet ("code base, not CLI base") — compose a multi-step task into one script instead of a per-step tool-call loop.

### The "ego-lite vs ego" distinction, corrected

- `ego` = closed-source full app (product).
- `ego-lite` = free tier + the open-source runtime/skill repo. The browser binary is shared/identical in behavior; "lite" refers to the free, no-account, MIT-runtime distribution.
- There is **no separate `ego` repo to clone**; only `citrolabs/ego-lite`.

---

## 3. Code inspection findings (cloned `/tmp/ego-lite`)

### Transport (raw CDP over the native `ego` bridge)

`package/ego-browser/src/browser-runtime.ts` — the CDP transport. Sends JSON CDP payloads through `globalThis.ego.sendCDPMessage` and resolves promises from `onCDPMessage`:

```ts
export function isBrowserRuntime() {
  return Boolean(globalThis.ego && typeof globalThis.ego.sendCDPMessage === "function");
}
function rawCdp(method, params: any = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
  const runtime = browserEgo();
  runtime.onCDPMessage = handleMessage;
  ...
  const id = nextMessageId++;
  const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
  ...
  runtime.sendCDPMessage(payload);
}
```

Session management (`ensureSession`) attaches to a tab via `Target.attachToTarget { targetId, flatten: true }`:

```ts
const attached = await rawCdp("Target.attachToTarget", { targetId, flatten: true }, undefined);
state.sessionId = attached.result?.sessionId || attached.sessionId;
```

### JS evaluation

`package/ego-browser/src/cdp-eval.ts` — `evaluate()` and `js()` are `Runtime.evaluate` with `returnByValue: true`:

```ts
const response = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId);
```

### Helper facade surface

`package/ego-browser/src/helpers.ts` — composes the agent-facing API: `page` (goto/url/locator/getByRole/getByText/snapshot/screenshot/evaluate/…), `browser` (tabs), `taskSpaces`, `site` (learnings), `fetch`, `cdp`, plus legacy globals (`click`, `fill`, `snapshotText`, `js`, …). Locators are Playwright-style but hand-implemented (see `createLocator`, `roleSelector`, `textSelector`).

### CLI entry / stateless execution

`package/ego-browser/src/run.ts` — reads a stdin heredoc, wraps it in `AsyncFunction`, injects all helpers as named args:

```ts
const fn = new AsyncFunction(...names, `"use strict";\n${code}`);
await fn(...values);
```

`package/ego-browser/src/index.ts` — `installEgoSdk()` (SDK path inside the browser) vs `isDirectCli()` (heredoc path). The `LEGACY_GLOBAL_HELPERS` list enumerates the exact exposed helper names (`click`, `snapshotText`, `js`, `cdp`, `browserFetch`, …).

### Snapshot (the observation)

`package/ego-browser/src/driver/observe.ts`:

```ts
export async function snapshotRaw(options: SnapshotOptions = {}) {
  result = await browserEgo().snapshot(options);   // { content, refs }
  browserSnapshotRefsToRefMap(browserRefMap, result.refs || []);
  return result;
}
export async function snapshot(options: SnapshotOptions = {}) {
  const result = await snapshotRaw({ scope: "full_page", includeActionMarks: true, includeStableLocator: true });
  return result.content || "";                     // the text the LLM reads
}
```

Screenshot is `Page.captureScreenshot` (same file). Note: the heavy lifting of *producing* the snapshot is in the **closed-source browser** (`ego.snapshot`); the open-source repo only consumes it. The ref→node mapping is AX-based (role/name/backendNodeId).

### Element resolution (how `@N` refs become DOM nodes)

`package/ego-browser/src/element-resolver.ts`:

- `@N` ref → `DOM.getBoxModel { backendNodeId }` (or `DOM.resolveNode`) for click center.
- `loc=role:…` → `Accessibility.getFullAXTree`, match `node.role` / `node.name`, then `DOM.getBoxModel`.
- CSS / xpath / text / label → generated `Runtime.evaluate` JS (`document.querySelectorAll(...)`).

```ts
const result = await send(cdp, "Accessibility.getFullAXTree", params, effectiveSessionId);
```

`package/ego-browser/src/driver/element-ops.ts` — `Runtime.callFunctionOn` to run a function with the element bound as `this` (used for fill/attribute reads).

### Pointer / keyboard (how actions become input)

`package/ego-browser/src/driver/pointer.ts` — clicks are real CDP input events, with a JS-probe fallback:

```ts
await browserCdp("Input.dispatchMouseEvent", { type: "mouseMoved"/"mousePressed"/"mouseReleased", x, y, ... });
// fallback: if the CDP input wasn't observed, dispatch synthetic MouseEvents via Runtime.evaluate
```

Keyboard (`driver/keyboard.ts`) uses `Input.dispatchKeyEvent` / `Input.insertText`.

### Agent contract

`skills/ego-browser/SKILL.md` documents the three workflows the LLM is told to use: **(1) semantic** (`snapshotText()` + refs), **(2) visual** (`captureScreenshot()` + coordinates/keyboard), **(3) direct DOM/CDP** (`js()` / `cdp()`). It also defines the task-space model (isolated browsing contexts sharing the user's login state) and the user↔agent control-handoff protocol.

### Key takeaway for us

ego-lite's mechanism is, structurally, **exactly** what Electron already gives us: a host runtime that talks **raw CDP** to web contents, an **accessibility-tree snapshot** as the observation, and **Input.* / Runtime.evaluate / DOM.*** as the action surface. The only thing ego-lite adds that Electron doesn't have out of the box is (a) the `globalThis.ego` native bridge (Electron's equivalent is `webContents.debugger` in the main process + IPC), and (b) the task-space isolation layer.

---

## 4. Recommendation (Electron `<webview>`)

### Situation recap

- Wave is an Electron fork. `<webview>` renders a **guest WebContents**, distinct from the embedder page.
- Electron already exposes, per guest WebContents, in the **main process**:
  - `webContents.debugger.attach()` / `.sendCommand()` / `.on('message', …)` — full raw CDP (the same protocol ego-lite uses).
  - `webContents.executeJavaScript(code, userGesture)` — inject JS.
  - `webContents.capturePage()` — screenshot (or `Page.captureScreenshot` via debugger).
- `<webview>` guest WebContents is reachable in main via `webContents.fromId(webview.getWebContentsId())` (or the embedder's `did-attach-webview` event).
- `--remote-debugging-port` is available but exposes a global HTTP/WebSocket endpoint for the whole app (all WebContents), which is what Playwright/Puppeteer would need to attach.

### Option comparison

**(a) Direct CDP via `webContents.debugger` (recommended)**

- Pros: no new dependencies; per-guest control; full fidelity (Input dispatch, Runtime/DOM/Accessibility domains, `Page.captureScreenshot`, Network); works headless or headed; no global port exposure; maps 1:1 to ego-lite's exact mechanism (`globalThis.ego.sendCDPMessage` ≈ `webContents.debugger.sendCommand`).
- Cons: you must build the bridge (main-process ↔ Node helper ↔ agent) and implement session/event handling, snapshot formatting (AX tree → text with refs), and element resolution yourself (ego-lite's `browser-runtime.ts` + `element-resolver.ts` are a ready reference). One debugger attach per WebContents at a time (conflicts if user opens DevTools on that guest).

**(b) Playwright/Puppeteer attaching over CDP (`--remote-debugging-port`)**

- Pros: mature, high-level API, auto-waiting, built-in ARIA snapshots and selector engines — least code to a working prototype.
- Cons: requires launching Electron with `--remote-debugging-port` (exposes all WebContents to localhost); a heavy dependency; version drift vs Electron's bundled Chromium; Playwright treats the `<webview>` guest as just another "page" target, which can fight Wave's own webview lifecycle (attach/detach, navigation, DevTools). Best as a prototype shortcut, not the shipping design.

**(c) `executeJavaScript` injection**

- Pros: simplest; no debugger attach; good for DOM read/extract and DOM mutation.
- Cons: synthetic (untrusted) events can be ignored by strict sites; **no** `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` fidelity; can't read the AX tree or capture a screenshot via the same path; no dialogs/permissions handling. Insufficient as the sole mechanism for a general agent.

**(d) Accessibility-tree-only observation**

- Not an alternative transport — it's the observation *format*. Via `Accessibility.getFullAXTree` (CDP) or Playwright's aria snapshot. Best combined with (a)/(b). On its own it can't act; it must pair with a click/type mechanism and a screenshot fallback for canvas/visual apps.

### Recommendation

**Build the control fabric on (a): direct CDP through `webContents.debugger`, wrapped in an ego-lite-style runtime, exposed to agents over Wave's existing Electron IPC.**

Concretely, mirror ego-lite's shape:

1. **Runtime in main process**: a small "browser control" service that, given a guest `webContents` (from `<webview>`), calls `debugger.attach()` and implements `sendCDPMessage`/event dispatch — i.e., the equivalent of ego-lite's `browser-runtime.ts`, but backed by `webContents.debugger` instead of `globalThis.ego`.
2. **Observation**: `Accessibility.getFullAXTree` → format into a compact snapshot with `@N`/`ref=` action marks (backendNodeId-based), plus `Page.captureScreenshot` (or `webContents.capturePage`) for the visual fallback. This is ego-lite's `observe.ts` + `element-resolver.ts`.
3. **Actions**: `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, `Runtime.evaluate` / `Runtime.callFunctionOn`, `DOM.resolveNode` / `DOM.getBoxModel`, `Page.navigate`. This is ego-lite's `pointer.ts` / `keyboard.ts` / `element-ops.ts`.
4. **Expose to the agent**: either (i) a Node helper process driven by stdin heredocs (exactly ego-lite's `run.ts` model — lowest impedance since Wave already has a Go backend + wsh RPC and an Electron main bridge), or (ii) a typed RPC/tool surface (MCP-style) if you prefer discrete tool calls. Given the existing fork work, the heredoc/"code base" model is the smallest delta and matches what the user already identified as closest to our intent.
5. **Isolation (later)**: ego-lite's "task spaces" (isolated browsing contexts sharing the profile) can be approximated with per-agent `<webview>` instances + Wave's existing per-connection state, and a user↔agent control-handoff flag (mirroring `handOffTaskSpace`/`takeOverTaskSpace`).

**Pragmatic sequencing**: start with (a) + AX snapshot + `Runtime.evaluate`/`Input.*` behind a minimal IPC bridge — that is the whole useful core and is small. Add screenshots and a vision-model fallback only for the canvas/rich-editor cases (the same reason ego-lite has a "visual workflow"). Revisit (b)/Playwright only if you need heavy selector/auto-waiting ergonomics quickly and are willing to run `--remote-debugging-port` locally.

> Note: `citrolabs/pi-chrome-use` ("a real-browser CDP execution extension for Pi agents") is independent corroboration that the "attach to an existing real browser over CDP + AX snapshot + JS eval" pattern — which is exactly the ego-lite architecture and exactly what `webContents.debugger` gives us — is the current convergent design for browser control by coding agents.
