// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setBadge } from "@/app/store/badge";
import { getFileSubject } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    fetchWaveFile,
    getApi,
    getOverrideConfigAtom,
    getSettingsKeyAtom,
    globalStore,
    isDev,
    openLink,
    WOS,
} from "@/store/global";
import * as services from "@/store/services";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { base64ToArray, fireAndForget } from "@/util/util";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import * as TermTypes from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import debug from "debug";
import * as jotai from "jotai";
import { debounce } from "throttle-debounce";
import {
    handleOsc16162Command,
    handleOsc52Command,
    handleOsc7Command,
    isClaudeCodeCommand,
    type ShellIntegrationStatus,
} from "./osc-handlers";
import {
    bufferLinesToText,
    createTempFileFromBlob,
    extractAllClipboardData,
    normalizeCursorStyle,
    quoteForPosixShell,
    trimTerminalSelection,
} from "./termutil";

const dlog = debug("wave:termwrap");

const TermFileName = "term";
const TermCacheFileName = "cache:term:full";
const MinDataProcessedForCache = 100 * 1024;
export const SupportsImageInput = true;
const MaxRepaintTransactionMs = 2000;

// Minimal TIFF decoder for IIP rendering (chafa sends TIFF for --format=iterm2)
function decodeTiffFallback(d: Uint8Array): { width: number; height: number; pixels: Uint8ClampedArray } | null {
    if (d.length < 8) return null;
    const le = d[0] === 0x49;
    const u16 = (o: number) => le ? (d[o] | (d[o + 1] << 8)) : ((d[o] << 8) | d[o + 1]);
    const u32 = (o: number) => le
        ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0
        : ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
    if (u16(2) !== 42) return null;
    const ifo = u32(4);
    if (ifo + 2 > d.length) return null;
    const n = u16(ifo);
    let w = 0, h = 0, comp = 1, bps = 8, spp = 3, photo = 2;
    const so: number[] = [], sl: number[] = [];
    let rps = 0;
    for (let i = 0; i < n; i++) {
        const eo = ifo + 2 + i * 12;
        if (eo + 12 > d.length) break;
        const tag = u16(eo), typ = u16(eo + 2), cnt = u32(eo + 4);
        const vs = typ === 3 ? 2 : typ === 4 ? 4 : 0;
        let vo = eo + 8;
        if (cnt * vs > 4) vo = u32(eo + 8);
        const rv = typ === 3 ? u16(vo) : u32(vo);
        switch (tag) {
            case 256: w = rv; break; case 257: h = rv; break;
            case 258: bps = rv; break; case 259: comp = rv; break;
            case 262: photo = rv; break; case 277: spp = rv; break;
            case 278: rps = rv; break;
            case 273: so.length = 0; if (cnt === 1) so.push(rv); else for (let j = 0; j < cnt && vo + j * 4 + 4 <= d.length; j++) so.push(u32(vo + j * 4)); break;
            case 279: sl.length = 0; if (cnt === 1) sl.push(rv); else for (let j = 0; j < cnt && vo + j * 4 + 4 <= d.length; j++) sl.push(u32(vo + j * 4)); break;
        }
    }
    if (!w || !h || !so.length) return null;
    const px = new Uint8ClampedArray(w * h * 4);
    const bpp = (bps / 8) * spp;
    const rb = w * bpp;
    function lzwDecode(input: Uint8Array, expectedLen: number): Uint8Array | null {
        if (input.length < 2) return null;
        const cc = 256, eoi = 257;
        let cs = 9, nc = 258;
        const tbl: Uint8Array[] = [];
        for (let i = 0; i < 256; i++) tbl.push(new Uint8Array([i]));
        const out = new Uint8Array(expectedLen);
        let op = 0, bits = 0, bb = 0, ip = 0;
        const rc = (): number => { while (bb < cs) { if (ip >= input.length) return eoi; bb |= input[ip++] << bits; bits += 8; } const c = bb & ((1 << cs) - 1); bb >>= cs; bits -= cs; return c; };
        let prev: Uint8Array | null = null;
        while (true) {
            const c = rc();
            if (c === eoi) break;
            if (c === cc) { cs = 9; nc = 258; tbl.length = 256; prev = null; continue; }
            if (c >= tbl.length) { if (!prev) return null; const ent = new Uint8Array(prev.length + 1); ent.set(prev); ent[prev.length] = prev[0]; tbl.push(ent); if (nc === (1 << cs) && cs < 12) cs++; nc++; out.set(ent, op); op += ent.length; prev = ent; if (op >= expectedLen) break; continue; }
            const ent = tbl[c]; if (prev) { const merged = new Uint8Array(prev.length + 1); merged.set(prev); merged[prev.length] = ent[0]; tbl.push(merged); if (nc === (1 << cs) && cs < 12) cs++; nc++; } out.set(ent, op); op += ent.length; prev = ent; if (op >= expectedLen) break;
        }
        return out;
    }
    if (comp === 1) {
        let y = 0;
        for (let s = 0; s < so.length && y < h; s++) {
            const off = so[s], rows = Math.min(rps || h, h - y);
            for (let r = 0; r < rows; r++) {
                const sr = off + r * rb, dy = (y + r) * w * 4;
                for (let x = 0; x < w; x++) {
                    const si = sr + x * bpp, di = dy + x * 4;
                    if (spp === 3) { px[di] = d[si]; px[di + 1] = d[si + 1]; px[di + 2] = d[si + 2]; px[di + 3] = 255; }
                    else if (spp === 4) { px[di] = d[si]; px[di + 1] = d[si + 1]; px[di + 2] = d[si + 2]; px[di + 3] = d[si + 3]; }
                    else if (spp === 1) { const v = photo === 0 ? 255 - d[si] : d[si]; px[di] = px[di + 1] = px[di + 2] = v; px[di + 3] = 255; }
                }
            }
            y += rows;
        }
    } else if (comp === 5) {
        let y = 0;
        for (let s = 0; s < so.length && y < h; s++) {
            const off = so[s], slen = sl[s] || 0, rows = Math.min(rps || h, h - y);
            const dec = lzwDecode(d.subarray(off, off + slen), rows * rb);
            if (!dec) return null;
            for (let r = 0; r < rows; r++) {
                const sr = r * rb, dy = (y + r) * w * 4;
                for (let x = 0; x < w; x++) {
                    const si = sr + x * bpp, di = dy + x * 4;
                    if (spp === 3) { px[di] = dec[si]; px[di + 1] = dec[si + 1]; px[di + 2] = dec[si + 2]; px[di + 3] = 255; }
                    else if (spp === 4) { px[di] = dec[si]; px[di + 1] = dec[si + 1]; px[di + 2] = dec[si + 2]; px[di + 3] = dec[si + 3]; }
                    else if (spp === 1) { const v = photo === 0 ? 255 - dec[si] : dec[si]; px[di] = px[di + 1] = px[di + 2] = v; px[di + 3] = 255; }
                }
            }
            y += rows;
        }
    } else return null;
    return { width: w, height: h, pixels: px };
}

