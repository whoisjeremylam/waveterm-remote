// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"golang.org/x/crypto/ssh"
)

// makeTestConn creates a minimal SSHConn suitable for unit tests.
func makeTestConn(status string) *SSHConn {
	conn := &SSHConn{
		lock:             &sync.Mutex{},
		lifecycleLock:    &sync.Mutex{},
		Status:           status,
		ConnHealthStatus: ConnHealthStatus_Good,
		WshEnabled:       &atomic.Bool{},
		Opts:             &remote.SSHOpts{SSHHost: "testhost", SSHUser: "testuser", SSHPort: "2222"},
	}
	globalLock.Lock()
	clientControllerMap[*conn.Opts] = conn
	globalLock.Unlock()
	return conn
}

// cleanupTestConn removes the test connection from the global map.
func cleanupTestConn(conn *SSHConn) {
	globalLock.Lock()
	delete(clientControllerMap, *conn.Opts)
	globalLock.Unlock()
}

// makeTestMonitor creates a ConnMonitor with the given connection and a dummy client.
func makeTestMonitor(conn *SSHConn) *ConnMonitor {
	return &ConnMonitor{
		lock:          &sync.Mutex{},
		Conn:          conn,
		Client:        &ssh.Client{}, // dummy client to satisfy non-nil check if needed
		inputNotifyCh: make(chan int64, 1),
	}
}

// TestAttemptReconnectLocalConn verifies that local connections return nil immediately.
func TestAttemptReconnectLocalConn(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	err := AttemptReconnect(ctx, "local")
	if err != nil {
		t.Fatalf("expected nil for local conn, got %v", err)
	}
}

// TestAttemptReconnectInvalidName verifies that invalid connection names return an error.
func TestAttemptReconnectInvalidName(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	err := AttemptReconnect(ctx, "not-a-valid-ssh-name")
	if err == nil {
		t.Fatalf("expected error for invalid conn name, got nil")
	}
}

// TestAttemptReconnectNotInMap verifies that connections not in the controller map return an error.
func TestAttemptReconnectNotInMap(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	err := AttemptReconnect(ctx, "user@unknownhost:22")
	if err == nil {
		t.Fatalf("expected error for unknown conn, got nil")
	}
}

// TestAttemptReconnectAlreadyConnected verifies that an already-connected connection returns nil.
func TestAttemptReconnectAlreadyConnected(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	ctx := context.Background()
	err := AttemptReconnect(ctx, conn.GetName())
	if err != nil {
		t.Fatalf("expected nil for already-connected conn, got %v", err)
	}
}

// TestAttemptReconnectSuccess verifies that a disconnected connection is reconnected.
func TestAttemptReconnectSuccess(t *testing.T) {
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	// Mock connectInternal so we don't need a real SSH server
	connectInternalTestHook = func(c *SSHConn, ctx context.Context, flags *wconfig.ConnKeywords) error {
		c.WithLock(func() {
			c.Status = Status_Connected
		})
		return nil
	}
	defer func() { connectInternalTestHook = nil }()

	ctx := context.Background()
	err := AttemptReconnect(ctx, conn.GetName())
	if err != nil {
		t.Fatalf("expected nil after successful reconnect, got %v", err)
	}
	if conn.GetStatus() != Status_Connected {
		t.Fatalf("expected status=Connected, got %s", conn.GetStatus())
	}
}

// TestAttemptReconnectConnectFailure verifies that connect errors are propagated.
func TestAttemptReconnectConnectFailure(t *testing.T) {
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	connectInternalTestHook = func(c *SSHConn, ctx context.Context, flags *wconfig.ConnKeywords) error {
		return fmt.Errorf("mock connect failure")
	}
	defer func() { connectInternalTestHook = nil }()

	ctx := context.Background()
	err := AttemptReconnect(ctx, conn.GetName())
	if err == nil {
		t.Fatalf("expected error after failed reconnect, got nil")
	}
}

// TestGetStallDisconnectThresholdMsDefault verifies the 5s default.
func TestGetStallDisconnectThresholdMsDefault(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)
	cm := makeTestMonitor(conn)

	ms := cm.getStallDisconnectThresholdMs()
	if ms != 5000 {
		t.Fatalf("expected default 5000ms, got %d", ms)
	}
}

// TestGetStallDisconnectThresholdMsFromConfig verifies reading from connection config.
func TestGetStallDisconnectThresholdMsFromConfig(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)
	cm := makeTestMonitor(conn)

	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		threshold := 15
		return wconfig.ConnKeywords{ConnStallDisconnectThreshold: &threshold}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	ms := cm.getStallDisconnectThresholdMs()
	if ms != 15000 {
		t.Fatalf("expected 15000ms (15s), got %d", ms)
	}
}

// TestShouldAutoDisconnectOnStallDefault verifies default true.
func TestShouldAutoDisconnectOnStallDefault(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)
	cm := makeTestMonitor(conn)

	if !cm.shouldAutoDisconnectOnStall() {
		t.Fatalf("expected default true")
	}
}

// TestShouldAutoDisconnectOnStallRespectsConfig verifies conn:stallautodisconnect=false.
func TestShouldAutoDisconnectOnStallRespectsConfig(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)
	cm := makeTestMonitor(conn)

	disabled := false
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{ConnStallAutoDisconnect: &disabled}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	if cm.shouldAutoDisconnectOnStall() {
		t.Fatalf("expected false when config disabled")
	}
}

// TestDisconnectOnStallChangesStatus verifies that disconnectOnStall sets Status=Disconnected.
func TestDisconnectOnStallChangesStatus(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)
	cm := makeTestMonitor(conn)

	cm.disconnectOnStall()

	// Allow the goroutine inside disconnectOnStall to run
	time.Sleep(100 * time.Millisecond)

	status := conn.GetStatus()
	if status != Status_Disconnected {
		t.Fatalf("expected Status=Disconnected after stall disconnect, got %s", status)
	}
}

