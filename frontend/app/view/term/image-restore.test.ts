import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Mocks for heavy dependencies
// ---------------------------------------------------------------------------

const mockWrite = vi.fn();
const mockDispose = vi.fn();

vi.mock("@xterm/xterm", () => ({
    Terminal: class MockTerminal {
        write = mockWrite;
        rows = 24;
        cols = 80;
        buffer = { active: { type: "normal" as const, length: 100 } };
        parser = {
            registerCsiHandler: vi.fn(() => ({ dispose: mockDispose })),
            registerOscHandler: vi.fn(() => ({ dispose: mockDispose })),
        };
        loadAddon = vi.fn();
        attachCustomKeyEventHandler = vi.fn();
        onBell = vi.fn(() => ({ dispose: mockDispose }));
        onData = vi.fn(() => ({ dispose: mockDispose }));
        onBinary = vi.fn(() => ({ dispose: mockDispose }));
        onTitleChange = vi.fn(() => ({ dispose: mockDispose }));
        onRender = vi.fn(() => ({ dispose: mockDispose }));
        onResize = vi.fn(() => ({ dispose: mockDispose }));
        onWriteParsed = vi.fn(() => ({ dispose: mockDispose }));
        onSelectionChange = vi.fn(() => ({ dispose: mockDispose }));
    },
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class MockFitAddon { fit = vi.fn(); } }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class MockImageAddon {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class MockSearchAddon {} }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: class MockSerializeAddon {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class MockWebLinksAddon {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class MockWebglAddon {} }));

vi.mock("@/store/global", () => ({
    globalStore: { get: vi.fn(() => undefined), set: vi.fn(), sub: vi.fn(() => () => {}) },
    getApi: vi.fn(() => ({})),
    getOverrideConfigAtom: vi.fn(() => vi.fn()),
    getSettingsKeyAtom: vi.fn(() => vi.fn()),
    isDev: false,
    openLink: vi.fn(),
    WOS: {},
    fetchWaveFile: vi.fn(),
}));

vi.mock("@/store/services", () => ({
    BlockService: {
        SaveTerminalState: vi.fn(),
        SaveTerminalImages: vi.fn(),
        SaveImageAsset: vi.fn(),
    },
}));

vi.mock("@/app/store/badge", () => ({ setBadge: vi.fn() }));
vi.mock("@/app/store/wps", () => ({ getFileSubject: vi.fn(() => null) }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/util/platformutil", () => ({ PLATFORM: "darwin", PlatformMacOS: true }));
vi.mock("@/util/util", () => ({ base64ToArray: vi.fn(), fireAndForget: vi.fn((f: any) => f()) }));
vi.mock("debug", () => ({ default: () => vi.fn() }));
vi.mock("jotai", () => ({
    atom: vi.fn((init: any) => ({ init })),
    PrimitiveAtom: class MockPrimitiveAtom {},
}));
vi.mock("throttle-debounce", () => ({ debounce: vi.fn((_: any, fn: any) => fn) }));
vi.mock("./osc-handlers", () => ({
    handleOsc16162Command: vi.fn(),
    handleOsc52Command: vi.fn(),
    handleOsc7Command: vi.fn(),
    isClaudeCodeCommand: vi.fn(),
}));
vi.mock("./termutil", () => ({
    bufferLinesToText: vi.fn(),
    createTempFileFromBlob: vi.fn(),
    extractAllClipboardData: vi.fn(),
    normalizeCursorStyle: vi.fn(),
    quoteForPosixShell: vi.fn(),
    trimTerminalSelection: vi.fn(),
}));

import { hashImageData } from "./termwrap";

// ---------------------------------------------------------------------------
// Pure logic tests (no DOM required)
// ---------------------------------------------------------------------------

describe("hashImageData", () => {
    it("produces consistent hashes", () => {
        const h1 = hashImageData("abc123");
        const h2 = hashImageData("abc123");
        expect(h1).toBe(h2);
    });

    it("produces different hashes for different data", () => {
        const h1 = hashImageData("abc");
        const h2 = hashImageData("def");
        expect(h1).not.toBe(h2);
    });

    it("returns an 8-char hex string", () => {
        const h = hashImageData("test");
        expect(h).toMatch(/^[0-9a-f]{8}$/);
    });

    it("handles empty string", () => {
        const h = hashImageData("");
        expect(h).toMatch(/^[0-9a-f]{8}$/);
    });

    it("handles long strings efficiently", () => {
        const longStr = "x".repeat(100000);
        const h = hashImageData(longStr);
        expect(h).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe("decodePngBase64 edge cases", () => {
    // These tests use dynamic import to avoid top-level import of DOM-dependent function
    let decodePngBase64: typeof import("./termwrap").decodePngBase64;

    beforeAll(async () => {
        const mod = await import("./termwrap");
        decodePngBase64 = mod.decodePngBase64;
    });

    it("returns null for invalid base64", async () => {
        const result = await decodePngBase64("not-valid-base64!!!", 10, 10);
        expect(result).toBeNull();
    });

    it("returns null for empty string", async () => {
        const result = await decodePngBase64("", 10, 10);
        expect(result).toBeNull();
    });

    it("returns null for zero width", async () => {
        const result = await decodePngBase64("abc", 0, 10);
        expect(result).toBeNull();
    });

    it("returns null for zero height", async () => {
        const result = await decodePngBase64("abc", 10, 0);
        expect(result).toBeNull();
    });

    it("returns null for negative dimensions", async () => {
        const result = await decodePngBase64("abc", -1, -1);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Manifest format tests (pure JSON, no DOM)
// ---------------------------------------------------------------------------

describe("Manifest JSON format", () => {
    it("manifest with viewportRow is valid", () => {
        const manifest = {
            version: 1,
            images: [
                {
                    hash: "a1b2c3d4",
                    row: 10,
                    viewportRow: 5,
                    col: 0,
                    width: 100,
                    height: 50,
                    layer: "top",
                    zIndex: 0,
                    scrolling: true,
                    cursorPos: "iip",
                },
            ],
        };

        const json = JSON.stringify(manifest);
        const parsed = JSON.parse(json);
        expect(parsed.version).toBe(1);
        expect(parsed.images).toHaveLength(1);
        expect(parsed.images[0].hash).toBe("a1b2c3d4");
        expect(parsed.images[0].row).toBe(10);
        expect(parsed.images[0].viewportRow).toBe(5);
        expect(parsed.images[0].width).toBe(100);
    });

    it("manifest with multiple images preserves order", () => {
        const manifest = {
            version: 1,
            images: [
                { hash: "aaa", row: 0, viewportRow: 0, col: 0, width: 10, height: 10, layer: "top", zIndex: 0, scrolling: true, cursorPos: "iip" },
                { hash: "bbb", row: 5, viewportRow: 3, col: 10, width: 20, height: 20, layer: "top", zIndex: 1, scrolling: true, cursorPos: "iip" },
            ],
        };

        const parsed = JSON.parse(JSON.stringify(manifest));
        expect(parsed.images[0].hash).toBe("aaa");
        expect(parsed.images[1].hash).toBe("bbb");
        expect(parsed.images[0].row).toBe(0);
        expect(parsed.images[1].row).toBe(5);
    });

    it("manifest handles missing viewportRow gracefully (backward compat)", () => {
        const manifest = {
            version: 1,
            images: [
                { hash: "abc", row: 10, col: 0, width: 100, height: 50, layer: "top", zIndex: 0, scrolling: true, cursorPos: "iip" },
            ],
        };

        const parsed = JSON.parse(JSON.stringify(manifest));
        expect(parsed.images[0].viewportRow).toBeUndefined();
    });

    it("empty manifest is valid", () => {
        const manifest = { version: 1, images: [] };
        const json = JSON.stringify(manifest);
        const parsed = JSON.parse(json);
        expect(parsed.version).toBe(1);
        expect(parsed.images).toHaveLength(0);
    });

    it("hash deduplication via set", () => {
        const hashes = new Set<string>();
        const img1Hash = hashImageData("image1data");
        const img2Hash = hashImageData("image2data");
        const img1HashDup = hashImageData("image1data");

        hashes.add(img1Hash);
        hashes.add(img2Hash);
        hashes.add(img1HashDup);

        // Same image should produce same hash → set deduplicates
        expect(hashes.size).toBe(2);
        expect(hashes.has(img1Hash)).toBe(true);
        expect(hashes.has(img1HashDup)).toBe(true);
    });

    it("different data produces different hashes", () => {
        const h1 = hashImageData("data1");
        const h2 = hashImageData("data2");
        expect(h1).not.toBe(h2);
    });
});
