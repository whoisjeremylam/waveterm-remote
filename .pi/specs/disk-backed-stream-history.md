# Disk-Backed Stream History & Backpressure Fix

## Problem

When a macOS laptop lid closes and the system suspends, remote durable sessions running in a
PTY via `wsh jobmanager` **genuinely pause execution**. The pi process blocks inside a
`write()` syscall and does not resume until the TCP connection recovers (or times out, which
can take hours).

### Root Cause: PTY Backpressure Cascade

```
pi process
  → write() to PTY slave
  → kernel PTY buffer (4 KB)
  → PTY master → StreamManager.readLoop → CirBuf (64 KB connected mode)
  → StreamManager.senderLoop → RPC StreamData → domain socket
  → connserver → SSH stdout → remote SSH server
  → TCP socket → local client
```

When the laptop sleeps, the local client stops ACKing TCP. The **remote** SSH server's TCP
send blocks. This backpressure propagates through every pipe, channel, and buffer in the
chain, ultimately causing the pi process's `write()` to the PTY slave to block.

The CirBuf is only **64 KB in connected mode** (`streammanager.go:382-385`, `cwndSize`).
This fills almost instantly, blocking the `readLoop`. Once the `readLoop` stops reading the
PTY master, the kernel PTY buffer (4 KB) fills, and the pi process blocks.

### Why the Process Freezes for So Long

The `StreamManager.senderLoop` only transitions to disconnected mode (async 2 MB CirBuf,
no backpressure) when `ClientDisconnected()` is called. This happens when:

1. The connserver on the remote detects stdin EOF **and**
2. The connserver calls `DoShutdown` **and**
3. The domain socket to the jobmanager closes **and**
4. The jobmanager calls `ClientDisconnected()`

Step 1 requires the **remote SSH server** to close the session channel, which only happens
after **server-side TCP keepalive timeout** (default: often disabled or 2+ hours). During
this entire window, every link in the backpressure chain is stuck.

### Secondary Issue: History Loss During Disconnect

Even when `ClientDisconnected()` eventually fires, the CirBuf switches to 2 MB async mode
where **old data is overwritten** (`SetEffectiveWindow(false, CirBufSize)`). Any output
produced during disconnect beyond the most recent 2 MB is permanently lost. On reconnect,
a gap marker is recorded in file metadata (`totalGap`), but the actual content is gone.

This means Wave Terminal has no "tmux-like" scrollback — history is not preserved across
disconnects for output beyond 2 MB.

## Design

### Part A: Break Backpressure with Write Timeout

Add a timeout to the `StreamManager.senderLoop` so that when the RPC `SendData()` call
blocks for too long, the `senderLoop` proactively calls `ClientDisconnected()`. This
transitions the CirBuf to async mode (no backpressure) and optionally activates disk
buffering for history preservation.

**Key decisions**:

- The `DataSender` interface gains an error return: `SendData(CommandStreamData) error`
- `routedDataSender.SendData` wraps the blocking `StreamDataCommand` RPC call in a
  goroutine with a 5-second timeout
- If the timeout fires, the senderLoop calls a new method `handleSendFailure()` which
  calls `ClientDisconnected()` and activates disk buffering
- The leaked goroutine from the timeout is acceptable — it completes when the SSH
  connection is eventually torn down and the domain socket write unblocks
- **Leaked goroutine accumulation risk**: Under sustained output during a disconnect,
  the senderLoop keeps calling `SendData`, each timing out after 5s and leaking a
  goroutine. At ~100 packets/sec, ~500 goroutines accumulate per second of output.
  On reconnect, `ClientDisconnected` is called and `sentNotAcked` is reset to 0
  (`streammanager.go:180`), which cancels the in-flight accounting but does not cancel
  the goroutines. The system should periodically cap/GC leaked goroutines, or use a
  shared context cancellation. For low-throughput terminals this is manageable, but
  a fast-output process (e.g. `dd if=/dev/zero`) could exhaust goroutine scheduling.
- Stale data packets from leaked goroutines arrive with old `Seq` numbers; the client-side
  stream reader ignores out-of-order packets

**Timeout value**: 5 seconds. This is a balance:
- Short enough that the CirBuf (64 KB) won't fill completely before timeout fires
  (at ~13 KB/s of PTY output, 64 KB fills in ~5s)
- Long enough to avoid false positives during normal TCP congestion