// TestDisconnectOnStallSkipsWhenDisabled verifies no disconnect when auto-disconnect is disabled.
func TestDisconnectOnStallSkipsWhenDisabled(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)
	cm := makeTestMonitor(conn)

	disabled := false
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{ConnStallAutoDisconnect: &disabled}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	cm.disconnectOnStall()
	time.Sleep(100 * time.Millisecond)

	if conn.GetStatus() != Status_Connected {
		t.Fatalf("expected Status to remain Connected when auto-disconnect disabled")
	}
}

// TestStallStartTimeTracking verifies StallStartTime is set on stall and reset when stall clears.
func TestStallStartTimeTracking(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)
	cm := makeTestMonitor(conn)

	// Simulate: keepalive in-flight, no response, activity stale
	cm.LastActivityTime.Store(time.Now().UnixMilli() - 20000)
	cm.KeepAliveInFlight = true
	cm.KeepAliveSentTime.Store(time.Now().UnixMilli() - 15000)

	cm.checkConnection()
	if cm.StallStartTime.Load() == 0 {
		t.Fatalf("expected StallStartTime to be set after stall detection")
	}

	// Simulate stall clearing (keepalive returned, activity restored)
	cm.KeepAliveInFlight = false
	cm.LastActivityTime.Store(time.Now().UnixMilli())
	cm.checkConnection()
	if cm.StallStartTime.Load() != 0 {
		t.Fatalf("expected StallStartTime to be reset after stall clears")
	}
}

// mockConn implements ssh.Conn for testing waitForDisconnect.
// Its Wait() method blocks until closeCh is closed, then returns waitErr.
type mockConn struct {
	closeCh  chan struct{}
	waitErr  error
	mu       sync.Mutex
	closed   bool
}

func newMockConn() *mockConn {
	return &mockConn{closeCh: make(chan struct{})}
}

func (m *mockConn) Wait() error {
	<-m.closeCh
	return m.waitErr
}

func (m *mockConn) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.closed {
		close(m.closeCh)
		m.closed = true
	}
	return nil
}

func (m *mockConn) User() string                                             { return "testuser" }
func (m *mockConn) SessionID() []byte                                        { return []byte("testsession") }
func (m *mockConn) ClientVersion() []byte                                    { return []byte("testclient") }
func (m *mockConn) ServerVersion() []byte                                    { return []byte("testserver") }
func (m *mockConn) RemoteAddr() net.Addr                                     { return &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 22} }
func (m *mockConn) LocalAddr() net.Addr                                      { return &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 12345} }
func (m *mockConn) SendRequest(name string, wantReply bool, payload []byte) (bool, []byte, error) {
	return false, nil, fmt.Errorf("not implemented")
}
func (m *mockConn) OpenChannel(name string, data []byte) (ssh.Channel, <-chan *ssh.Request, error) {
	return nil, nil, fmt.Errorf("not implemented")
}
func (m *mockConn) OpenChannelWithTimeout(name string, data []byte, timeout time.Duration) (ssh.Channel, <-chan *ssh.Request, error) {
	return nil, nil, fmt.Errorf("not implemented")
}

// newMockSSHClient creates a *ssh.Client backed by a mockConn.
// The client's Wait() will block until mockConn.Close() is called.
func newMockSSHClient() (*ssh.Client, *mockConn) {
	mc := newMockConn()
	chans := make(chan ssh.NewChannel)
	reqs := make(chan *ssh.Request)
	client := ssh.NewClient(mc, chans, reqs)
	return client, mc
}

// TestWaitForDisconnect_StaleGuard_PreventsConnectionFlap verifies that a stale
// waitForDisconnect goroutine (waiting on an old client_A) does not overwrite
// Status=Connected or close resources belonging to a new client_B that was
// established via Connect() before the stale goroutine acquired lifecycleLock.
//
// This is the core race condition from issue #16:
// 1. Close() kills client_A, triggering waitForDisconnect on client_A
// 2. Connect() establishes client_B and sets Status=Connected
// 3. Stale waitForDisconnect acquires lifecycleLock after Connect() releases it
// 4. Without the guard, it would overwrite Status=Disconnected and close client_B
// 5. With the guard, it detects currentClient != old client and returns early
func TestWaitForDisconnect_StaleGuard_PreventsConnectionFlap(t *testing.T) {
	t.Parallel()

	// Create a test connection in Connected state with a mock client_A
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	clientA, mockConnA := newMockSSHClient()
	conn.WithLock(func() {
		conn.Client = clientA
	})

	// Start waitForDisconnect on client_A. It will block on mockConnA.Wait().
	staleDone := make(chan struct{})
	go func() {
		defer close(staleDone)
		conn.waitForDisconnect()
	}()

	// Simulate the race: while waitForDisconnect is blocked on client_A.Wait(),
	// Close() runs and then Connect() establishes a new client_B.
	//
	// We simulate this by:
	// 1. Holding lifecycleLock to prevent waitForDisconnect from proceeding
	// 2. Closing client_A (so Wait() will return)
	// 3. Replacing conn.Client with client_B and setting Status=Connected
	// 4. Releasing lifecycleLock so waitForDisconnect can proceed

	// Step 1: Acquire lifecycleLock to block waitForDisconnect after Wait() returns
	// (We need a brief pause to ensure waitForDisconnect has started and is
	//  blocked on Wait(). Since Wait() blocks on a channel, it's safe after
	//  a short yield.)
	runtime.Gosched()
	time.Sleep(10 * time.Millisecond)

	conn.lifecycleLock.Lock()

	// Step 2: Close the old mock connection so client_A.Wait() will return.
	mockConnA.Close()

	// Step 3: Simulate Connect() replacing the client with a new one.
	clientB, _ := newMockSSHClient()
	conn.WithLock(func() {
		conn.Client = clientB
		conn.Status = Status_Connected
	})

	// Step 4: Release lifecycleLock, allowing the stale waitForDisconnect to proceed.
	conn.lifecycleLock.Unlock()

	// Wait for the stale waitForDisconnect to finish.
	select {
	case <-staleDone:
		// Good, stale waitForDisconnect completed
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for stale waitForDisconnect to complete")
	}

	// Verify: the new client_B was NOT disrupted by the stale goroutine.
	currentClient := conn.GetClient()
	if currentClient != clientB {
		t.Fatal("stale waitForDisconnect closed the new client_B — guard failed")
	}

	if conn.GetStatus() != Status_Connected {
		t.Fatalf("expected Status=Connected, got %s — stale waitForDisconnect overwrote status", conn.GetStatus())
	}

	// Verify: client_B is still usable (not closed). We can't directly check
	// if ssh.Client is closed, but we can verify the DomainSockListener and
	// ConnController were not nil'd out (they should still be nil since we
	// never set them, but the important thing is the guard prevented the
	// stale closeInternal_withlifecyclelock from running).
}

