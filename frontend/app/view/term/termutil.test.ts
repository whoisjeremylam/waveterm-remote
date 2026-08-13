import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Mocks for heavy dependencies
// ---------------------------------------------------------------------------

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        WriteTempFileCommand: vi.fn(),
        RemoteWriteTempFileCommand: vi.fn(),
    },
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {},
}));

import { RpcApi } from "@/app/store/wshclientapi";
import { createRemoteTempFileFromBlob } from "./termutil";

const mockRemoteWrite = RpcApi.RemoteWriteTempFileCommand as unknown as ReturnType<typeof vi.fn>;

// Node has no FileReader; provide a minimal stub backed by Blob.arrayBuffer().
class MockFileReader {
    result: ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;

    readAsArrayBuffer(blob: Blob): void {
        blob
            .arrayBuffer()
            .then((buf) => {
                this.result = buf;
                if (this.onload) this.onload();
            })
            .catch((err) => {
                if (this.onerror) this.onerror(err);
            });
    }
}

vi.stubGlobal("FileReader", MockFileReader);

describe("createRemoteTempFileFromBlob", () => {
    beforeEach(() => {
        mockRemoteWrite.mockReset();
        mockRemoteWrite.mockResolvedValue("/tmp/waveterm-abc123/file");
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it("passes the provided filename through to the RPC unchanged", async () => {
        const blob = new Blob(["hello"], { type: "application/pdf" });
        const path = await createRemoteTempFileFromBlob(blob, "report.pdf", "ssh:myhost");

        expect(mockRemoteWrite).toHaveBeenCalledTimes(1);
        const [client, data, opts] = mockRemoteWrite.mock.calls[0];
        expect(data.filename).toBe("report.pdf");
        expect(data.data64).toBeTruthy();
        expect(opts).toEqual({ route: "conn:ssh:myhost" });
        expect(path).toBe("/tmp/waveterm-abc123/file");
    });

    it("generates a waveterm_paste name when no filename is given (clipboard)", async () => {
        const blob = new Blob(["img"], { type: "image/png" });
        await createRemoteTempFileFromBlob(blob, undefined, "ssh:myhost");

        const data = mockRemoteWrite.mock.calls[0][1];
        expect(data.filename).toMatch(/^waveterm_paste_\d+_[a-z0-9]{6}\.png$/);
    });

    it("falls back to a generated name for an empty filename", async () => {
        const blob = new Blob(["img"], { type: "image/png" });
        await createRemoteTempFileFromBlob(blob, "", "ssh:myhost");

        const data = mockRemoteWrite.mock.calls[0][1];
        expect(data.filename).toMatch(/^waveterm_paste_\d+_[a-z0-9]{6}\.png$/);
    });

    it("preserves filenames with spaces, quotes, and unicode", async () => {
        const blob = new Blob(["data"], { type: "text/plain" });
        const tricky = "my file's (final) 副本.txt";
        await createRemoteTempFileFromBlob(blob, tricky, "ssh:myhost");

        const data = mockRemoteWrite.mock.calls[0][1];
        expect(data.filename).toBe(tricky);
    });

    it("uses the .bin extension for unknown mime types when generating a name", async () => {
        const blob = new Blob(["data"], { type: "application/octet-stream" });
        await createRemoteTempFileFromBlob(blob, undefined, "ssh:myhost");

        const data = mockRemoteWrite.mock.calls[0][1];
        expect(data.filename).toMatch(/\.bin$/);
    });

    it("omits route opts when no connName is given", async () => {
        const blob = new Blob(["img"], { type: "image/png" });
        await createRemoteTempFileFromBlob(blob, "x.png");

        const [, , opts] = mockRemoteWrite.mock.calls[0];
        expect(opts).toBeUndefined();
    });

    it("encodes the blob content as base64 in data64", async () => {
        const blob = new Blob(["hello"], { type: "text/plain" });
        await createRemoteTempFileFromBlob(blob, "hello.txt", "ssh:myhost");

        const data = mockRemoteWrite.mock.calls[0][1];
        expect(Buffer.from(data.data64, "base64").toString("utf8")).toBe("hello");
    });

    it("rejects blobs larger than 50MB without calling the RPC", async () => {
        const big = new Blob([new Uint8Array(50 * 1024 * 1024 + 1)], { type: "application/octet-stream" });

        await expect(createRemoteTempFileFromBlob(big, "big.bin", "ssh:myhost")).rejects.toThrow(
            "File too large (>50MB)"
        );
        expect(mockRemoteWrite).not.toHaveBeenCalled();
    });
});