// detect webgl support
function detectWebGLSupport(): boolean {
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("webgl2");
        return !!ctx;
    } catch (e) {
        return false;
    }
}

export const WebGLSupported = detectWebGLSupport();
let loggedWebGL = false;

type TermWrapOptions = {
    keydownHandler?: (e: KeyboardEvent) => boolean;
    useWebGl?: boolean;
    sendDataHandler?: (data: string) => void;
    nodeModel?: BlockNodeModel;
};

// DEC private modes that are safe to replay on durable reconnect.
// Mouse tracking (1000-1006) and bracketed paste (2004) are included.
// Alternate screen (47/1049), cursor visibility (25), and synchronized
// output (2026) are excluded to avoid unintended display side effects.
const SafeReplayDecModes = new Set([1000, 1002, 1003, 1005, 1006, 2004]);

export class TermWrap {
    tabId: string;
    blockId: string;
    ptyOffset: number;
    dataBytesProcessed: number;
    terminal: Terminal;
    connectElem: HTMLDivElement;
    fitAddon: FitAddon;
    searchAddon: SearchAddon;
    serializeAddon: SerializeAddon;
    mainFileSubject: SubjectWithRef<WSFileEventData>;
    loaded: boolean;
    heldData: Uint8Array[];
    handleResize_debounced: () => void;
    hasResized: boolean;
    multiInputCallback: (data: string) => void;
    sendDataHandler: (data: string) => void;
    onSearchResultsDidChange?: (result: { resultIndex: number; resultCount: number }) => void;
    toDispose: TermTypes.IDisposable[] = [];
    webglAddon: WebglAddon | null = null;
    imageAddon: any = null;
    webglContextLossDisposable: TermTypes.IDisposable | null = null;
    webglEnabledAtom: jotai.PrimitiveAtom<boolean>;
    pasteActive: boolean = false;
    lastUpdated: number;
    promptMarkers: TermTypes.IMarker[] = [];
    shellIntegrationStatusAtom: jotai.PrimitiveAtom<ShellIntegrationStatus | null>;
    lastCommandAtom: jotai.PrimitiveAtom<string | null>;
    claudeCodeActiveAtom: jotai.PrimitiveAtom<boolean>;
    nodeModel: BlockNodeModel; // this can be null
    hoveredLinkUri: string | null = null;
    onLinkHover?: (uri: string | null, mouseX: number, mouseY: number) => void;

    // Paste deduplication
    // xterm.js paste() method triggers onData event, which can cause duplicate sends
    lastPasteData: string = "";
    lastPasteTime: number = 0;

    // dev only (for debugging)
    recentWrites: { idx: number; data: string; ts: number }[] = [];
    recentWritesCounter: number = 0;