// TestWaitForDisconnect_NormalDisconnect_NoGuard verifies that when no new
// connection supersedes the old one, waitForDisconnect proceeds normally and
// sets Status=Disconnected and cleans up resources.
func TestWaitForDisconnect_NormalDisconnect_NoGuard(t *testing.T) {
	t.Parallel()

	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	clientA, mockConnA := newMockSSHClient()
	conn.WithLock(func() {
		conn.Client = clientA
	})

	// Start waitForDisconnect on client_A.
	disconnectDone := make(chan struct{})
	go func() {
		defer close(disconnectDone)
		conn.waitForDisconnect()
	}()

	// Give waitForDisconnect time to start and block on Wait().
	runtime.Gosched()
	time.Sleep(10 * time.Millisecond)

	// Close client_A so Wait() returns. No new connection is established.
	mockConnA.Close()

	// Wait for waitForDisconnect to complete.
	select {
	case <-disconnectDone:
		// Good
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for waitForDisconnect to complete")
	}

	// Verify: status was set to Disconnected.
	if conn.GetStatus() != Status_Disconnected {
		t.Fatalf("expected Status=Disconnected, got %s", conn.GetStatus())
	}

	// Verify: Client was cleaned up (set to nil).
	if conn.GetClient() != nil {
		t.Fatal("expected Client to be nil after normal disconnect")
	}
}

// TestCloseInternal_ExpectedClientGuard_PreventsResourceTheft verifies the
// defense-in-depth guard in closeInternal_withlifecyclelock: when expectedClient
// is provided and does not match conn.Client, resources should NOT be captured
// or closed.
func TestCloseInternal_ExpectedClientGuard_PreventsResourceTheft(t *testing.T) {
	t.Parallel()

	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	clientA, _ := newMockSSHClient()
	clientB, _ := newMockSSHClient()

	// Set up conn with client_B (simulating a new connection)
	monitor := makeTestMonitor(conn)
	conn.WithLock(func() {
		conn.Client = clientB
		conn.Monitor = monitor
		conn.Status = Status_Connected
	})

	// Call closeInternal_withlifecyclelock with expectedClient=clientA,
	// which does NOT match the current client_B.
	// This should NOT capture or close client_B or the monitor.
	conn.lifecycleLock.Lock()
	conn.closeInternal_withlifecyclelock(clientA)
	conn.lifecycleLock.Unlock()

	// Allow the goroutine-based cleanup to run.
	time.Sleep(50 * time.Millisecond)

	// Verify: client_B was NOT stolen (still the active client).
	currentClient := conn.GetClient()
	if currentClient != clientB {
		t.Fatal("closeInternal_withlifecyclelock stole client_B despite expectedClient guard")
	}

	// Verify: monitor was NOT closed (still set).
	conn.lock.Lock()
	mon := conn.Monitor
	conn.lock.Unlock()
	if mon != monitor {
		t.Fatal("closeInternal_withlifecyclelock closed Monitor despite expectedClient guard")
	}
}

// TestCloseInternal_NilExpectedClient_AlwaysCleansUp verifies that when
// expectedClient is nil (called from Close() or Connect() error path),
// closeInternal_withlifecyclelock always cleans up regardless of the current client.
func TestCloseInternal_NilExpectedClient_AlwaysCleansUp(t *testing.T) {
	t.Parallel()

	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	clientA, _ := newMockSSHClient()
	monitor := makeTestMonitor(conn)
	conn.WithLock(func() {
		conn.Client = clientA
		conn.Monitor = monitor
	})

	// Call closeInternal_withlifecyclelock with nil expectedClient.
	// This should always clean up.
	conn.lifecycleLock.Lock()
	conn.closeInternal_withlifecyclelock(nil)
	conn.lifecycleLock.Unlock()

	// Allow the goroutine-based cleanup to run.
	time.Sleep(50 * time.Millisecond)

	// Verify: Client was captured and nil'd.
	if conn.GetClient() != nil {
		t.Fatal("expected Client to be nil after closeInternal_withlifecyclelock(nil)")
	}

	// Verify: Monitor was closed and nil'd.
	conn.lock.Lock()
	mon := conn.Monitor
	conn.lock.Unlock()
	if mon != nil {
		t.Fatal("expected Monitor to be nil after closeInternal_withlifecyclelock(nil)")
	}
}

// TestCopyBoth verifies bidirectional data transfer between two connections.
func TestCopyBoth(t *testing.T) {
	t.Parallel()

	// Create a pair of net.Pipe connections
	c1, c2 := net.Pipe()
	c3, c4 := net.Pipe()

	// Send data from c1 to c3 via copyBoth
	go func() {
		copyBoth(c2, c3)
	}()

	// Write to c1, read from c4
	msg := []byte("hello")
	go func() {
		c1.Write(msg)
		c1.Close()
	}()

	buf := make([]byte, len(msg))
	_, err := c4.Read(buf)
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("expected %q, got %q", msg, buf)
	}
	c4.Close()
}

// halfCloseConn wraps a net.Conn to track CloseWrite calls while
// delegating to the underlying connection so the actual FIN is sent.
type halfCloseConn struct {
	net.Conn
	closeWriteCalled atomic.Bool
}

