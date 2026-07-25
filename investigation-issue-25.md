# Investigation: Screen freezes on durable SSH connection with tmux

## Summary

The output data flow for durable SSH sessions has a windowed flow control pipeline with ACK-based backpressure. When tmux generates burst output, the flow control can stall the output path while the input path (which is a simple direct RPC) continues working unaffected. This explains the asymmetry: input delivered, screen frozen.

## Data Flow for Durable SSH Output

```
Remote PTY → StreamManager.readLoop → CirBuf → StreamManager.senderLoop
→ SSH tunnel (connserver) → Local Broker → Reader → BlockFile → Frontend
```

There are **6 hops** and multiple blocking points. The input path is a simple unidirectional RPC (`SendInput` → `Writer.Write`), which is why it continues working independently.

## Key Blocking Points

### 1. CirBuf window exhaustion → PTY read stall (primary suspect)

**File**: `pkg/jobmanager/streammanager.go:308-323`

`readLoop` reads PTY data → `handleReadData` → `CirBuf.WriteAvailable`. When the CirBuf fills to `windowSize` (min of 64KB cwnd and rwndSize), `WriteAvailable` returns a wait channel. The read loop **blocks on `<-waitCh`** (line 321), so no more PTY data is consumed from the SSH channel.

### 2. senderLoop window exhaustion

**File**: `pkg/jobmanager/streammanager.go:382-389`

```
availableToSend = min(cwndSize, rwndSize) - sentNotAcked
```

When all sent data is unacknowledged (`sentNotAcked >= effectiveRwnd`), the sender blocks on `drainCond.Wait()` (line 389). Data accumulates in CirBuf but is never sent. Combined with #1, this creates a cascading stall.

### 3. ACK flow dependency — slow ACKs cause cascading stall

**File**: `pkg/streamclient/streamreader.go:149-187`

ACKs are only sent from the Reader when:
- The internal buffer is empty (`len(r.buffer) == 0`), OR
- The rwnd difference reaches the threshold (`readWindow / 5`)

The Reader's `Read()` feeds into `runOutputLoop` (`pkg/jobcontroller/jobcontroller.go:1139`), which calls `handleAppendJobFile`. If `handleAppendJobFile` is slow (filestore lock contention, `AppendData` 2-second timeout), ACKs are delayed. Delayed ACKs → senderLoop stalls → CirBuf fills → readLoop stalls → screen freezes.

### 4. ConnMonitor auto-disconnect on stall

**File**: `pkg/remote/conncontroller/connmonitor.go:150-170`

After 3 seconds of inactivity, health status becomes `Stalled`. After 5 seconds (default), auto-disconnect is triggered. During heavy tmux output where the output path is stalled, this could cause the connection to flap.

## Most Probable Scenario

1. tmux generates burst output (status bar updates, pane splits, copy mode, etc.)
2. The StreamManager `senderLoop` can't keep up — either the SSH channel is slow or ACKs are delayed
3. `sentNotAcked` grows, `availableToSend` drops to 0
4. `prepareNextPacket` blocks on `drainCond.Wait()` (line 389)
5. CirBuf fills up to its effective window limit (64KB)
6. `handleReadData` blocks on `<-waitCh` (line 321)
7. PTY read stalls — tmux output backs up in the SSH channel internal buffer
8. Screen freezes, but input works (independent SSH channel send window)

## Files to Focus On

| File | Lines | Role |
|------|-------|------|
| `pkg/jobmanager/streammanager.go` | 280-417 | `readLoop`/`senderLoop`/flow control — primary suspect |
| `pkg/jobmanager/cirbuf.go` | 70-101 | `WriteAvailable` window logic |
| `pkg/streamclient/streamreader.go` | 149-187 | ACK generation — `sendAckLocked` only fires on buffer drain |
| `pkg/streamclient/streamwriter.go` | 110-168 | Writer blocks when window exhausted |
| `pkg/remote/conncontroller/connmonitor.go` | 150-170 | Stall detection and auto-disconnect |

## Suggested Debugging Steps

1. **Add logging to `streammanager.go:388`** when `availableToSend <= 0` — log current `rwndSize`, `cwndSize`, `sentNotAcked`, and `buf.Size()`
2. **Add logging to `streammanager.go:320`** when `waitCh != nil` — log buffer state when readLoop blocks
3. **Monitor ACK delivery timing** — add timestamps to `Reader.sendAckLocked` and `StreamManager.RecvAck` to measure ACK round-trip latency
4. **Test without tmux** — confirm it's tmux-specific (tmux generates high burst output for status bar, pane updates, etc.)
5. **Add a watchdog timer in `readLoop`** that logs when blocked for >1s on `waitCh` — would confirm the stall pattern
6. **Check if `handleAppendJobFile` is slow** — the 2-second timeout in `HandleAppendBlockFile` and filestore lock contention could delay ACKs
