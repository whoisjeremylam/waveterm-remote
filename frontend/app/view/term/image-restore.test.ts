import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashImageData, canvasToPngBase64, decodePngBase64 } from "./termwrap";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockWrite = vi.fn();
const mockDispose = vi.fn();

vi.mock("@xterm/xterm", () => ({
    Terminal: class MockTerminal {
        write = mockWrite;
        rows = 24;
        cols = 80;
        buffer = {
            active: {
                type: "normal" as const,
                length: 100,
            },
        };
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

// ---------------------------------------------------------------------------
// Helper function tests
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

describe("canvasToPngBase64", () => {
    it("returns a base64 string for a valid canvas", () => {
        const canvas = document.createElement("canvas");
        canvas.width = 4;
        canvas.height = 4;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = "blue";
            ctx.fillRect(0, 0, 4, 4);
        }
        const result = canvasToPngBase64(canvas);
        expect(result).toBeTruthy();
        expect(typeof result).toBe("string");
        // Base64 should be decodable
        expect(() => atob(result!)).not.toThrow();
        // Decoded data should be a valid PNG (starts with PNG signature)
        const decoded = atob(result!);
        expect(decoded.substring(0, 4)).toBe("\x89PNG");
    });

    it("handles ImageBitmap by drawing to temp canvas", async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = "green";
            ctx.fillRect(0, 0, 2, 2);
        }
        // Create ImageBitmap from canvas
        const bitmap = await createImageBitmap(canvas);
        const result = canvasToPngBase64(bitmap);
        expect(result).toBeTruthy();
        bitmap.close();
    });
});

describe("decodePngBase64", () => {
    it("decodes a valid PNG base64 string", async () => {
        // Create a small PNG, encode it, then decode
        const srcCanvas = document.createElement("canvas");
        srcCanvas.width = 8;
        srcCanvas.height = 8;
        const ctx = srcCanvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = "red";
            ctx.fillRect(0, 0, 8, 8);
        }
        const b64 = canvasToPngBase64(srcCanvas)!;
        expect(b64).toBeTruthy();

        const decoded = await decodePngBase64(b64, 8, 8);
        expect(decoded).toBeTruthy();
        expect(decoded!.width).toBe(8);
        expect(decoded!.height).toBe(8);
    });

    it("returns null for invalid base64", async () => {
        const result = await decodePngBase64("not-valid-base64!!!", 10, 10);
        expect(result).toBeNull();
    });

    it("returns null for empty string", async () => {
        const result = await decodePngBase64("", 10, 10);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Round-trip integration test
// ---------------------------------------------------------------------------

describe("Image restore round-trip", () => {
    it("export → hash → save → load → decode preserves image data", async () => {
        // 1. Create a source image
        const srcCanvas = document.createElement("canvas");
        srcCanvas.width = 16;
        srcCanvas.height = 8;
        const ctx = srcCanvas.getContext("2d")!;
        ctx.fillStyle = "cyan";
        ctx.fillRect(0, 0, 16, 8);
        ctx.fillStyle = "magenta";
        ctx.fillRect(4, 2, 8, 4);

        // 2. Export to base64 PNG
        const b64 = canvasToPngBase64(srcCanvas)!;
        expect(b64).toBeTruthy();

        // 3. Compute hash
        const hash = hashImageData(b64);
        expect(hash).toMatch(/^[0-9a-f]{8}$/);

        // 4. Simulate save: base64 data is the "asset file content"
        const savedAsset = b64;

        // 5. Simulate load: decode the saved asset
        const decoded = await decodePngBase64(savedAsset, 16, 8);
        expect(decoded).toBeTruthy();
        expect(decoded!.width).toBe(16);
        expect(decoded!.height).toBe(8);

        // 6. Verify pixel data matches (sample a few pixels)
        const decodedCtx = decoded!.getContext("2d")!;
        const pixel1 = decodedCtx.getImageData(0, 0, 1, 1).data;
        expect(pixel1[0]).toBe(0);    // R
        expect(pixel1[1]).toBe(255);  // G
        expect(pixel1[2]).toBe(255);  // B
        expect(pixel1[3]).toBe(255);  // A

        const pixel2 = decodedCtx.getImageData(6, 3, 1, 1).data;
        expect(pixel2[0]).toBe(255);  // R (magenta)
        expect(pixel2[1]).toBe(0);    // G
        expect(pixel2[2]).toBe(255);  // B
        expect(pixel2[3]).toBe(255);  // A
    });

    it("hash deduplication: same image produces same hash", () => {
        const canvas = document.createElement("canvas");
        canvas.width = 4;
        canvas.height = 4;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "yellow";
        ctx.fillRect(0, 0, 4, 4);

        const b64 = canvasToPngBase64(canvas)!;
        const hash1 = hashImageData(b64);
        const hash2 = hashImageData(b64);
        expect(hash1).toBe(hash2);
    });

    it("different images produce different hashes", () => {
        const c1 = document.createElement("canvas");
        c1.width = 4;
        c1.height = 4;
        c1.getContext("2d")!.fillStyle = "red";
        c1.getContext("2d")!.fillRect(0, 0, 4, 4);

        const c2 = document.createElement("canvas");
        c2.width = 4;
        c2.height = 4;
        c2.getContext("2d")!.fillStyle = "blue";
        c2.getContext("2d")!.fillRect(0, 0, 4, 4);

        const h1 = hashImageData(canvasToPngBase64(c1)!);
        const h2 = hashImageData(canvasToPngBase64(c2)!);
        expect(h1).not.toBe(h2);
    });

    it("manifest JSON format is correct", () => {
        const manifest = {
            version: 1,
            images: [
                {
                    hash: "a1b2c3d4",
                    row: 10,
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
        expect(parsed.images[0].width).toBe(100);
    });

    it("empty manifest is valid", () => {
        const manifest = { version: 1, images: [] };
        const json = JSON.stringify(manifest);
        const parsed = JSON.parse(json);
        expect(parsed.version).toBe(1);
        expect(parsed.images).toHaveLength(0);
    });
});
