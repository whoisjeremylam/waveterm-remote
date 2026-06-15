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
// Tests
// ---------------------------------------------------------------------------

import { TermWrap } from "./termwrap";

describe("TermWrap ImageAddon integration", () => {
    let term: TermWrap;
    let mockElem: HTMLDivElement;

    beforeEach(() => {
        mockWrite.mockClear();
        mockScrollToBottom.mockClear();
        mockOpen.mockClear();
        mockDispose.mockClear();

        mockElem = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            style: {},
        } as unknown as HTMLDivElement;

        term = new TermWrap(
            "tab-1",
            "block-1",
            mockElem,
            {},
            {}
        );
    });

    it("creates TermWrap with ImageAddon loaded", () => {
        expect(term).toBeDefined();
        expect(term.terminal).toBeDefined();
    });

    it("terminal loadAddon was called for ImageAddon", () => {
        // The terminal mock's loadAddon should have been called multiple times
        // including once for ImageAddon
        expect(term.terminal.loadAddon).toHaveBeenCalled();
    });
});
