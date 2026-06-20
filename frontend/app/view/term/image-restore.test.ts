import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks for heavy dependencies
// ---------------------------------------------------------------------------

const mockWrite = vi.fn();
const mockScrollToBottom = vi.fn();
const mockOpen = vi.fn();
const mockDispose = vi.fn();

vi.mock("@xterm/xterm", () => ({
    Terminal: class MockTerminal {
        write = mockWrite;
        scrollToBottom = mockScrollToBottom;
        rows = 24;
        cols = 80;
        parser = {
            registerCsiHandler: vi.fn(() => ({ dispose: mockDispose })),
            registerOscHandler: vi.fn(() => ({ dispose: mockDispose })),
        };
        open = mockOpen;
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
    globalStore: {
        get: vi.fn(() => undefined),
        set: vi.fn(),
        sub: vi.fn(() => () => {}),
    },
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
vi.mock("@/util/util", () => ({ base64ToArray: vi.fn(), fireAndForget: vi.fn((f) => f()) }));
vi.mock("debug", () => ({ default: () => vi.fn() }));
vi.mock("jotai", () => ({
    atom: vi.fn((init) => ({ init })),
    PrimitiveAtom: class MockPrimitiveAtom {},
}));
vi.mock("throttle-debounce", () => ({ debounce: vi.fn((_, fn) => fn) }));
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

// ---------------------------------------------------------------------------
// Tests for helper functions
// ---------------------------------------------------------------------------

import { hashImageData, canvasToPngBase64, decodePngBase64 } from "./termwrap";

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
});

describe("canvasToPngBase64", () => {
    it("returns null on error", () => {
        // Mock toDataURL to throw
        const orig = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = () => { throw new Error("mock"); };
        const result = canvasToPngBase64(document.createElement("canvas"));
        expect(result).toBeNull();
        HTMLCanvasElement.prototype.toDataURL = orig;
    });

    it("returns a base64 string for a valid canvas", () => {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = "red";
            ctx.fillRect(0, 0, 2, 2);
        }
        const result = canvasToPngBase64(canvas);
        expect(result).toBeTruthy();
        expect(typeof result).toBe("string");
        // Base64 should be decodable
        expect(() => atob(result!)).not.toThrow();
    });
});

describe("decodePngBase64", () => {
    it("returns null for invalid base64", async () => {
        const result = await decodePngBase64("not-valid-base64!!!", 10, 10);
        expect(result).toBeNull();
    });
});