    // for repaint transaction scrolling behavior
    lastClearScrollbackTs: number = 0;
    lastMode2026SetTs: number = 0;
    lastMode2026ResetTs: number = 0;
    inSyncTransaction: boolean = false;
    inRepaintTransaction: boolean = false;

    // Track active DEC private modes for durable reconnect state restoration
    activeDecModes: Set<number> = new Set();

    constructor(
        tabId: string,
        blockId: string,
        connectElem: HTMLDivElement,
        options: TermTypes.ITerminalOptions & TermTypes.ITerminalInitOnlyOptions,
        waveOptions: TermWrapOptions
    ) {
        this.loaded = false;
        this.tabId = tabId;
        this.blockId = blockId;
        this.sendDataHandler = waveOptions.sendDataHandler;
        this.nodeModel = waveOptions.nodeModel;
        this.ptyOffset = 0;
        this.dataBytesProcessed = 0;
        this.hasResized = false;
        this.lastUpdated = Date.now();
        this.promptMarkers = [];
        this.shellIntegrationStatusAtom = jotai.atom(null) as jotai.PrimitiveAtom<ShellIntegrationStatus | null>;
        this.lastCommandAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.claudeCodeActiveAtom = jotai.atom(false);
        this.webglEnabledAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
        this.terminal = new Terminal(options);
        this.fitAddon = new FitAddon();
        this.serializeAddon = new SerializeAddon();
        this.searchAddon = new SearchAddon();
        this.terminal.loadAddon(this.searchAddon);
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.serializeAddon);
        this.terminal.loadAddon(
            new WebLinksAddon(
                (e, uri) => {
                    e.preventDefault();
                    switch (PLATFORM) {
                        case PlatformMacOS:
                            if (e.metaKey) {
                                fireAndForget(() => openLink(uri));
                            }
                            break;
                        default:
                            if (e.ctrlKey) {
                                fireAndForget(() => openLink(uri));
                            }
                            break;
                    }
                },
                {
                    hover: (e, uri) => {
                        this.hoveredLinkUri = uri;
                        this.onLinkHover?.(uri, e.clientX, e.clientY);
                    },
                    leave: () => {
                        this.hoveredLinkUri = null;
                        this.onLinkHover?.(null, 0, 0);
                    },
                }
            )
        );
        this.setTermRenderer(WebGLSupported && waveOptions.useWebGl ? "webgl" : "dom");
        try {
            this.imageAddon = new ImageAddon({
                sixelSupport: true,
                kittySupport: true,
                iipSupport: true,
                enableSizeReports: true,
            });
            this.terminal.loadAddon(this.imageAddon);

            // IIP TIFF intercept: the compiled addon doesn't have our TIFF
            // patches. This intercept handles TIFF rendering directly.
            const iipH = (this.imageAddon as any)._handlers?.get("iip");
            if (iipH && !iipH.__iipFixed) {
                console.log("[IIP-FIX] Intercept installed on IIP handler");
                const origPut = iipH.put?.bind(iipH);
                const origEnd = iipH.end?.bind(iipH);
                let rawChunks: Uint8Array[] = [];
                let rawTotal = 0;

                iipH.put = function(data: any, start: number, end: number) {
                    const chunk = new Uint8Array((end - start) * 4);
                    let len = 0;
                    for (let i = start; i < end; i++) chunk[len++] = data[i] & 0xFF;
                    rawChunks.push(chunk.subarray(0, len));
                    rawTotal += len;
                    return origPut?.(data, start, end);
                };

                iipH.end = function(success: boolean) {
                    const h = (iipH as any)._header;
                    const headerType = h?.type;

                    if (success && headerType === 1 && rawChunks.length > 0) {
                        try {
                            // Reassemble raw bytes — includes header text before colon
                            const rawBytes = new Uint8Array(rawTotal);
                            let offset = 0;
                            for (const chunk of rawChunks) { rawBytes.set(chunk, offset); offset += chunk.length; }

                            // Find colon (0x3A) — separates header from base64 payload
                            const colonIdx = rawBytes.indexOf(0x3A);
                            if (colonIdx < 0 || colonIdx >= rawBytes.length - 1) {
                                console.log("[IIP-FIX] No colon found in payload, falling through");
                                rawChunks = []; rawTotal = 0;
                                return origEnd?.(success);
                            }

                            // Find BEL (0x07) — terminates the IIP sequence
                            let endIdx = rawBytes.indexOf(0x07, colonIdx + 1);
                            if (endIdx < 0) endIdx = rawBytes.length;

                            let b64Str = '';
                            for (let i = colonIdx + 1; i < endIdx; i++) b64Str += String.fromCharCode(rawBytes[i]);
                            const decoded = atob(b64Str);
                            const decodedBytes = new Uint8Array(decoded.length);
                            for (let i = 0; i < decoded.length; i++) decodedBytes[i] = decoded.charCodeAt(i);

                            const isTiff = decodedBytes.length >= 4 &&
                                ((decodedBytes[0] === 0x49 && decodedBytes[1] === 0x49 && decodedBytes[2] === 0x2A && decodedBytes[3] === 0x00) ||
                                 (decodedBytes[0] === 0x4D && decodedBytes[1] === 0x4D && decodedBytes[2] === 0x00 && decodedBytes[3] === 0x2A));
                            if (isTiff) {
                                const tiffResult = decodeTiffFallback(decodedBytes);
                                if (tiffResult) {
                                    const storage = (iipH as any)._storage;
                                    const renderer = (iipH as any)._renderer;
                                    const dims = renderer?.dimensions;
                                    const cw = dims?.css?.cell?.width || 7;
                                    const ch = dims?.css?.cell?.height || 14;

                                    let tw = tiffResult.width;
                                    let th = tiffResult.height;
                                    const preserveAR = h.preserveAspectRatio !== 0;
                                    if (h.width && h.width !== 'auto') {
                                        const rw = parseInt(String(h.width), 10) * cw;
                                        if (rw > 0) {
                                            if (preserveAR) {
                                                tw = rw;
                                                th = Math.floor(tiffResult.height * rw / tiffResult.width);
                                            } else if (h.height && h.height !== 'auto') {
                                                const rh = parseInt(String(h.height), 10) * ch;
                                                if (rh > 0) { tw = rw; th = rh; }
                                                else { tw = rw; th = Math.floor(tiffResult.height * rw / tiffResult.width); }
                                            } else {
                                                tw = rw;
                                                th = Math.floor(tiffResult.height * rw / tiffResult.width);
                                            }
                                        }
                                    } else if (h.height && h.height !== 'auto') {
                                        const rh = parseInt(String(h.height), 10) * ch;
                                        if (rh > 0) {
                                            th = rh;
                                            tw = Math.floor(tiffResult.width * rh / tiffResult.height);
                                        }
                                    }
                                    console.log(`[IIP-FIX] TIFF ${tiffResult.width}x${tiffResult.height} → canvas ${tw}x${th} (preserveAR=${preserveAR}, cw=${cw} ch=${ch})`);

                                    const canvas = document.createElement("canvas");
                                    if (tw === tiffResult.width && th === tiffResult.height) {
                                        canvas.width = tiffResult.width;
                                        canvas.height = tiffResult.height;
                                        const imgData = new ImageData(tiffResult.width, tiffResult.height);
                                        imgData.data.set(tiffResult.pixels);
                                        canvas.getContext("2d")?.putImageData(imgData, 0, 0);
                                    } else {
                                        const tmp = document.createElement("canvas");
                                        tmp.width = tiffResult.width;
                                        tmp.height = tiffResult.height;
                                        const tmpData = new ImageData(tiffResult.width, tiffResult.height);
                                        tmpData.data.set(tiffResult.pixels);
                                        tmp.getContext("2d")?.putImageData(tmpData, 0, 0);
                                        canvas.width = tw;
                                        canvas.height = th;
                                        const ctx = canvas.getContext("2d");
                                        if (ctx) { ctx.imageSmoothingEnabled = true; ctx.drawImage(tmp, 0, 0, tw, th); }
                                    }
                                    storage.addImage(canvas);
                                    rawChunks = [];
                                    rawTotal = 0;
                                    return true;
                                }
                            }
                        } catch (e) {
                            console.error("[IIP-FIX] TIFF intercept failed:", e);
                        }
                    }
                    rawChunks = [];
                    rawTotal = 0;
                    console.log("[IIP-FIX] Not TIFF, falling through to addon");
                    return origEnd?.(success);
                };
                iipH.__iipFixed = true;
            }

            (window as any).__imageAddon = this.imageAddon;
            (window as any).__term = this.terminal;
            // ── Manual IIP test helpers (call from browser console) ──
            const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
            const tinyPngSize = Math.ceil(tinyPng.length * 3 / 4);

            // Quick test: write IIP with tiny PNG
            (window as any).__testIIP = () => {
                const term = (window as any).__term;
                if (!term) { console.error("[IIP-DEBUG] No terminal"); return; }
                const seq = `\x1b]1337;File=inline=1;size=${tinyPngSize}:${tinyPng}\x07`;
                console.log("[IIP-DEBUG] Writing IIP with PNG, length:", seq.length);
                term.write(seq);
            };
            // Test header parsing with minimal payload
            (window as any).__testIIPHeader = () => {
                const term = (window as any).__term;
                if (!term) { console.error("[IIP-DEBUG] No terminal"); return; }
                const seq = `\x1b]1337;File=inline=1;size=8:dGVzdGRhdGE=\x07`;
                console.log("[IIP-DEBUG] Writing IIP header test, length:", seq.length);
                term.write(seq);
            };
            // Test empty OSC 1337
            (window as any).__testOsc1337 = () => {
                const term = (window as any).__term;
                if (!term) { console.error("[IIP-DEBUG] No terminal"); return; }
                const seq = `\x1b]1337;File=inline=1;size=0:\x07`;
                console.log("[IIP-DEBUG] Writing empty OSC 1337, length:", seq.length);
                term.write(seq);
            };
            // Write IIP as Uint8Array (like WaveTerm's base64ToArray path)
            (window as any).__testIIPUint8 = () => {
                const term = (window as any).__term;
                if (!term) { console.error("[IIP-DEBUG] No terminal"); return; }
                const str = `\x1b]1337;File=inline=1;size=${tinyPngSize}:${tinyPng}\x07`;
                const bytes = new Uint8Array(str.length);
                for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
                console.log("[IIP-DEBUG] Writing IIP as Uint8Array, length:", bytes.length);
                term.write(bytes);
            };
            // Write IIP in chunks (simulating PTY delivery)
            (window as any).__testIIPChunked = () => {
                const term = (window as any).__term;
                if (!term) { console.error("[IIP-DEBUG] No terminal"); return; }
                const header = `\x1b]1337;File=inline=1;size=${tinyPngSize}:`;
                console.log("[IIP-DEBUG] Writing chunked IIP: header(", header.length, ") + payload(", tinyPng.length, ") + BEL");
                term.write(header);
                setTimeout(() => term.write(tinyPng), 10);
                setTimeout(() => term.write("\x07"), 20);
            };
            // Check parser state
            (window as any).__testIIPParserState = () => {
                const term = (window as any).__term;
                if (!term) { console.error("[IIP-DEBUG] No terminal"); return; }
                const parser = (term as any)._core?._inputHandler?._parser;
                console.log("[IIP-DEBUG] Parser state:", {
                    currentState: parser?.currentState,
                    initialState: parser?.initialState,
                    stuck: parser?.currentState !== parser?.initialState,
                });
                const oscParser = parser?._oscParser;
                if (oscParser) {
                    const ids = Object.keys(oscParser._handlers || {}).filter(k => !isNaN(Number(k))).map(Number);
                    console.log("[IIP-DEBUG] Registered OSC IDs:", ids);
                    const h = oscParser._handlers[1337];
                    console.log("[IIP-DEBUG] OSC 1337 handlers:", h?.length ?? 0, h?.map((x: any) => x?.constructor?.name));
                }
            };
            // Run all tests in sequence
            (window as any).__testIIPAll = async () => {
                console.log("[IIP-DEBUG] === Running all IIP tests ===");
                (window as any).__testIIPParserState();
                console.log("[IIP-DEBUG] --- Test: minimal OSC 1337 ---");
                (window as any).__testOsc1337();
                await new Promise(r => setTimeout(r, 300));
                (window as any).__testIIPParserState();
                console.log("[IIP-DEBUG] --- Test: IIP with PNG ---");
                (window as any).__testIIP();
                await new Promise(r => setTimeout(r, 300));
                (window as any).__testIIPParserState();
                console.log("[IIP-DEBUG] --- Test: Uint8Array ---");
                (window as any).__testIIPUint8();
                await new Promise(r => setTimeout(r, 300));
                (window as any).__testIIPParserState();
                console.log("[IIP-DEBUG] === All tests done. Check [IIP-DEBUG] logs above ===");
            };
            console.log("[IIP-DEBUG] Test helpers: __testIIP() __testIIPHeader() __testOsc1337() __testIIPUint8() __testIIPChunked() __testIIPParserState() __testIIPAll()");
        } catch (e) {
            console.error("[IIP-DEBUG] ImageAddon failed to load", e);
        }
        // Register OSC handlers
        this.terminal.parser.registerOscHandler(7, (data: string) => {
            try {
                return handleOsc7Command(data, this.blockId, this.loaded);
            } catch (e) {
                console.error("[termwrap] osc 7 handler error", this.blockId, e);
                return false;
            }
        });
        this.terminal.parser.registerOscHandler(52, (data: string) => {
            try {
                return handleOsc52Command(data, this.blockId, this.loaded, this);
            } catch (e) {
                console.error("[termwrap] osc 52 handler error", this.blockId, e);
                return false;
            }
        });
        this.terminal.parser.registerOscHandler(16162, (data: string) => {
            try {
                return handleOsc16162Command(data, this.blockId, this.loaded, this);
            } catch (e) {
                console.error("[termwrap] osc 16162 handler error", this.blockId, e);
                return false;
            }
        });
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
                if (params == null || params.length < 1) {
                    return false;
                }
                if (params[0] === 3) {
                    this.lastClearScrollbackTs = Date.now();
                    if (this.inSyncTransaction) {
                        console.log("[termwrap] repaint transaction starting");
                        this.inRepaintTransaction = true;
                    }
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
                if (params == null || params.length < 1) {
                    return false;
                }
                for (const mode of params) {
                    const m = mode as number;
                    this.activeDecModes.add(m);
                    if (m === 2026) {
                        this.lastMode2026SetTs = Date.now();
                        this.inSyncTransaction = true;
                    }
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
                if (params == null || params.length < 1) {
                    // No parameters: clear all DEC modes
                    this.activeDecModes.clear();
                    if (this.inSyncTransaction) {
                        this.lastMode2026ResetTs = Date.now();
                        this.inSyncTransaction = false;
                        const wasRepaint = this.inRepaintTransaction;
                        this.inRepaintTransaction = false;
                        if (wasRepaint && Date.now() - this.lastClearScrollbackTs <= MaxRepaintTransactionMs) {
                            setTimeout(() => {
                                console.log("[termwrap] repaint transaction complete, scrolling to bottom");
                                this.terminal.scrollToBottom();
                            }, 20);
                        }
                    }
                    return false;
                }
                for (const mode of params) {
                    const m = mode as number;
                    this.activeDecModes.delete(m);
                    if (m === 2026) {
                        this.lastMode2026ResetTs = Date.now();
                        this.inSyncTransaction = false;
                        const wasRepaint = this.inRepaintTransaction;
                        this.inRepaintTransaction = false;
                        if (wasRepaint && Date.now() - this.lastClearScrollbackTs <= MaxRepaintTransactionMs) {
                            setTimeout(() => {
                                console.log("[termwrap] repaint transaction complete, scrolling to bottom");
                                this.terminal.scrollToBottom();
                            }, 20);
                        }
                    }
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.onBell(() => {
                if (!this.loaded) {
                    return true;
                }
                console.log("BEL received in terminal", this.blockId);
                const bellSoundEnabled =
                    globalStore.get(getOverrideConfigAtom(this.blockId, "term:bellsound")) ?? false;
                if (bellSoundEnabled) {
                    fireAndForget(() => RpcApi.ElectronSystemBellCommand(TabRpcClient, { route: "electron" }));
                }
                const bellIndicatorEnabled =
                    globalStore.get(getOverrideConfigAtom(this.blockId, "term:bellindicator")) ?? false;
                if (bellIndicatorEnabled) {
                    setBadge(this.blockId, { icon: "bell", color: "#fbbf24", priority: 1 });
                }
                return true;
            })
        );
        this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
            if (!waveOptions.keydownHandler) {
                return true;
            }
            return waveOptions.keydownHandler(e);
        });
        this.connectElem = connectElem;
        this.mainFileSubject = null;
        this.heldData = [];
        this.handleResize_debounced = debounce(50, this.handleResize.bind(this));
        this.terminal.open(this.connectElem);

