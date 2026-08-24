# Files Widget — Large Transfers

Follow-up to [[files-widget-qa-fixes.md]] Phase 6. Chunked uploads removed the transport bottlenecks (5MB WS cap, per-RPC size checks); this spec removes the remaining limits around large uploads/downloads:

- The 50MB client cap is now the **only** gate left for uploads.
- `uploadFiles` still loads the entire file into an `arrayBuffer` up front (~2–3× file size peak renderer memory).
- The progress banner has no cancel.
- Downloads use Electron native `downloadURL` with no completion signal — the indicator is a 4s guess.

## Design decisions

1. **Streaming chunk reads (not bigger buffers)** — read each chunk lazily via `File.slice(off, off+len).arrayBuffer()`. Peak memory becomes ~one chunk (~2MB × small factor) regardless of file size. This unlocks large caps without renderer memory risk.
2. **Cancellation deletes the partial file** — the first chunk already truncated/created the destination, so the original content is gone either way. On cancel: stop sending, delete the partial destination (`FileDeleteCommand`, best-effort), clear progress state.
3. **Cap = 1GB default, user-configurable** — new setting key `files.maxuploadsize` (bytes) read from `fullConfigAtom` with 1GB fallback. Avoid inventing UI; document in docs later if desired.
4. **Download progress via `will-download`** — emain hooks `session.on("will-download")`, tracks item progress/completion, pushes events over the existing event system (`emain → renderer` waveevent or a dedicated ipcRenderer channel — implementer picks the cheapest safe path). Renderer replaces the 4s heuristic with real % and completion/cancel states. This also fixes the "no completion signal" gap.

## Build Order

### Phase 1 — Streaming chunk reads
- Rewrite the upload loop in `uploadFiles` to slice the `File` per chunk instead of one whole-file `arrayBuffer()`.
- Keep sequential append semantics identical (first chunk write/truncate, rest append). No server changes.
- Unit tests: chunk slicing helper if extracted (offset math unchanged from `planUploadChunks`; test the File-slicing wrapper with a mock Blob/File).

### Phase 2 — Upload cancellation
- Add an abort mechanism: cancellation token (plain object flag or AbortController-like) stored per upload run on PreviewModel; checked between chunks (and between files).
- Cancel button on the `dir-transfer-banner` while uploading.
- On cancel: stop, best-effort `FileDeleteCommand` the partial destination, set a transient "Upload cancelled" status, clear progress atom.
- Unit tests: token check helper (cancelled-before-start / mid-run / after-completion no-ops).

### Phase 3 — Raise cap to 1GB, configurable
- Replace hardcoded `MaxUploadSize = 50MB` with `files.maxuploadsize` config lookup (fallback 1GB).
- Validate config value (positive integer; sane floor e.g. ≥1MB) with fallback to default on garbage.
- Surface the effective cap in the too-large error message ("exceeds 1GB size limit").
- Unit tests: config resolution helper (valid/garbage/missing values).

### Phase 4 — Real download progress
- emain: hook `will-download`; forward started/progress/done/cancelled events (item filename + bytes) to the requesting webContents.
- Renderer: consume events into `downloadProgress` atom ({sent, total} when determinate); banner shows % and terminal state; remove the 4s auto-clear heuristic.
- Keep the context-menu download flow unchanged otherwise.

## Constraints

- No new npm deps. No wsh RPC changes (no version bump). Go untouched except none expected.
- Tests run in CI only; `go build ./...` available via `/home/mimo-code/project/waveterm-remote/golang-1.26.2/bin/go` if needed (not expected).
- Never run `git push`.

## Deferred (explicitly out of scope)

- Base64-in-JSON transport replacement (streaming binary protocol) — architectural, revisit if multi-GB uploads become common.
- Directory drag-out to OS (needs recursive temp materialization).