### Part B: Disk-Backed History

When the `senderLoop` detects client disconnection (write timeout or explicit
`ClientDisconnected`), instead of relying solely on the 2 MB CirBuf (which discards old
data), the `readLoop` begins writing PTY output directly to a disk file.

On reconnection, a new `diskDrain` goroutine reads from the disk file and feeds data
into the CirBuf, which the `senderLoop` then streams to the client. Once the disk file
is fully drained, it is deleted and the `readLoop` resumes writing to the CirBuf directly.

**Key decisions**:

- **Disk file location**: `~/.waveterm/jobs/<jobid>.stream`
  (via `wavebase.GetRemoteJobFilePath(jobId, "stream")`)
- **File format**: Raw bytes, append-only. The byte offset in the file maps directly to
  the stream protocol's absolute `Seq` values: `diskStartSeq` = CirBuf's `totalSize` at
  the moment disk writing began. Data at file offset `N` has sequence number
  `diskStartSeq + N`.
- **Concurrent I/O**: `readLoop` writes via `diskFile.Write` (appends to end).
  `diskDrain` reads via `diskFile.ReadAt(buf, offset)` (explicit offset, no shared
  file-position race). Never use `Seek` + `Read`.
- **Disk write path**: `handleReadData` writes the full PTY read chunk (up to 4 KB
  from `readLoop`'s `MaxPacketSize` buffer) directly to disk via `diskFile.Write(data)`.
  Do NOT route through CirBuf's `WriteAvailable` for disk writes — CirBuf writes
  byte-by-byte internally (`cirbuf.go:77`) which would be catastrophically slow on disk.
- **Drain-complete protocol**: `diskDrain` loops until `diskReadPos >= diskEndSeq` AND
  the terminal event is set (process has exited, no more data coming). For a live
  process, `diskDrain` never considers the drain "complete" — it runs in catch-up mode,
  spinning briefly when caught up. See Edge Case 13 for details.
- **No new RPC types**: The existing stream protocol (`CommandStreamData.Seq`,
  `CommandJobPrepareConnectData.Seq`, `CommandJobConnectRtnData.Seq`) suffices. The
  client already sends its last known position and receives the server's current position.
  Whether the data comes from CirBuf or disk is transparent to the client.
- **Disk full fallback**: If `diskFile.Write()` returns `ENOSPC`, the disk file is closed
  and the system falls back to CirBuf async mode (discard old data, preserve last 2 MB).
  A warning is logged.
- **Stale file cleanup**: On jobmanager startup (`SetupJobManager`), delete any existing
  `<jobid>.stream` file. A restarted jobmanager represents a new session with no
  continuity from a prior disk file.

**StreamManager state additions**:

```go
type StreamManager struct {
    // ... existing fields ...

    diskFile     *os.File  // nil when not using disk
    diskStartSeq int64     // totalSize at which disk writing began
    diskEndSeq   int64     // last byte written to disk (= totalSize of last write)
    diskReadPos  int64     // next byte to read from disk during drain (absolute Seq)
}
```

### Part C: Reconnect Flow Integration

The reconnect flow (`restartStreaming` → `JobPrepareConnectCommand` → `PrepareConnect` →
`connectToStreamHelper_withlock` → `ClientConnected`) is largely unchanged:

1. Client sends `currentSeq` (its last known position from local persisted file)
2. `ClientConnected` calculates effective head position: `max(buf.HeadPos(), diskEndSeq)`
3. If `clientSeq < effectiveHeadPos`, client is behind — gap logic unchanged
4. Returns `effectiveHeadPos` as `serverSeq`
5. **New**: If disk file exists and `clientSeq < diskEndSeq`, start a `diskDrain`
   goroutine that reads from disk and writes to CirBuf
6. Client-side `restartStreaming` handles the gap as before (`totalGap` update)
7. Client calls `JobStartStreamCommand` to begin receiving
8. `senderLoop` reads from CirBuf (which is being filled by diskDrain goroutine)
9. When disk is fully drained, close and delete disk file, resume live PTY → CirBuf

**Sequence during disk drain**:

```
diskFile ──(diskDrain goroutine)──→ CirBuf ──(senderLoop)──→ RPC → client

                           readLoop ──→ (writes to disk if still disconnected)
```

When `ClientConnected` is called, the system transitions to **connected mode**:
- `diskDrain` goroutine starts reading from disk and writing to CirBuf
- **Corked state**: `ClientConnected` is called with `rwndSize=0` (corked stream, see
  `PrepareConnect` at `jobmanager.go:330-331`). CirBuf transitions to sync mode with
  effective-window=0. `diskDrain` blocks on its first `WriteAvailable` call. The system
  is paused until `StartStream` calls `SetRwndSize` with the real rwnd, which expands
  the CirBuf window and wakes `diskDrain` and `senderLoop`.
- `readLoop` continues writing to disk (it must — writing to CirBuf during drain would
  fill the 64 KB sync window). The disk file acts as the live buffer.
- `senderLoop` reads from CirBuf as normal (once uncorked).
- When disk is drained (see Edge Case 13): `diskDrain` syncs `CirBuf.totalSize` to
  `diskEndSeq` (Edge Case 12), then `diskFile.Close()`, `os.Remove(diskPath)`,
  `diskFile = nil`. `readLoop` sees `diskFile == nil` and resumes writing to CirBuf directly.
- `senderLoop` is signalled; if a terminal event was waiting, it is now eligible to send.

The CirBuf acts as the sole intermediary between the data source (disk or PTY) and the
network sender. This keeps the `senderLoop` unchanged — it always reads from CirBuf.

## Architecture Diagram

### Disconnect Flow

```
                    ┌─────────────────────────────┐
                    │     StreamManager            │
                    │                              │
  PTY master ──────→│ readLoop                     │
                    │   │                          │
                    │   ├─ (connected) → CirBuf    │
                    │   │                (64KB sync)│
                    │   │                          │
                    │   └─ (disconnected) → disk   │
                    │        file (unlimited)      │
                    │                              │
                    │ senderLoop                   │
                    │   │                          │
                    │   ├─ SendData() with 5s      │
                    │   │  timeout                 │
                    │   │                          │
                    │   └─ on timeout →            │
                    │      handleSendFailure()     │
                    │      → ClientDisconnected()  │
                    │      → activateDiskBuffering │
                    └─────────────────────────────┘
```

### Reconnect Flow

```
  Client                            Server (jobmanager)
  ──────                            ──────────────────
  restartStreaming()
    │
    ├─ currentSeq = fileSize + totalGap
    │
    ├─ JobPrepareConnectCommand(Seq: currentSeq)
    │                                        │
    │                              PrepareConnect()
    │                                │
    │                                ├─ ClientConnected(clientSeq)
    │                                │   ├─ effectiveHead = max(headPos, diskEndSeq)
    │                                │   ├─ if clientSeq < effectiveHead → gap
    │                                │   ├─ if diskFile exists → start diskDrain goroutine
    │                                │   └─ return effectiveHead as serverSeq
    │                                │
    │                                └─ rtnData.Seq = serverSeq
    │
    ├─ if rtnData.Seq > currentSeq → gap = rtnData.Seq - currentSeq
    │                                totalGap += gap
    │                                reader.UpdateNextSeq(rtnData.Seq)
    │
    ├─ JobStartStreamCommand()
    │                                        │
    │                              StartStream()
    │                                └─ AttachStreamWriter for CirBuf
    │
    └─ runOutputLoop(reader)
         │
         └─ receives StreamData packets
            (disk data arrives via CirBuf → senderLoop)
```

## Changes

### Files Changed

| File | Changes |
|------|---------|
| `pkg/jobmanager/streammanager.go` | Add `diskFile`, `diskStartSeq`, `diskEndSeq`, `diskReadPos` fields to `StreamManager`. Modify `handleReadData` to write full PTY chunk to disk via `diskFile.Write` when `diskFile != nil` (not routed through CirBuf byte-by-byte path). Modify `handleEOF` to use `max(buf.TotalSize(), diskEndSeq)` for `eofPos`. Modify `prepareNextPacket` to defer terminal packet when `diskFile != nil`. Modify `ClientConnected` to expand bounds check with `diskEndSeq`, calculate `effectiveHead = max(headPos, diskEndSeq)`, start `diskDrain` goroutine, and sync `totalSize` when client is ahead of CirBuf. Modify `ClientDisconnected` to call `activateDiskBuffering`. Add `activateDiskBuffering()`, `drainDiskToCirBuf()` goroutine, `deactivateDiskBuffering()`. Add `CirBuf.SetTotalSize(int64)` for drain-completion sync. Modify `senderLoop` to call `handleSendFailure()` on `SendData` error. Modify `StreamManager.Close()` to close and delete disk file. |
| `pkg/jobmanager/streammanager.go` (interface) | Change `DataSender.SendData` return type from void to `error`. Update `senderLoop` to handle error return. |
| `pkg/jobmanager/cirbuf.go` | Add `SetTotalSize(int64)` method to allow external synchronization of absolute Seq counter for drain completion (Edge Case 12). |
| `pkg/jobmanager/mainserverconn.go` | Update `routedDataSender.SendData` to return error with 5s timeout goroutine. |
| `pkg/jobmanager/jobmanager.go` | In `SetupJobManager`, delete stale `<jobid>.stream` file. In `disconnectFromStreamHelper`, call `activateDiskBuffering` (or rely on `ClientDisconnected` doing it). |
| `pkg/jobmanager/streammanager_test.go` | Update `testWriter.SendData` to return `error`. Add tests for: disk buffering path, `eofPos` with disk data, terminal packet deferral, bounds check with disk data, drain completion, totalSize sync, send timeout handling. |

### No RPC Type Changes

Existing types are sufficient:

- `CommandStreamData.Seq` — absolute byte offset (works for disk-derived data)
- `CommandJobPrepareConnectData.Seq` — client's last known position
- `CommandJobConnectRtnData.Seq` — server's effective head position
- `CommandStreamAckData.Seq` / `RWnd` — existing flow control handles disk drain

### Version Bump

Required (`node version.cjs patch`). The `DataSender` interface change means a new `wsh`
binary must be deployed to remote servers. The `wsh jobmanager` on the remote uses the
updated `DataSender` interface internally.

## Edge Cases & Safety

### 1. Stale Disk File After Jobmanager Restart

**Scenario**: Jobmanager crashes and restarts. The old `<jobid>.stream` file remains on disk.

**Handling**: At `SetupJobManager` time, check for and delete any existing `<jobid>.stream`
file. A new jobmanager session has no connection to the prior CirBuf state, so the disk
file is meaningless.

### 2. Disk Full

**Scenario**: Remote disk runs out of space while writing to `<jobid>.stream`.

**Handling**: `diskFile.Write()` returns `ENOSPC`. Catch the error, close the disk file,
set `diskFile = nil`, fall back to CirBuf async mode (discard old data, preserve last 2 MB).
Log a warning: `"disk full, falling back to CirBuf async mode"`.

### 3. Mid-Reconnect Concurrent Access

**Scenario**: `readLoop` is appending to the disk file while `diskDrain` goroutine is
reading from it during reconnect.

**Handling**: `readLoop` **continues** writing to disk during drain (it must — writing
to the CirBuf while `diskDrain` is also writing would fill the 64 KB sync window and
block the PTY). The disk file serves as the shared buffer:
- `readLoop` appends live data to disk (via `diskFile.Write`)
- `diskDrain` reads ahead from disk (via `diskFile.ReadAt`, which does not affect the
  shared file offset) and writes into CirBuf
- `diskEndSeq` is updated under `sm.lock` after each disk write; `diskDrain` reads
  `diskEndSeq` under lock to know how far it can read
- Both goroutines operate on the same `*os.File` safely because `Write` appends to end
  and `ReadAt` uses explicit offsets — there is no `Seek` or shared file-position race

### 4. Multiple Reconnect Cycles

**Scenario**: Connection drops and reconnects multiple times during a session.

**Handling**:
- First disconnect: `diskFile` created, appends data
- First reconnect: `diskDrain` starts, drains disk by reading from disk and writing to CirBuf
- Second disconnect (before drain completes): `ClientDisconnected` sets `connected = false`.
  `diskDrain` checks `sm.connected` on each iteration of its read loop and stops when it
  goes false. `readLoop` continues writing to disk (appending to existing file).
- Second reconnect: `ClientConnected` starts a new `diskDrain` goroutine that resumes
  from `diskReadPos` (the absolute Seq where the previous drain left off)
- The stream protocol's `Seq` values naturally handle the continuation — already-sent
  data won't be resent because the client's `currentSeq` has advanced
- **Important**: `diskDrain` must NOT simply race through the disk during a disconnect.
  CirBuf in async mode (disconnected) never blocks `WriteAvailable`, so `diskDrain` would
  otherwise drain the entire disk into CirBuf, which would then truncate it to 2 MB.
  Checking `sm.connected` each iteration prevents this.

### 5. Process Exit During Disconnect

**Scenario**: The pi process exits (PTY EOF) while disconnected and writing to disk.

**Handling**: `readLoop` gets EOF from PTY, calls `handleEOF()`.

**Critical fix — `eofPos` must account for disk data**: The current `handleEOF` sets
`eofPos = sm.buf.TotalSize()` (`streammanager.go:331`). But when `readLoop` writes to
disk instead of CirBuf, `totalSize` stops incrementing. `handleEOF` must instead set
`eofPos = max(sm.buf.TotalSize(), sm.diskEndSeq)`. Otherwise the terminal packet's `Seq`
points to a stale position, and the client sees an EOF marker before all disk-buffered
data has been delivered.

**Terminal packet deferral**: When `diskFile != nil`, `prepareNextPacket` must not send
the terminal packet until the disk is fully drained. The current logic
(`streammanager.go:374-380`) sends terminal event as soon as `available == 0` (CirBuf
empty), but during drain CirBuf is transiently empty while `diskDrain` is about to
write more. Gate the terminal packet on `diskFile == nil`.

On reconnect, `diskDrain` drains the disk, and only after `diskFile` is nil'd does the
senderLoop send the terminal packet. `PrepareConnect` returns `StreamDone: false` (not
`true` — the stream is not done until all disk data plus the terminal event have been
sent). The client receives all disk-buffered data, then the terminal marker.

### 6. No Prior History (Initial Connect)

**Scenario**: First connection to a new job, `clientSeq = 0`.

**Handling**: No disk file exists. Everything works as before. `headPos = 0`,
`clientSeq = 0` → no gap.

### 7. Connserver Restart During Disconnect

**Scenario**: Multiple connservers connect to the jobmanager's domain socket during
disconnect/reconnect cycles.

**Handling**: Each connserver gets its own `handleJobDomainSocketClient` goroutine.
`SetAttachedClient` kicks out the old client. `ClientDisconnected` → `ClientConnected` →
`ClientDisconnected` cycle works correctly. Disk state is independent of which connserver
is connected — it persists across connserver restarts as long as the jobmanager process
survives.

### 8. Stale Data Packets from Leaked Timeout Goroutines

**Scenario**: When senderLoop's write timeout fires, the goroutine launched by
`routedDataSender.SendData` is still blocked on the RPC write. When the connection is
eventually torn down, all blocked goroutines unblock and send stale `StreamData` packets.

**Handling**: The client-side stream reader (`runOutputLoop`) uses `CreateStreamReaderWithSeq`
which compares incoming `Seq` values to the expected next sequence. Stale packets with
old `Seq` numbers are silently dropped. The `RecvAck` method already has stale ACK
detection (tuple comparison at `streammanager.go:210`).

### 9. ClientConnected Bounds Check with Disk Data

**Scenario**: Client reconnects with `clientSeq` that is beyond the CirBuf's coverage
but still within the disk data range (e.g., client had partially received disk-drained
data before the second disconnect).

**Handling**: The current `ClientConnected` (`streammanager.go:117-118`) errors if
`clientSeq > headPos + bufSize`. When disk data extends beyond CirBuf, the effective
stream end is `max(headPos + bufSize, diskEndSeq)`. The bounds check must be expanded:

```go
effectiveEnd := sm.buf.HeadPos() + int64(sm.buf.Size())
if sm.diskEndSeq > effectiveEnd {
    effectiveEnd = sm.diskEndSeq
}
if clientSeq > effectiveEnd {
    return 0, fmt.Errorf("client seq %d beyond stream end %d", clientSeq, effectiveEnd)
}
```

Additionally, consuming CirBuf bytes when `clientSeq > headPos` must stop at the
CirBuf's current `Size()`, not error if `clientSeq` extends into disk-only territory.

### 10. `sentNotAcked` Dirty on Send Timeout

**Scenario**: `prepareNextPacket` increments `sentNotAcked` under lock (`streammanager.go:410`),
then releases the lock and returns. `senderLoop` calls `sender.SendData(*pkt)` which
times out. `sentNotAcked` is now dirty — it reflects bytes that were never delivered.

**Handling**: `handleSendFailure` must call `ClientDisconnected()`, which resets
`sentNotAcked = 0` at `streammanager.go:180`. This is correct because on disconnection
all in-flight data is considered lost. **This is a hard dependency**: `handleSendFailure`
MUST call `ClientDisconnected` (not just `activateDiskBuffering`).

### 11. diskDrain Lifecycle & Disconnect Safety

**Scenario**: `ClientDisconnected` is called while `diskDrain` is actively writing disk
data into CirBuf.

**Handling**: `diskDrain` must check `sm.connected` (under `sm.lock`) on each iteration
of its read loop. When `connected` goes false, `diskDrain` exits immediately. Without
this check, `diskDrain` would continue writing to CirBuf, which in disconnected/async
mode never blocks — draining the entire disk file into CirBuf, which would then truncate
it to 2 MB, defeating the purpose of disk-backed history.

The `diskDrain` loop structure:

```go
func (sm *StreamManager) drainDiskToCirBuf() {
    for {
        sm.lock.Lock()
        connected := sm.connected
        diskFile := sm.diskFile
        curDiskEnd := sm.diskEndSeq
        readPos := sm.diskReadPos
        sm.lock.Unlock()

        if !connected || diskFile == nil {
            return // stop on disconnect or drain complete
        }
        if readPos >= curDiskEnd {
            // No new data yet; check if the source has stopped producing
            time.Sleep(10 * time.Millisecond)
            continue
        }
        // read from disk, write to CirBuf, advance diskReadPos
    }
}
```

### 12. CirBuf `totalSize` Sync on Drain Completion

**Scenario**: Disk drain completes. `readLoop` switches from writing to disk back to
writing to CirBuf. But `CirBuf.totalSize` was last updated before the switch to disk
writing — it is stale.

**Handling**: When disk drain is fully complete (diskDrain has read all data and the
terminal-event gate is open), the drain-completion code must sync CirBuf's absolute
position: `sm.buf.totalSize = sm.diskEndSeq`. Without this sync, the SEQ numbers
generated by `prepareNextPacket` (which uses `HeadPos() = totalSize - count`) would
reset to a stale position, causing all new CirBuf-derived packets to carry SEQ values
that overlap with already-delivered disk data. This requires adding a `SetTotalSize`
method to CirBuf, or performing the assignment directly under `CirBuf.lock`.

### 13. "Drain Complete" Protocol

**Scenario**: `diskDrain` needs to know when all disk data has been read AND the
`readLoop` won't write any more (so the disk file can be closed and deleted).

**Handling**: `diskDrain` cannot simply check `diskReadPos >= diskEndSeq`, because
`diskEndSeq` advances as `readLoop` appends more data. A drain-complete signal is needed:

- `readLoop` sets a `diskWriteDone` channel (or flag) when it has detected that it
  should stop writing to disk (e.g., when the terminal event has fired and all remaining
  disk data has been consumed)
- Alternatively: `diskDrain` loops until `diskReadPos >= diskEndSeq` AND
  `sm.terminalEvent != nil` (process has exited), meaning no more data will arrive.
- For a live process (not exited), `diskDrain` never considers the drain "complete" —
  it runs in catch-up mode, reading data as soon as `readLoop` appends it. The CirBuf
  eventually stabilizes when `diskDrain`'s write rate matches `readLoop`'s append rate,
  and when `diskReadPos` catches up to `diskEndSeq`, `diskDrain` spins briefly (sleeper)
  before the next readLoop write. Once the process exits, the terminal check triggers
  drain completion.

The drain-completion action (close + delete disk file) is:
```go
sm.lock.Lock()
sm.buf.SetTotalSize(sm.diskEndSeq)  // sync Seq counter (see Edge Case 12)
diskPath := sm.diskFile.Name()
sm.diskFile.Close()
sm.diskFile = nil
sm.diskStartSeq = 0
sm.diskEndSeq = 0
sm.diskReadPos = 0
sm.drainCond.Signal()  // wake senderLoop to possibly send terminal event
sm.lock.Unlock()
os.Remove(diskPath)
```

### 14. Activate Disk Buffering on All Disconnect Paths

**Scenario**: `ClientDisconnected` is called from three places:
1. `handleSendFailure` (write timeout)
2. `disconnectFromStreamHelper` (new client replaces old, or domain socket close)
3. `handleJobDomainSocketClient` defer (domain socket closes)

**Handling**: `activateDiskBuffering` must be called after every `ClientDisconnected`,
not just the timeout path. The simplest approach: embed the activation inside
`ClientDisconnected` itself, or call it in `disconnectFromStreamHelper` and
`handleJobDomainSocketClient`. The tradeoff is that not every disconnect warrants disk
buffering (e.g., process hasn't started yet). Add a guard: only activate if `sm.reader`
is attached (PTY data is flowing) and the terminal event hasn't fired.

## Concurrency Model

Four goroutines interact with the StreamManager:

```
readLoop        — reads from PTY master, writes to CirBuf or disk
senderLoop      — reads from CirBuf, sends via RPC (5s timeout)
diskDrain       — reads from disk, writes to CirBuf (only during connected+draining)
                exits when sm.connected goes false (Edge Case 11)
```

**Locking protocol** (unchanged from current):
- `StreamManager.lock` protects metadata fields (`connected`, `diskFile`, `diskEndSeq`, `diskReadPos`, etc.)
- `CirBuf.lock` protects the circular buffer (write, peek, consume, totalSize)
- Disk I/O is done **outside** the StreamManager lock to avoid blocking other goroutines
- `diskEndSeq` update is done atomically under the lock after disk write completes
- `diskReadPos` update is done atomically under the lock after successful CirBuf write

**diskDrain lifecycle**:
1. Created by `ClientConnected` when `diskFile != nil` and `clientSeq < diskEndSeq`
2. Reads from disk (`ReadAt`, no shared-offset race with writeLoop's `Write`)
3. Writes to CirBuf via `WriteAvailable` (participates in same flow control as readLoop)
4. Checks `sm.connected` on each iteration; exits immediately when it goes false
5. Spins with a 10ms sleep when caught up but still connected (live process still appending)
6. When terminal event exists and `diskReadPos >= diskEndSeq`, triggers drain completion
   (syncs `totalSize`, closes/deletes disk file, signals senderLoop)

**Corked state during drain**: `ClientConnected` is called with `rwndSize=0` (corked),
meaning CirBuf's effective window is 0 in sync mode. `diskDrain` will block on its first
`WriteAvailable` call and won't unblock until `StartStream` sets `rwnd > 0`. This is
correct — it means diskDrain sits idle during the corked window and only begins draining
once the client is ready to receive.

**No new deadlock risks**: The lock ordering (StreamManager.lock → CirBuf.lock) is
unchanged. Disk I/O is always outside both locks. `diskDrain` only blocks inside
`CirBuf.WriteAvailable` (which holds CirBuf.lock, not StreamManager.lock), so the
StreamManager lock remains available for `readLoop` and `senderLoop`.

## Out of Scope

- **Disk-backed history for non-durable sessions**: Non-durable sessions don't run a
  `wsh jobmanager`, so they can't buffer output during disconnect. Fixing this would
  require a fundamentally different architecture (e.g., `screen`/`tmux`-style session
  management).
- **Infinite scrollback in the CirBuf itself**: The CirBuf remains 2 MB. Disk provides
  the "infinite" extension.
- **Compression of disk history**: Raw bytes for simplicity. Could add gzip later if
  disk usage is a concern.
- **Client-side disk spillover**: The local persisted output file (`JobOutputFileName`)
  already writes all received data to disk. No changes needed.

## Testing

- **Unit tests**: `streammanager_test.go` — test the disk buffering path with a mock
  filesystem (`t.TempDir()`). Verify: disk file creation, append, drain, cleanup;
  `eofPos` calculation with disk data; terminal packet deferral during drain;
  `ClientConnected` bounds check accepting seq in disk range; `totalSize` sync on
  drain completion; CirBuf in-memory data correctly co-mingled with disk data.
- **Send timeout tests**: `streammanager_test.go` — plug a `DataSender` that blocks
  indefinitely; verify `handleSendFailure` fires after 5s, `ClientDisconnected` resets
  `sentNotAcked`, and disk buffering activates.
- **Integration test**: Simulate a `ClientDisconnected` → `ClientConnected` cycle and
  verify all buffered data is recovered without gaps or overlap.
- **Edge case tests**: Disk full fallback, stale file cleanup on startup and close,
  multiple reconnect cycles (disconnect mid-drain), process exit during disconnect,
  diskDrain stop on disconnect, corked → uncorked drain awakening.
- No existing integration test infrastructure for remote jobs — manual testing with a
  remote SSH connection and `kill -STOP`/`kill -CONT` on the `wsh` process to simulate
  freeze/thaw.