        const dragoverHandler = (e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = "copy";
            }
        };
        const dropHandler = (e: DragEvent) => {
            e.preventDefault();
            if (!e.dataTransfer || e.dataTransfer.files.length === 0) {
                return;
            }
            const paths: string[] = [];
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                const filePath = getApi().getPathForFile(file);
                if (filePath) {
                    paths.push(quoteForPosixShell(filePath));
                }
            }
            if (paths.length > 0) {
                this.terminal.paste(paths.join(" ") + " ");
            }
        };
        this.connectElem.addEventListener("dragover", dragoverHandler);
        this.connectElem.addEventListener("drop", dropHandler);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("dragover", dragoverHandler);
                this.connectElem.removeEventListener("drop", dropHandler);
            },
        });
        this.handleResize();
        const pasteHandler = this.pasteHandler.bind(this);
        this.connectElem.addEventListener("paste", pasteHandler, true);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("paste", pasteHandler, true);
            },
        });
    }

    getZoneId(): string {
        return this.blockId;
    }

    setCursorStyle(cursorStyle: string) {
        this.terminal.options.cursorStyle = normalizeCursorStyle(cursorStyle);
    }

    setCursorBlink(cursorBlink: boolean) {
        this.terminal.options.cursorBlink = cursorBlink ?? false;
    }

    setTermRenderer(renderer: "webgl" | "dom") {
        if (renderer === "webgl") {
            if (this.webglAddon != null) {
                return;
            }
            if (!WebGLSupported) {
                renderer = "dom";
            }
        } else {
            if (this.webglAddon == null) {
                return;
            }
        }
        if (this.webglAddon != null) {
            this.webglContextLossDisposable?.dispose();
            this.webglContextLossDisposable = null;
            this.webglAddon.dispose();
            this.webglAddon = null;
            globalStore.set(this.webglEnabledAtom, false);
        }
        if (renderer === "webgl") {
            const addon = new WebglAddon();
            this.webglContextLossDisposable = addon.onContextLoss(() => {
                this.setTermRenderer("dom");
            });
            this.terminal.loadAddon(addon);
            this.webglAddon = addon;
            globalStore.set(this.webglEnabledAtom, true);
            if (!loggedWebGL) {
                console.log("loaded webgl!");
                loggedWebGL = true;
            }
        }
    }

    getTermRenderer(): "webgl" | "dom" {
        return this.webglAddon != null ? "webgl" : "dom";
    }

    isWebGlEnabled(): boolean {
        return this.webglAddon != null;
    }

    async initTerminal() {
        const copyOnSelectAtom = getSettingsKeyAtom("term:copyonselect");
        const trimTrailingWhitespaceAtom = getSettingsKeyAtom("term:trimtrailingwhitespace");
        this.toDispose.push(this.terminal.onData(this.handleTermData.bind(this)));
        this.toDispose.push(
            this.terminal.onSelectionChange(
                debounce(50, () => {
                    if (!globalStore.get(copyOnSelectAtom)) {
                        return;
                    }
                    // Don't copy-on-select when the search bar has focus — navigating
                    // search results changes the terminal selection programmatically.
                    const active = document.activeElement;
                    if (active != null && active.closest(".search-container") != null) {
                        return;
                    }
                    let selectedText = this.terminal.getSelection();
                    if (selectedText.length > 0) {
                        if (globalStore.get(trimTrailingWhitespaceAtom) !== false) {
                            selectedText = trimTerminalSelection(selectedText);
                        }
                        navigator.clipboard.writeText(selectedText);
                    }
                })
            )
        );
        if (this.onSearchResultsDidChange != null) {
            this.toDispose.push(this.searchAddon.onDidChangeResults(this.onSearchResultsDidChange.bind(this)));
        }

        this.mainFileSubject = getFileSubject(this.getZoneId(), TermFileName);
        this.mainFileSubject.subscribe(this.handleNewFileSubjectData.bind(this));

        try {
            const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
            });
            let shellState: ShellIntegrationStatus = null;

            if (rtInfo && rtInfo["shell:integration"]) {
                shellState = rtInfo["shell:state"] as ShellIntegrationStatus;
                globalStore.set(this.shellIntegrationStatusAtom, shellState || null);
            } else {
                globalStore.set(this.shellIntegrationStatusAtom, null);
            }

            const lastCmd = rtInfo ? rtInfo["shell:lastcmd"] : null;
            const isCC = shellState === "running-command" && isClaudeCodeCommand(lastCmd);
            globalStore.set(this.lastCommandAtom, lastCmd || null);
            globalStore.set(this.claudeCodeActiveAtom, isCC);
        } catch (e) {
            console.log("Error loading runtime info:", e);
        }

        try {
            await this.loadInitialTerminalData();
        } finally {
            this.loaded = true;
        }
        this.runProcessIdleTimeout();
    }

    dispose() {
        this.promptMarkers.forEach((marker) => {
            try {
                marker.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        this.promptMarkers = [];
        this.webglContextLossDisposable?.dispose();
        this.webglContextLossDisposable = null;
        this.terminal.dispose();
        this.toDispose.forEach((d) => {
            try {
                d.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        this.mainFileSubject.release();
    }

    handleTermData(data: string) {
        if (!this.loaded) {
            return;
        }

        this.sendDataHandler?.(data);
        this.multiInputCallback?.(data);
    }

    addFocusListener(focusFn: () => void) {
        this.terminal.textarea.addEventListener("focus", focusFn);
    }

    handleNewFileSubjectData(msg: WSFileEventData) {
        if (msg.fileop == "truncate") {
            this.terminal.clear();
            this.heldData = [];
        } else if (msg.fileop == "append") {
            const decodedData = base64ToArray(msg.data64);
            if (this.loaded) {
                this.doTerminalWrite(decodedData, null);
            } else {
                this.heldData.push(decodedData);
            }
        } else {
            console.log("bad fileop for terminal", msg);
            return;
        }
    }

    doTerminalWrite(data: string | Uint8Array, setPtyOffset?: number): Promise<void> {
        if (isDev() && this.loaded) {
            const dataStr = data instanceof Uint8Array ? new TextDecoder().decode(data) : data;
            this.recentWrites.push({ idx: this.recentWritesCounter++, ts: Date.now(), data: dataStr });
            if (this.recentWrites.length > 50) {
                this.recentWrites.shift();
            }
        }
        let resolve: () => void = null;
        const prtn = new Promise<void>((presolve, _) => {
            resolve = presolve;
        });
        this.terminal.write(data, () => {
            if (setPtyOffset != null) {
                this.ptyOffset = setPtyOffset;
            } else {
                this.ptyOffset += data.length;
                this.dataBytesProcessed += data.length;
            }
            this.lastUpdated = Date.now();
            resolve();
        });
        return prtn;
    }

    async loadInitialTerminalData(): Promise<void> {
        const startTs = Date.now();
        const zoneId = this.getZoneId();
        const { data: cacheData, fileInfo: cacheFile } = await fetchWaveFile(zoneId, TermCacheFileName);
        let ptyOffset = 0;
        if (cacheFile != null) {
            ptyOffset = cacheFile.meta["ptyoffset"] ?? 0;
            if (cacheData.byteLength > 0) {
                const curTermSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
                const fileTermSize: TermSize = cacheFile.meta["termsize"];
                let didResize = false;
                if (
                    fileTermSize != null &&
                    (fileTermSize.rows != curTermSize.rows || fileTermSize.cols != curTermSize.cols)
                ) {
                    console.log("terminal restore size mismatch, temp resize", fileTermSize, curTermSize);
                    this.terminal.resize(fileTermSize.cols, fileTermSize.rows);
                    didResize = true;
                }
                this.doTerminalWrite(cacheData, ptyOffset);
                if (didResize) {
                    this.terminal.resize(curTermSize.cols, curTermSize.rows);
                }
            }
            // Restore DEC private mode state so xterm.js matches the remote application
            const decModes = cacheFile.meta["decmodes"] as string;
            if (decModes) {
                this.replayDecModes(decModes);
            }
        }
        const { data: mainData, fileInfo: mainFile } = await fetchWaveFile(zoneId, TermFileName, ptyOffset);
        console.log(
            `terminal loaded cachefile:${cacheData?.byteLength ?? 0} main:${mainData?.byteLength ?? 0} bytes, ${Date.now() - startTs}ms`
        );
        if (mainFile != null) {
            await this.doTerminalWrite(mainData, null);
        }
    }

    async resyncController(reason: string) {
        dlog("resync controller", this.blockId, reason);
        const rtOpts: RuntimeOpts = { termsize: { rows: this.terminal.rows, cols: this.terminal.cols } };
        try {
            await RpcApi.ControllerResyncCommand(TabRpcClient, {
                tabid: this.tabId,
                blockid: this.blockId,
                rtopts: rtOpts,
            });
        } catch (e) {
            console.log(`error controller resync (${reason})`, this.blockId, e);
        }
    }

    handleResize() {
        const oldRows = this.terminal.rows;
        const oldCols = this.terminal.cols;
        this.fitAddon.fit();
        if (oldRows !== this.terminal.rows || oldCols !== this.terminal.cols) {
            const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
            console.log(
                "[termwrap] resize",
                `${oldRows}x${oldCols}`,
                "->",
                `${this.terminal.rows}x${this.terminal.cols}`
            );
            RpcApi.ControllerInputCommand(TabRpcClient, { blockid: this.blockId, termsize: termSize });
        }
        dlog("resize", `${this.terminal.rows}x${this.terminal.cols}`, `${oldRows}x${oldCols}`, this.hasResized);
        if (!this.hasResized) {
            this.hasResized = true;
            this.resyncController("initial resize");
        }
    }

    serializeDecModes(): string {
        if (this.activeDecModes.size === 0) {
            return "";
        }
        const modes: number[] = [];
        for (const mode of this.activeDecModes) {
            modes.push(mode);
        }
        modes.sort((a, b) => a - b);
        return modes.join(",");
    }

    replayDecModes(decModesStr: string): void {
        if (!decModesStr) {
            return;
        }
        const modes = decModesStr.split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n) && SafeReplayDecModes.has(n));
        if (modes.length === 0) {
            return;
        }
        let seq = "";
        for (const mode of modes) {
            seq += `\x1b[?${mode}h`;
        }
        console.log("[termwrap] replaying DEC private modes", modes);
        this.terminal.write(seq);
    }

    processAndCacheData() {
        if (this.dataBytesProcessed < MinDataProcessedForCache) {
            return;
        }
        const serializedOutput = this.serializeAddon.serialize();
        const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
        const decModes = this.serializeDecModes();
        console.log("idle timeout term", this.dataBytesProcessed, serializedOutput.length, termSize, "decmodes:", decModes);
        fireAndForget(() =>
            services.BlockService.SaveTerminalState(this.blockId, serializedOutput, "full", this.ptyOffset, termSize, decModes)
        );
        this.dataBytesProcessed = 0;
    }

    runProcessIdleTimeout() {
        setTimeout(() => {
            window.requestIdleCallback(() => {
                this.processAndCacheData();
                this.runProcessIdleTimeout();
            });
        }, 5000);
    }

    async pasteHandler(e?: ClipboardEvent): Promise<void> {
        this.pasteActive = true;
        e?.preventDefault();
        e?.stopPropagation();

        try {
            const clipboardData = await extractAllClipboardData(e);
            let firstImage = true;
            for (const data of clipboardData) {
                if (data.image && SupportsImageInput) {
                    if (!firstImage) {
                        await new Promise((r) => setTimeout(r, 150));
                    }
                    const tempPath = await createTempFileFromBlob(data.image);
                    this.terminal.paste(tempPath + " ");
                    firstImage = false;
                }
                if (data.text) {
                    this.terminal.paste(data.text);
                }
            }
        } catch (err) {
            console.error("Paste error:", err);
        } finally {
            setTimeout(() => {
                this.pasteActive = false;
            }, 30);
        }
    }

    getScrollbackContent(): string {
        if (!this.terminal) {
            return "";
        }
        const buffer = this.terminal.buffer.active;
        const lines = bufferLinesToText(buffer, 0, buffer.length);
        return lines.join("\n");
    }
}