func (h *halfCloseConn) CloseWrite() error {
	h.closeWriteCalled.Store(true)
	// Delegate to the underlying connection so the FIN/EOF is actually sent.
	if hc, ok := h.Conn.(interface{ CloseWrite() error }); ok {
		return hc.CloseWrite()
	}
	return nil
}

// TestCopyBothHalfClose verifies that copyBoth calls CloseWrite on each
// connection when the opposite direction reaches EOF. This is the critical
// fix for the port-forwarding bug where subsequent HTTP requests would fail
// because the dead SSH channel's EOF was never propagated as a TCP FIN.
//
// Real scenario:
//   browser ←TCP→ localConn ←copyBoth→ remoteConn ←SSH→ wrangler
//
// Test simulation:
//   browserSide ←TCP→ tunnelLocal ←copyBoth→ tunnelRemote ←TCP→ serverSide
//
// When the server closes its TCP connection, copyBoth should propagate
// that EOF to the browser by calling CloseWrite on the local tunnel endpoint.
func TestCopyBothHalfClose(t *testing.T) {
	t.Parallel()

	// Create two TCP pairs:
	//   pair1: tunnelLocal ↔ browserSide
	//   pair2: tunnelRemote ↔ serverSide
	ln1, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen1: %v", err)
	}
	defer ln1.Close()

	ln2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen2: %v", err)
	}
	defer ln2.Close()

	// pair1
	browserSide, err := net.Dial("tcp", ln1.Addr().String())
	if err != nil {
		t.Fatalf("dial1: %v", err)
	}
	defer browserSide.Close()
	tunnelLocal, err := ln1.Accept()
	if err != nil {
		t.Fatalf("accept1: %v", err)
	}

	// pair2
	tunnelRemote, err := net.Dial("tcp", ln2.Addr().String())
	if err != nil {
		t.Fatalf("dial2: %v", err)
	}
	serverSide, err := ln2.Accept()
	if err != nil {
		t.Fatalf("accept2: %v", err)
	}

	// Wrap tunnel-side connections to track CloseWrite calls
	localW := &halfCloseConn{Conn: tunnelLocal}
	remoteW := &halfCloseConn{Conn: tunnelRemote}

	// Run copyBoth bridging the tunnel endpoints
	copyDone := make(chan struct{})
	go func() {
		defer close(copyDone)
		copyBoth(localW, remoteW)
	}()

	// --- Scenario: server sends response and closes connection ---
	// This simulates wrangler serving a page then closing the TCP connection.
	// The tunnel must propagate EOF to the browser side via CloseWrite.

	// Server writes a response
	response := []byte("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")
	if _, err := serverSide.Write(response); err != nil {
		t.Fatalf("server write: %v", err)
	}
	// Server closes its write side (simulates wrangler closing TCP after response)
	serverSide.(*net.TCPConn).CloseWrite()

	// Browser reads the full response. Because the server closed, EOF should
	// propagate through the tunnel: remoteW EOF → copyBoth → localW.CloseWrite()
	// → browserSide gets FIN → io.ReadAll returns.
	// Without the half-close fix, io.ReadAll would hang forever (no FIN sent).
	browserSide.(*net.TCPConn).SetReadDeadline(time.Now().Add(3 * time.Second))
	data, err := io.ReadAll(browserSide)
	if err != nil {
		t.Fatalf("browser read: %v", err)
	}
	if !bytes.Contains(data, []byte("200 OK")) {
		t.Fatalf("expected response, got: %q", data)
	}

	// CRITICAL ASSERTION: localW.CloseWrite() must have been called.
	// Without this, the browser never receives FIN and doesn't know the
	// server closed — causing the keep-alive reuse bug.
	if !localW.closeWriteCalled.Load() {
		t.Fatal("CloseWrite NOT called on local tunnel endpoint when server closed — " +
			"half-close not propagated, browser would hang")
	}

	// --- Cleanup: close browser side to let copyBoth finish ---
	browserSide.Close()

	select {
	case <-copyDone:
	case <-time.After(5 * time.Second):
		t.Fatal("copyBoth did not complete")
	}

	// Verify the reverse direction: when browser closed, remoteW.CloseWrite()
	// should have been called to send EOF to the server side.
	if !remoteW.closeWriteCalled.Load() {
		t.Fatal("CloseWrite NOT called on remote tunnel endpoint when browser closed")
	}
}

// TestLocalForwardStartsAndStops verifies that LocalForward listeners are
// created on startPortForwarding and closed on closeInternal_withlifecyclelock.
func TestLocalForwardStartsAndStops(t *testing.T) {
	t.Parallel()

	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	// Find a free port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to find free port: %v", err)
	}
	addr := listener.Addr().String()
	listener.Close()

	// Create a minimal client (won't actually dial, but the listener should start)
	client, _ := newMockSSHClient()
	monitor := makeTestMonitor(conn)
	conn.WithLock(func() {
		conn.Client = client
		conn.Monitor = monitor
	})

	keywords := &wconfig.ConnKeywords{
		SshLocalForward: []string{addr + " 127.0.0.1:9999"},
	}

	ctx := context.Background()
	conn.startPortForwarding(ctx, keywords)

	// Give goroutines time to start
	time.Sleep(100 * time.Millisecond)

	// Verify listener was created
	conn.lock.Lock()
	listenerCount := len(conn.LocalForwardListeners)
	conn.lock.Unlock()
	if listenerCount != 1 {
		t.Fatalf("expected 1 LocalForwardListener, got %d", listenerCount)
	}

	// Close and verify cleanup
	conn.lifecycleLock.Lock()
	conn.closeInternal_withlifecyclelock(nil)
	conn.lifecycleLock.Unlock()

	time.Sleep(50 * time.Millisecond)

	conn.lock.Lock()
	listenerCount = len(conn.LocalForwardListeners)
	conn.lock.Unlock()
	if listenerCount != 0 {
		t.Fatalf("expected 0 LocalForwardListeners after close, got %d", listenerCount)
	}
}

// TestStartPortForwarding_MalformedRule verifies that malformed rules are
// skipped and logged without crashing.
func TestStartPortForwarding_MalformedRule(t *testing.T) {
	t.Parallel()

	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	client, _ := newMockSSHClient()
	monitor := makeTestMonitor(conn)
	conn.WithLock(func() {
		conn.Client = client
		conn.Monitor = monitor
	})

	keywords := &wconfig.ConnKeywords{
		SshLocalForward:  []string{"only-one-field", "also-wrong", "8080 localhost:80 127.0.0.1:9090"},
		SshRemoteForward: []string{"valid 127.0.0.1:9090"},
	}

	ctx := context.Background()
	conn.startPortForwarding(ctx, keywords)

	// Give goroutines time to start
	time.Sleep(100 * time.Millisecond)

	// Only the valid RemoteForward should have been attempted (but will fail
	// because the mock client doesn't support Listen). The malformed rules
	// should have been skipped.
	conn.lock.Lock()
	localCount := len(conn.LocalForwardListeners)
	remoteCount := len(conn.RemoteForwardListeners)
	conn.lock.Unlock()
	if localCount != 0 {
		t.Fatalf("expected 0 LocalForwardListeners (all malformed), got %d", localCount)
	}
	if remoteCount != 0 {
		t.Fatalf("expected 0 RemoteForwardListeners (mock client can't Listen), got %d", remoteCount)
	}
}

// TestStartPortForwarding_NilClient verifies that startPortForwarding
// returns immediately when client is nil.
func TestStartPortForwarding_NilClient(t *testing.T) {
	t.Parallel()

	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	// Client is nil by default
	keywords := &wconfig.ConnKeywords{
		SshLocalForward: []string{"8080 localhost:80"},
	}

	ctx := context.Background()
	conn.startPortForwarding(ctx, keywords)

	// Should return without panic
	conn.lock.Lock()
	listenerCount := len(conn.LocalForwardListeners)
	conn.lock.Unlock()
	if listenerCount != 0 {
		t.Fatalf("expected 0 listeners with nil client, got %d", listenerCount)
	}
}

func TestParseForwardRule(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name           string
		input          string
		direction      sshForwardDirection
		wantListenType sshForwardType
		wantListenAddr string
		wantDialType   sshForwardType
		wantDialAddr   string
		wantErr        bool
	}{
		// LocalForward - TCP cases
		{"local port-only bind", "8765 localhost:8765", forwardLocal,
			forwardTCPListen, "127.0.0.1:8765", forwardTCPDial, "localhost:8765", false},
		{"local explicit bind", "localhost:8765 remote:80", forwardLocal,
			forwardTCPListen, "localhost:8765", forwardTCPDial, "remote:80", false},
		{"local ip bind", "192.168.1.1:8765 remote:80", forwardLocal,
			forwardTCPListen, "192.168.1.1:8765", forwardTCPDial, "remote:80", false},
		{"local wildcard bind", "*:8765 remote:80", forwardLocal,
			forwardTCPListen, "*:8765", forwardTCPDial, "remote:80", false},
		{"local ipv6 bind", "[::1]:8765 remote:80", forwardLocal,
			forwardTCPListen, "[::1]:8765", forwardTCPDial, "remote:80", false},
		// LocalForward - Unix socket cases
		{"local unix listen", "/tmp/a.sock remote:80", forwardLocal,
			forwardUnix, "/tmp/a.sock", forwardTCPDial, "remote:80", false},
		{"local unix dial", "8765 /var/run/app.sock", forwardLocal,
			forwardTCPListen, "127.0.0.1:8765", forwardUnix, "/var/run/app.sock", false},
		{"local unix both", "/tmp/a.sock /tmp/b.sock", forwardLocal,
			forwardUnix, "/tmp/a.sock", forwardUnix, "/tmp/b.sock", false},
		// RemoteForward - TCP cases
		{"remote basic", "8765 localhost:8765", forwardRemote,
			forwardTCPListen, "127.0.0.1:8765", forwardTCPDial, "localhost:8765", false},
		{"remote explicit bind", "localhost:8765 remote:80", forwardRemote,
			forwardTCPListen, "localhost:8765", forwardTCPDial, "remote:80", false},
		// RemoteForward - SOCKS proxy mode
		{"remote socks proxy", "8080", forwardRemote,
			forwardTCPListen, "127.0.0.1:8080", forwardSOCKS, "", false},
		{"remote socks proxy wildcard", "*:8080", forwardRemote,
			forwardTCPListen, "*:8080", forwardSOCKS, "", false},
		// RemoteForward - Unix socket cases
		{"remote unix listen", "/tmp/remote.sock localhost:80", forwardRemote,
			forwardUnix, "/tmp/remote.sock", forwardTCPDial, "localhost:80", false},
		{"remote unix dial", "8765 /var/run/app.sock", forwardRemote,
			forwardTCPListen, "127.0.0.1:8765", forwardUnix, "/var/run/app.sock", false},
		// Error cases
		{"local no destination", "8765", forwardLocal,
			"", "", "", "", true},
		{"empty input", "", forwardLocal,
			"", "", "", "", true},
		{"too many args", "8765 localhost:80 extra", forwardLocal,
			"", "", "", "", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseForwardRule(tc.input, tc.direction)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseForwardRule(%q, %v) expected error, got nil", tc.input, tc.direction)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseForwardRule(%q, %v) unexpected error: %v", tc.input, tc.direction, err)
			}
			if got.ListenType != tc.wantListenType {
				t.Fatalf("listen type = %v, want %v", got.ListenType, tc.wantListenType)
			}
			if got.ListenAddr != tc.wantListenAddr {
				t.Fatalf("listen addr = %q, want %q", got.ListenAddr, tc.wantListenAddr)
			}
			if got.DialType != tc.wantDialType {
				t.Fatalf("dial type = %v, want %v", got.DialType, tc.wantDialType)
			}
			if got.DialAddr != tc.wantDialAddr {
				t.Fatalf("dial addr = %q, want %q", got.DialAddr, tc.wantDialAddr)
			}
		})
	}
}

func TestIsUnixSocket(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input string
		want  bool
	}{
		{"/tmp/app.sock", true},
		{"/var/run/service.sock", true},
		{"8765", false},
		{"localhost:8765", false},
		{"*:8080", false},
		{"[::1]:9090", false},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got := isUnixSocket(tc.input)
			if got != tc.want {
				t.Fatalf("isUnixSocket(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

func TestNormalizeTcpListenAddr(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"port only", "8765", "127.0.0.1:8765"},
		{"host:port", "localhost:8765", "localhost:8765"},
		{"ip:port", "192.168.1.1:5173", "192.168.1.1:5173"},
		{"wildcard:port", "0.0.0.0:8080", "0.0.0.0:8080"},
		{"empty string", "", "127.0.0.1:"},
		{"single digit port", "8", "127.0.0.1:8"},
		{"ipv6 bracket", "[::1]:9090", "[::1]:9090"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeTcpListenAddr(tc.input)
			if got != tc.expected {
				t.Fatalf("normalizeTcpListenAddr(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

// --- Password Caching Tests ---

func TestCachePassword(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	// Initially no cached password
	if pw := conn.getCachedPassword(); pw != nil {
		t.Fatalf("expected nil cached password, got %q", *pw)
	}

	// Cache a password
	conn.cachePassword("secret123")
	pw := conn.getCachedPassword()
	if pw == nil {
		t.Fatal("expected cached password to be set")
	}
	if *pw != "secret123" {
		t.Fatalf("expected 'secret123', got %q", *pw)
	}
}

func TestClearCachedPassword(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	conn.cachePassword("secret123")
	conn.clearCachedPassword()

	if pw := conn.getCachedPassword(); pw != nil {
		t.Fatalf("expected nil after clear, got %q", *pw)
	}
}

func TestCachedPasswordClearedOnDisconnect(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	conn.cachePassword("secret123")
	if pw := conn.getCachedPassword(); pw == nil {
		t.Fatal("expected password to be cached before disconnect")
	}

	conn.Close()
	time.Sleep(100 * time.Millisecond)

	if pw := conn.getCachedPassword(); pw != nil {
		t.Fatalf("expected nil after disconnect, got %q", *pw)
	}
}

func TestCachedPasswordClearedOnAuthFailure(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	conn.cachePassword("wrong-password")

	// Mock connectInternal to return auth failure
	connectInternalTestHook = func(c *SSHConn, ctx context.Context, flags *wconfig.ConnKeywords) error {
		return fmt.Errorf("unable to authenticate")
	}
	defer func() { connectInternalTestHook = nil }()

	ctx := context.Background()
	conn.Connect(ctx, &wconfig.ConnKeywords{})

	// After auth failure, cached password should be cleared
	if pw := conn.getCachedPassword(); pw != nil {
		t.Fatalf("expected nil after auth failure, got %q", *pw)
	}
}

// --- PendingAuth Tests ---

func TestSetPendingAuth(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	// First call should set the flag
	if !conn.setPendingAuth() {
		t.Fatal("expected setPendingAuth to return true on first call")
	}

	// Second call should return false (already pending)
	if conn.setPendingAuth() {
		t.Fatal("expected setPendingAuth to return false when already pending")
	}

	// Clear and try again
	conn.clearPendingAuth()
	if !conn.setPendingAuth() {
		t.Fatal("expected setPendingAuth to return true after clear")
	}
}

func TestWaitForPendingAuth(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	conn.setPendingAuth()

	// Start waiting in a goroutine
	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		done <- conn.waitForPendingAuth(ctx)
	}()

	// Give time for the goroutine to start waiting
	time.Sleep(50 * time.Millisecond)

	// Clear pending auth
	conn.clearPendingAuth()

	// Waiter should complete
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("expected nil, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for pending auth waiter")
	}
}

func TestWaitForPendingAuthTimeout(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	conn.setPendingAuth()
	defer conn.clearPendingAuth()

	// Wait with a short timeout
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	err := conn.waitForPendingAuth(ctx)
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
}

func TestWaitForPendingAuthNoPending(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	// No pending auth, should return immediately
	ctx := context.Background()
	err := conn.waitForPendingAuth(ctx)
	if err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

// --- Cooldown Tests ---

func TestIsWithinConnectCooldown(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	// Initially not in cooldown
	if conn.isWithinConnectCooldown() {
		t.Fatal("expected false when no previous connect attempt")
	}

	// Set a recent connect time
	conn.WithLock(func() {
		conn.LastConnectTryAt = time.Now().UnixMilli()
	})

	// Should be in cooldown
	if !conn.isWithinConnectCooldown() {
		t.Fatal("expected true when connect was recent")
	}

	// Set an old connect time
	conn.WithLock(func() {
		conn.LastConnectTryAt = time.Now().UnixMilli() - 6000 // 6 seconds ago
	})

	// Should not be in cooldown
	if conn.isWithinConnectCooldown() {
		t.Fatal("expected false when connect was >5s ago")
	}
}

// --- HasCachedPassword Tests ---

func TestHasCachedPassword_LocalConn(t *testing.T) {
	t.Parallel()
	if HasCachedPassword("local") {
		t.Fatal("expected false for local connection")
	}
}

func TestHasCachedPassword_InvalidName(t *testing.T) {
	t.Parallel()
	if HasCachedPassword("not-a-valid-ssh-name") {
		t.Fatal("expected false for invalid name")
	}
}

func TestHasCachedPassword_UnknownConn(t *testing.T) {
	t.Parallel()
	if HasCachedPassword("user@unknownhost:22") {
		t.Fatal("expected false for unknown connection")
	}
}

func TestHasCachedPassword_WithCache(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	conn.cachePassword("secret123")
	if !HasCachedPassword(conn.GetName()) {
		t.Fatal("expected true when password is cached")
	}

	conn.clearCachedPassword()
	if HasCachedPassword(conn.GetName()) {
		t.Fatal("expected false after clearing cache")
	}
}

// --- EnsureConnection Tests ---

func TestEnsureConnection_LocalConn(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	err := EnsureConnection(ctx, "local")
	if err != nil {
		t.Fatalf("expected nil for local conn, got %v", err)
	}
}

func TestEnsureConnection_AlreadyConnected(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	ctx := context.Background()
	err := EnsureConnection(ctx, conn.GetName())
	if err != nil {
		t.Fatalf("expected nil for already-connected, got %v", err)
	}
}

func TestEnsureConnection_Connecting(t *testing.T) {
	conn := makeTestConn(Status_Connecting)
	defer cleanupTestConn(conn)

	// WaitForConnect should return quickly since status changes
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	// Set status to connected after a short delay
	go func() {
		time.Sleep(50 * time.Millisecond)
		conn.WithLock(func() {
			conn.Status = Status_Connected
		})
	}()

	err := EnsureConnection(ctx, conn.GetName())
	if err != nil {
		t.Fatalf("expected nil after connecting, got %v", err)
	}
}

func TestEnsureConnection_ErrorWithCachedPassword(t *testing.T) {
	conn := makeTestConn(Status_Error)
	conn.Error = "auth failed"
	defer cleanupTestConn(conn)

	conn.cachePassword("cached-secret")

	// Mock connectInternal to succeed this time (simulating cached password working)
	connectInternalTestHook = func(c *SSHConn, ctx context.Context, flags *wconfig.ConnKeywords) error {
		c.WithLock(func() {
			c.Status = Status_Connected
		})
		return nil
	}
	defer func() { connectInternalTestHook = nil }()

	ctx := context.Background()
	err := EnsureConnection(ctx, conn.GetName())
	if err != nil {
		t.Fatalf("expected nil with cached password retry, got %v", err)
	}
	if conn.GetStatus() != Status_Connected {
		t.Fatalf("expected Status=Connected, got %s", conn.GetStatus())
	}
}

func TestEnsureConnection_ErrorWithoutCachedPassword(t *testing.T) {
	conn := makeTestConn(Status_Error)
	conn.Error = "auth failed"
	defer cleanupTestConn(conn)

	ctx := context.Background()
	err := EnsureConnection(ctx, conn.GetName())
	if err == nil {
		t.Fatal("expected error when no cached password")
	}
}

// --- Connect Tests ---

func TestConnect_CachesPasswordOnSuccess(t *testing.T) {
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	// Mock connectInternal to simulate password being used
	connectInternalTestHook = func(c *SSHConn, ctx context.Context, flags *wconfig.ConnKeywords) error {
		// Simulate: password was used during handshake
		c.cachePassword("used-password")
		c.WithLock(func() {
			c.Status = Status_Connected
		})
		return nil
	}
	defer func() { connectInternalTestHook = nil }()

	ctx := context.Background()
	err := conn.Connect(ctx, &wconfig.ConnKeywords{})
	if err != nil {
		t.Fatalf("expected nil, got %v", err)
	}

	pw := conn.getCachedPassword()
	if pw == nil || *pw != "used-password" {
		t.Fatal("expected password to be cached after successful connect")
	}
}

func TestConnect_SetsCooldown(t *testing.T) {
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	connectInternalTestHook = func(c *SSHConn, ctx context.Context, flags *wconfig.ConnKeywords) error {
		c.WithLock(func() {
			c.Status = Status_Connected
		})
		return nil
	}
	defer func() { connectInternalTestHook = nil }()

	ctx := context.Background()
	conn.Connect(ctx, &wconfig.ConnKeywords{})

	if !conn.isWithinConnectCooldown() {
		t.Fatal("expected cooldown to be set after Connect()")
	}
}

func TestConnect_ConnectingBlocked(t *testing.T) {
	conn := makeTestConn(Status_Connecting)
	defer cleanupTestConn(conn)

	ctx := context.Background()
	err := conn.Connect(ctx, &wconfig.ConnKeywords{})
	if err == nil {
		t.Fatal("expected error when already connecting")
	}
}

func TestConnect_ConnectedBlocked(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	ctx := context.Background()
	err := conn.Connect(ctx, &wconfig.ConnKeywords{})
	if err == nil {
		t.Fatal("expected error when already connected")
	}
}

// --- CanAutoReconnect Tests ---

func TestCanAutoReconnect_CachedPassword(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	conn.cachePassword("secret123")
	status := conn.DeriveConnStatus()
	if !status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=true when password is cached")
	}
}

func TestCanAutoReconnect_NoCachedPassword_UnknownConn(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	// No cached password, connection not in config → false
	status := conn.DeriveConnStatus()
	if status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=false for unknown connection without cached password")
	}
}

func TestCanAutoReconnect_BatchMode(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	batchMode := true
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{SshBatchMode: &batchMode}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	status := conn.DeriveConnStatus()
	if !status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=true when batch mode is on")
	}
}

func TestCanAutoReconnect_PasswordSecretStore(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	secretName := "my-secret"
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{SshPasswordSecretName: &secretName}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	status := conn.DeriveConnStatus()
	if !status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=true when password secret is configured")
	}
}

func TestCanAutoReconnect_KeyOnlyAuth(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{
			SshPreferredAuthentications: []string{"publickey"},
		}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	status := conn.DeriveConnStatus()
	if !status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=true when only key-based auth is preferred")
	}
}

func TestCanAutoReconnect_PasswordAuthDisabled(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	falseVal := false
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{
			SshPasswordAuthentication:        &falseVal,
			SshKbdInteractiveAuthentication: &falseVal,
		}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	status := conn.DeriveConnStatus()
	if !status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=true when password auth is disabled")
	}
}

func TestCanAutoReconnect_PasswordAuthEnabled_Default(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	// Default: password auth enabled, no cached password → false
	// (connection is unknown, so canAutoReconnectLocked returns false)
	status := conn.DeriveConnStatus()
	if status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=false when password auth is enabled by default")
	}
}

func TestCanAutoReconnect_NilAuthSettings_InteractiveNeeded(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	// Connection is known but auth settings are nil (not explicitly set).
	// SSH defaults: PasswordAuthentication=yes, KbdInteractiveAuthentication=yes.
	// So interactive auth is needed → canAutoReconnect=false.
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		// Return empty config — both SshPasswordAuthentication and SshKbdInteractiveAuthentication are nil
		return wconfig.ConnKeywords{}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	status := conn.DeriveConnStatus()
	if status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=false when auth settings are nil (SSH defaults to enabled)")
	}
}

func TestDeriveConnStatus_IncludesCanAutoReconnect(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	status := conn.DeriveConnStatus()
	// Connected with no cached password → false
	if status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=false for connected without cached password")
	}

	// Cache password → true
	conn.cachePassword("test")
	status = conn.DeriveConnStatus()
	if !status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=true after caching password")
	}

	// Clear cache → false
	conn.clearCachedPassword()
	status = conn.DeriveConnStatus()
	if status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=false after clearing cache")
	}
}

// --- Change 2 tests: CloseInvoluntary preserves cached password ---

// TestCloseInvoluntary_PreservesCachedPassword verifies that CloseInvoluntary
// (used by stall auto-disconnect and HandleSystemResume) does NOT clear the
// cached password. This is the core fix for sleep/wake losing the cached
// password: an involuntary disconnect must preserve it so reconnect can reuse
// it silently.
func TestCloseInvoluntary_PreservesCachedPassword(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)

	conn.cachePassword("secret123")
	if pw := conn.getCachedPassword(); pw == nil {
		t.Fatal("expected password to be cached before CloseInvoluntary")
	}

	conn.CloseInvoluntary()
	time.Sleep(100 * time.Millisecond)

	if pw := conn.getCachedPassword(); pw == nil {
		t.Fatal("expected cached password to be PRESERVED after CloseInvoluntary")
	} else if *pw != "secret123" {
		t.Fatalf("expected cached password 'secret123' to be preserved, got %q", *pw)
	}

	if status := conn.GetStatus(); status != Status_Disconnected {
		t.Fatalf("expected Status=Disconnected after CloseInvoluntary, got %s", status)
	}
}

// TestDisconnectOnStall_PreservesCachedPassword verifies that the stall
// auto-disconnect path (disconnectOnStall → CloseInvoluntary) preserves the
// cached password. This is the regression test for the sleep/wake bug: the
// stall monitor fires after a network drop, and previously Close() wiped the
// cached password, turning a reconnectable password connection into one that
// requires a prompt.
func TestDisconnectOnStall_PreservesCachedPassword(t *testing.T) {
	conn := makeTestConn(Status_Connected)
	defer cleanupTestConn(conn)
	cm := makeTestMonitor(conn)

	conn.cachePassword("stall-secret")
	if pw := conn.getCachedPassword(); pw == nil {
		t.Fatal("expected password to be cached before stall disconnect")
	}

	cm.disconnectOnStall()
	time.Sleep(100 * time.Millisecond)

	if status := conn.GetStatus(); status != Status_Disconnected {
		t.Fatalf("expected Status=Disconnected after stall disconnect, got %s", status)
	}
	if pw := conn.getCachedPassword(); pw == nil {
		t.Fatal("expected cached password to be PRESERVED after stall disconnect (CloseInvoluntary)")
	} else if *pw != "stall-secret" {
		t.Fatalf("expected cached password 'stall-secret' to be preserved, got %q", *pw)
	}
}

// --- Change 1 tests: HasConnected heuristic in canAutoReconnectLocked ---

// TestCanAutoReconnect_HasConnected_NoPasswordSecret verifies the key fix: a
// connection that has connected successfully before (LastConnectTime > 0) with
// no password secret configured is auto-reconnectable, even though SSH defaults
// password/kbd-interactive auth to enabled. This is the key-based connection
// case — SSH will try keys first on reconnect; a key failure falls back to the
// password callback, which is rare and correct to surface.
func TestCanAutoReconnect_HasConnected_NoPasswordSecret(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	// Simulate a connection that has connected successfully before
	conn.WithLock(func() {
		conn.LastConnectTime = time.Now().UnixMilli()
	})

	// Config: empty (all auth settings nil → SSH defaults: password/kbd enabled)
	// but no password secret. Previously this returned false (interactive);
	// with the HasConnected heuristic, it returns true.
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	status := conn.DeriveConnStatus()
	if !status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=true for key-based connection that has connected before (HasConnected && no password secret)")
	}
}

// TestCanAutoReconnect_HasConnected_WithPasswordSecret confirms that a
// connection with a password secret is auto-reconnectable via the existing
// secret-store check, regardless of HasConnected. This is a regression guard
// to ensure the new HasConnected branch doesn't break the secret-store path.
func TestCanAutoReconnect_HasConnected_WithPasswordSecret(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	conn.WithLock(func() {
		conn.LastConnectTime = time.Now().UnixMilli()
	})

	secretName := "my-secret"
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{SshPasswordSecretName: &secretName}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	status := conn.DeriveConnStatus()
	if !status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=true when password secret is configured")
	}
}

// TestCanAutoReconnect_NeverConnected_StillInteractive verifies the conservative
// side of the heuristic: a connection that has NEVER connected (LastConnectTime
// = 0) with default auth settings (password/kbd enabled, no secret) is still
// classified as interactive. This prevents auto-reconnect from retrying a
// first-connect that would prompt.
func TestCanAutoReconnect_NeverConnected_StillInteractive(t *testing.T) {
	t.Parallel()
	conn := makeTestConn(Status_Disconnected)
	defer cleanupTestConn(conn)

	// LastConnectTime is 0 (never connected) — makeTestConn does not set it
	getConnectionConfigTestHook = func(c *SSHConn) (wconfig.ConnKeywords, bool) {
		return wconfig.ConnKeywords{}, true
	}
	defer func() { getConnectionConfigTestHook = nil }()

	status := conn.DeriveConnStatus()
	if status.CanAutoReconnect {
		t.Fatal("expected CanAutoReconnect=false for never-connected connection with default auth (conservative)")
	}
}
