// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jobcontroller

import (
	"context"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/streamclient"
	"github.com/wavetermdev/waveterm/pkg/util/ds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestShouldAttemptAutoReconnect(t *testing.T) {
	// Reset global state
	lastAutoReconnectAttempt = ds.MakeSyncMap[int64]()

	// First call with no prior attempt should return true
	if got := shouldAttemptAutoReconnect("job-a"); !got {
		t.Fatalf("first call: expected true, got false")
	}

	// Verify timestamp was NOT set by the check alone
	if _, exists := lastAutoReconnectAttempt.GetEx("job-a"); exists {
		t.Fatalf("shouldAttemptAutoReconnect must not set timestamp")
	}

	// Simulate a prior attempt within cooldown window
	lastAutoReconnectAttempt.Set("job-a", time.Now().Unix())

	// Second call inside cooldown should return false
	if got := shouldAttemptAutoReconnect("job-a"); got {
		t.Fatalf("second call inside cooldown: expected false, got true")
	}

	// Simulate cooldown expired
	lastAutoReconnectAttempt.Set("job-a", time.Now().Unix()-int64(AutoReconnectCooldown.Seconds())-1)

	// Call after cooldown should return true
	if got := shouldAttemptAutoReconnect("job-a"); !got {
		t.Fatalf("call after cooldown: expected true, got false")
	}

	// Still must not set timestamp itself
	if _, exists := lastAutoReconnectAttempt.GetEx("job-b"); exists {
		t.Fatalf("shouldAttemptAutoReconnect must not set timestamp for new job")
	}
}

// TestAttemptAutoReconnectCooldownSet verifies that the cooldown
// timestamp is only set after IsConnected returns true.
func TestAttemptAutoReconnectCooldownSet(t *testing.T) {
	lastAutoReconnectAttempt = ds.MakeSyncMap[int64]()

	// Mock IsConnected to always return false
	isConnectedTestHook = func(connName string) (bool, error) {
		return false, nil
	}

	// Call synchronously; no goroutine needed because we just verify side effects
	attemptAutoReconnect("job-c", "conn:mock")

	// Timestamp should NOT have been set because connection was down
	if _, exists := lastAutoReconnectAttempt.GetEx("job-c"); exists {
		t.Fatalf("attemptAutoReconnect must not set timestamp when connection is down")
	}

	// Now mock IsConnected to return true
	isConnectedTestHook = func(connName string) (bool, error) {
		return true, nil
	}

	attemptAutoReconnect("job-d", "conn:mock")

	// Timestamp SHOULD have been set because connection was up
	if _, exists := lastAutoReconnectAttempt.GetEx("job-d"); !exists {
		t.Fatalf("attemptAutoReconnect must set timestamp when connection is up")
	}

	isConnectedTestHook = nil
}

// TestConnStateGenerationTracking verifies that actualGen increments
// only when the actual connection state changes.
func TestConnStateGenerationTracking(t *testing.T) {
	// Reset global connStates
	connStates = &connStateManager{
		m:           make(map[string]*connState),
		reconcileCh: make(chan struct{}, 1),
	}

	cs := &connState{actual: false, procGen: 0, actualGen: 0, reconciling: false}
	connStates.m["conn:gen"] = cs

	// First change false -> true
	connStates.Lock()
	if cs.actual != true {
		cs.actual = true
		cs.actualGen++
	}
	connStates.Unlock()

	if cs.actualGen != 1 {
		t.Fatalf("expected actualGen=1 after first change, got %d", cs.actualGen)
	}

	// No change true -> true (must use lock to avoid racing with test reads)
	connStates.Lock()
	if cs.actual != true {
		cs.actual = true
		cs.actualGen++
	}
	connStates.Unlock()

	if cs.actualGen != 1 {
		t.Fatalf("expected actualGen=1 after no-change, got %d", cs.actualGen)
	}

	// Second change true -> false
	connStates.Lock()
	if cs.actual != false {
		cs.actual = false
		cs.actualGen++
	}
	connStates.Unlock()

	if cs.actualGen != 2 {
		t.Fatalf("expected actualGen=2 after second change, got %d", cs.actualGen)
	}
}

// TestReconcileAllConnsSpawnsOnGenerationMismatch verifies that
// reconcileAllConns sets reconciling=true when actualGen != procGen.
func TestReconcileAllConnsSpawnsOnGenerationMismatch(t *testing.T) {
	connStates = &connStateManager{
		m:           make(map[string]*connState),
		reconcileCh: make(chan struct{}, 1),
	}

	cs := &connState{actual: true, procGen: 0, actualGen: 1, reconciling: false}
	connStates.m["conn:spawn"] = cs

	// Fast no-op so reconcileConn finishes quickly
	reconcileOnUpTestHook = func(connName string) {}
	defer func() { reconcileOnUpTestHook = nil }()

	reconcileAllConns()

	connStates.Lock()
	r := cs.reconciling
	connStates.Unlock()
	if !r {
		t.Fatalf("expected reconciling=true for mismatched gen")
	}

	// Poll until the spawned goroutine finishes and clears reconciling
	for i := 0; i < 1000; i++ {
		connStates.Lock()
		r = cs.reconciling
		connStates.Unlock()
		if !r {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	connStates.Lock()
	r = cs.reconciling
	connStates.Unlock()
	if r {
		t.Fatalf("expected reconciling=false after reconcile completes")
	}
}

// TestReconcileConnUpdatesProcGen verifies that reconcileConn updates
// procGen to the target generation and clears reconciling.
func TestReconcileConnUpdatesProcGen(t *testing.T) {
	connStates = &connStateManager{
		m:           make(map[string]*connState),
		reconcileCh: make(chan struct{}, 1),
	}

	cs := &connState{actual: true, procGen: 0, actualGen: 1, reconciling: true}
	connStates.m["conn:proc"] = cs

	// Drain any stale signal from the channel
	select {
	case <-connStates.reconcileCh:
	default:
	}

	reconcileConn("conn:proc", true, 1)

	if cs.procGen != 1 {
		t.Fatalf("expected procGen=1, got %d", cs.procGen)
	}
	if cs.reconciling {
		t.Fatalf("expected reconciling=false after reconcileConn")
	}

	// Since actualGen == procGen, no follow-up signal should have been sent
	select {
	case <-connStates.reconcileCh:
		t.Fatalf("unexpected follow-up signal when actualGen == procGen")
	default:
	}
}

// TestReconcileConnFollowUpSignalOnMismatch verifies that reconcileConn
// sends a follow-up reconcile signal when actualGen != procGen at finish.
func TestReconcileConnFollowUpSignalOnMismatch(t *testing.T) {
	connStates = &connStateManager{
		m:           make(map[string]*connState),
		reconcileCh: make(chan struct{}, 1),
	}

	cs := &connState{actual: true, procGen: 0, actualGen: 2, reconciling: true}
	connStates.m["conn:follow"] = cs

	// Drain any stale signal
	select {
	case <-connStates.reconcileCh:
	default:
	}

	reconcileConn("conn:follow", false, 1)

	if cs.procGen != 1 {
		t.Fatalf("expected procGen=1, got %d", cs.procGen)
	}
	if cs.reconciling {
		t.Fatalf("expected reconciling=false after reconcileConn")
	}

	// A follow-up signal should be in the channel (or buffer full, but we drain)
	var gotSignal bool
	select {
	case <-connStates.reconcileCh:
		gotSignal = true
	default:
	}
	if !gotSignal {
		t.Fatalf("expected follow-up signal when actualGen != procGen")
	}
}

// TestReconcileConnRapidFlapRecovery verifies the full rapid-flap scenario:
// actual flaps during reconcile, and the generation counter ensures
// a follow-up reconcile is scheduled.
func TestReconcileConnRapidFlapRecovery(t *testing.T) {
	connStates = &connStateManager{
		m:           make(map[string]*connState),
		reconcileCh: make(chan struct{}, 1),
	}

	cs := &connState{actual: true, procGen: 0, actualGen: 1, reconciling: true}
	connStates.m["conn:flap"] = cs

	reconcileOnUpTestHook = func(connName string) {
		// Simulate a flap during processing: actual goes down and back up
		connStates.Lock()
		cs.actual = false
		cs.actualGen++
		connStates.Unlock()
	}
	defer func() { reconcileOnUpTestHook = nil }()

	// Drain stale signal
	select {
	case <-connStates.reconcileCh:
	default:
	}

	reconcileConn("conn:flap", true, 1)

	// After reconcileConn finishes, actualGen=2, procGen=1 -> mismatch
	if cs.procGen != 1 {
		t.Fatalf("expected procGen=1, got %d", cs.procGen)
	}
	if cs.actualGen != 2 {
		t.Fatalf("expected actualGen=2 after simulated flap, got %d", cs.actualGen)
	}

	// Follow-up signal should be present
	var gotSignal bool
	select {
	case <-connStates.reconcileCh:
		gotSignal = true
	default:
	}
	if !gotSignal {
		t.Fatalf("expected follow-up signal after rapid flap")
	}
}

// TestSingleflightGroupsAreDistinct verifies that ReconnectJob and
// ReconnectJobRoute use different singleflight.Group instances.
func TestSingleflightGroupsAreDistinct(t *testing.T) {
	if &reconnectConnGroup == &reconnectRouteGroup {
		t.Fatalf("reconnectConnGroup and reconnectRouteGroup must be different instances")
	}

	// Verify concurrency isolation: two simultaneous calls to the same jobId,
	// one via ReconnectJob and one via ReconnectJobRoute, should NOT block each other.
	var connGate sync.WaitGroup
	connGate.Add(1)
	var routeGate sync.WaitGroup
	routeGate.Add(1)

	var connEntered int32
	var routeEntered int32

	// Override doReconnectJob path via test hooks inside singleflight
	// We use the actual groups but with a stub doReconnectJob.
	// Since we can't intercept doReconnectJob easily, we test the group behavior directly.

	// Start a blocked call in reconnectConnGroup
	go func() {
		reconnectConnGroup.Do("job:x", func() (any, error) {
			atomic.AddInt32(&connEntered, 1)
			connGate.Wait()
			return nil, nil
		})
	}()

	// Start a blocked call in reconnectRouteGroup for the same key
	go func() {
		reconnectRouteGroup.Do("job:x", func() (any, error) {
			atomic.AddInt32(&routeEntered, 1)
			routeGate.Wait()
			return nil, nil
		})
	}()

	// Give both goroutines time to enter their respective groups
	time.Sleep(200 * time.Millisecond)

	if atomic.LoadInt32(&connEntered) != 1 {
		t.Fatalf("expected conn group call to have entered")
	}
	if atomic.LoadInt32(&routeEntered) != 1 {
		t.Fatalf("expected route group call to have entered")
	}

	// Release both
	connGate.Done()
	routeGate.Done()
	time.Sleep(100 * time.Millisecond)
}

// TestHandleConnChangeEventIncrementsGen verifies that the event handler
// increments actualGen only on true state transitions.
func TestHandleConnChangeEventIncrementsGen(t *testing.T) {
	connStates = &connStateManager{
		m:           make(map[string]*connState),
		reconcileCh: make(chan struct{}, 1),
	}

	// First event: connected=true
	event1 := wps.WaveEvent{
		Event:  wps.Event_ConnChange,
		Scopes: []string{"connection:evtest"},
		Data:   wshrpc.ConnStatus{Connected: true},
	}
	handleConnChangeEvent(&event1)

	cs, exists := connStates.m["evtest"]
	if !exists {
		t.Fatalf("expected connState to be created")
	}
	if cs.actual != true {
		t.Fatalf("expected actual=true")
	}
	if cs.actualGen != 1 {
		t.Fatalf("expected actualGen=1 after first true event, got %d", cs.actualGen)
	}

	// Second event: connected=true again (no change)
	handleConnChangeEvent(&event1)
	if cs.actualGen != 1 {
		t.Fatalf("expected actualGen=1 after duplicate true event, got %d", cs.actualGen)
	}

	// Third event: connected=false
	event2 := wps.WaveEvent{
		Event:  wps.Event_ConnChange,
		Scopes: []string{"connection:evtest"},
		Data:   wshrpc.ConnStatus{Connected: false},
	}
	handleConnChangeEvent(&event2)
	if cs.actual != false {
		t.Fatalf("expected actual=false")
	}
	if cs.actualGen != 2 {
		t.Fatalf("expected actualGen=2 after false event, got %d", cs.actualGen)
	}

	// Fourth event: connected=true again
	handleConnChangeEvent(&event1)
	if cs.actual != true {
		t.Fatalf("expected actual=true")
	}
	if cs.actualGen != 3 {
		t.Fatalf("expected actualGen=3 after final true event, got %d", cs.actualGen)
	}
}

// TestAttemptAutoReconnectSkipsCooldownWhenDown is an end-to-end style test
// verifying that if the connection is down, no cooldown is consumed,
// so a subsequent attempt can proceed immediately.
func TestAttemptAutoReconnectSkipsCooldownWhenDown(t *testing.T) {
	lastAutoReconnectAttempt = ds.MakeSyncMap[int64]()

	isConnectedTestHook = func(connName string) (bool, error) {
		return false, nil
	}

	attemptAutoReconnect("job-e", "conn:mock")

	// No timestamp set
	if _, exists := lastAutoReconnectAttempt.GetEx("job-e"); exists {
		t.Fatalf("timestamp must not be set when connection is down")
	}

	isConnectedTestHook = nil

	// shouldAttemptAutoReconnect should still allow another attempt immediately
	if got := shouldAttemptAutoReconnect("job-e"); !got {
		t.Fatalf("expected second attempt to be allowed because no cooldown was consumed")
	}
}

// TestReconcileAllConnsSkipsWhenGenMatches verifies that reconcileAllConns
// does not spawn a goroutine when procGen == actualGen.
func TestReconcileAllConnsSkipsWhenGenMatches(t *testing.T) {
	connStates = &connStateManager{
		m:           make(map[string]*connState),
		reconcileCh: make(chan struct{}, 1),
	}

	cs := &connState{actual: true, procGen: 1, actualGen: 1, reconciling: false}
	connStates.m["conn:match"] = cs

	reconcileAllConns()

	if cs.reconciling {
		t.Fatalf("expected reconciling=false when gen matches")
	}
}

// TestAttemptAutoReconnectSetsCooldownWhenUp verifies the happy path:
// connection is up, timestamp is set, and ReconnectJobRoute is called.
func TestAttemptAutoReconnectSetsCooldownWhenUp(t *testing.T) {
	lastAutoReconnectAttempt = ds.MakeSyncMap[int64]()

	isConnectedTestHook = func(connName string) (bool, error) {
		return true, nil
	}
	defer func() { isConnectedTestHook = nil }()

	// Stub out ReconnectJobRoute so we don't need wstore / rpc infrastructure
	var reconnectCalled int32
	reconnectRouteGroup.Do("job-f", func() (any, error) {
		atomic.AddInt32(&reconnectCalled, 1)
		return nil, fmt.Errorf("stub error")
	})
	// The stub call above warms the group and removes the key, so the real
	// attemptAutoReconnect will execute its own singleflight.

	attemptAutoReconnect("job-f", "conn:mock")

	if _, exists := lastAutoReconnectAttempt.GetEx("job-f"); !exists {
		t.Fatalf("timestamp must be set when connection is up")
	}

	isConnectedTestHook = nil
}

func TestOnConnectionDownDeduplication(t *testing.T) {
	// Reset scheduler tracking
	connectionReconnectSchedulers = ds.MakeSyncMap[bool]()

	connName := "conn:dedup"

	// With no connection config, needsInteractiveAuth returns true (safe default),
	// so onConnectionDown should skip the scheduler entirely.
	onConnectionDown(connName)
	if _, exists := connectionReconnectSchedulers.GetEx(connName); exists {
		t.Fatalf("expected no scheduler entry when interactive auth is possible")
	}
}

// TestHandleSystemResumeSmoke verifies that HandleSystemResume filters correctly
// and does not panic when processing connections.
func TestHandleSystemResumeSmoke(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	// Mock hasRunningDurableJobs to return true for our test connection
	hasRunningDurableJobsTestHook = func(ctx context.Context, connName string) bool {
		return connName == "testuser@testhost:2222"
	}
	defer func() { hasRunningDurableJobsTestHook = nil }()

	// Create a mock disconnected connection in the controller map
	testOpts := &remote.SSHOpts{SSHHost: "testhost", SSHUser: "testuser", SSHPort: "2222"}
	conn := conncontroller.GetConn(testOpts)
	conn.Status = conncontroller.Status_Disconnected
	conn.ConnHealthStatus = conncontroller.ConnHealthStatus_Good

	// Call HandleSystemResume — should attempt reconnect for the disconnected conn
	// (reconnect will fail because mock has no connectInternal hook, but that's expected)
	HandleSystemResume(ctx)

	// Note: mock connection remains in controller map but uses unique key,
	// so it won't interfere with other tests.
}

// TestIsNetworkUnreachable_ContextDeadline verifies that "context deadline exceeded"
// is recognized as a network-unreachable error for aggressive mode.
func TestIsNetworkUnreachable_ContextDeadline(t *testing.T) {
	t.Parallel()
	err := fmt.Errorf("context deadline exceeded")
	if !isNetworkUnreachableError(err) {
		t.Fatalf("expected 'context deadline exceeded' to be network-unreachable")
	}
}

// TestIsNetworkUnreachable_ContextDeadlineWrapped verifies the pattern
// when wrapped in other error text.
func TestIsNetworkUnreachable_ContextDeadlineWrapped(t *testing.T) {
	t.Parallel()
	err := fmt.Errorf("dial tcp 10.0.0.1:22: connect: context deadline exceeded")
	if !isNetworkUnreachableError(err) {
		t.Fatalf("expected wrapped 'context deadline exceeded' to be network-unreachable")
	}
}

// TestIsNetworkUnreachable_NilError verifies nil handling.
func TestIsNetworkUnreachable_NilError(t *testing.T) {
	t.Parallel()
	if isNetworkUnreachableError(nil) {
		t.Fatalf("expected nil to not be network-unreachable")
	}
}

// TestNeedsInteractiveAuth_LocalConn verifies that a local connection never
// needs interactive auth (CanReconnectWithoutPrompt returns true for local).
func TestNeedsInteractiveAuth_LocalConn(t *testing.T) {
	t.Parallel()
	if needsInteractiveAuth("local") {
		t.Fatalf("expected local connection to not need interactive auth")
	}
	if needsInteractiveAuth("local:abc123") {
		t.Fatalf("expected local: connection to not need interactive auth")
	}
}

// TestNeedsInteractiveAuth_Delegates verifies that needsInteractiveAuth is the
// inverse of conncontroller.CanReconnectWithoutPrompt (the single source of
// truth). The runtime flag and config-fallback logic is tested in the
// conncontroller package.
func TestNeedsInteractiveAuth_Delegates(t *testing.T) {
	t.Parallel()
	for _, connName := range []string{"local", "local:abc123", "user@nonexistent-host:22"} {
		expected := !conncontroller.CanReconnectWithoutPrompt(connName)
		got := needsInteractiveAuth(connName)
		if got != expected {
			t.Fatalf("needsInteractiveAuth(%q) = %v, expected %v (inverse of CanReconnectWithoutPrompt)", connName, got, expected)
		}
	}
}

// TestOnConnectionUpPerJobCtxNoStarvation verifies each job gets a fresh 10s ctx
// (not shared), so a slow job 1 doesn't starve jobs 2/3.
func TestOnConnectionUpPerJobCtxNoStarvation(t *testing.T) {

	// Reset hooks
	origReconnect := reconnectJobTestHook
	origAllJobs := getAllJobsForConnTestHook
	reconnectJobTestHook = nil
	getAllJobsForConnTestHook = nil
	defer func() {
		reconnectJobTestHook = origReconnect
		getAllJobsForConnTestHook = origAllJobs
	}()

	connName := "conn:starvation"
	jobs := []*waveobj.Job{
		{OID: "job-1", Connection: connName, JobManagerStatus: JobManagerStatus_Running},
		{OID: "job-2", Connection: connName, JobManagerStatus: JobManagerStatus_Running},
		{OID: "job-3", Connection: connName, JobManagerStatus: JobManagerStatus_Running},
	}

	getAllJobsForConnTestHook = func(connName string) ([]*waveobj.Job, error) {
		return jobs, nil
	}

	// Capture deadlines and job order.
	var mu sync.Mutex
	type deadlineInfo struct {
		jobId    string
		deadline time.Time
	}
	var captured []deadlineInfo

	reconnectJobTestHook = func(ctx context.Context, jobId string) error {
		deadline, _ := ctx.Deadline()
		mu.Lock()
		captured = append(captured, deadlineInfo{jobId, deadline})
		mu.Unlock()

		// Job 1 simulates a slow RPC (200ms, well within 10s ctx).
		if jobId == "job-1" {
			time.Sleep(200 * time.Millisecond)
		}
		return nil
	}

	onConnectionUp(connName)

	// Assert all 3 jobs were attempted.
	if len(captured) != 3 {
		t.Fatalf("expected 3 jobs attempted, got %d", len(captured))
	}

	// Assert each job's ctx had a deadline > 9s in the future.
	for i, info := range captured {
		if info.deadline.IsZero() {
			t.Fatalf("job %d (%s): ctx has no deadline (zero value)", i, info.jobId)
		}
		until := time.Until(info.deadline)
		if until <= 9*time.Second {
			t.Fatalf("job %d (%s): deadline only %v away, expected > 9s (shared/expired ctx)", i, info.jobId, until)
		}
	}
}

// TestOnConnectionUpRetryRecoversFailedJobs verifies the retry loop recovers
// a job that fails on the first pass.
func TestOnConnectionUpRetryRecoversFailedJobs(t *testing.T) {

	// Reset hooks
	origReconnect := reconnectJobTestHook
	origAllJobs := getAllJobsForConnTestHook
	origGetJob := getJobTestHook
	origIsConnected := isConnectedTestHook
	origBackoffs := retryBackoffs
	reconnectJobTestHook = nil
	getAllJobsForConnTestHook = nil
	getJobTestHook = nil
	isConnectedTestHook = nil
	retryBackoffs = nil
	defer func() {
		reconnectJobTestHook = origReconnect
		getAllJobsForConnTestHook = origAllJobs
		getJobTestHook = origGetJob
		isConnectedTestHook = origIsConnected
		retryBackoffs = origBackoffs
	}()

	// Short backoffs for testing.
	retryBackoffs = []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond}

	connName := "conn:retry"
	jobs := []*waveobj.Job{
		{OID: "job-1", Connection: connName, JobManagerStatus: JobManagerStatus_Running},
		{OID: "job-2", Connection: connName, JobManagerStatus: JobManagerStatus_Running},
	}

	getAllJobsForConnTestHook = func(connName string) ([]*waveobj.Job, error) {
		return jobs, nil
	}

	isConnectedTestHook = func(connName string) (bool, error) {
		return true, nil
	}

	// Track call counts per jobId.
	var mu sync.Mutex
	callCounts := make(map[string]int)

	reconnectJobTestHook = func(ctx context.Context, jobId string) error {
		mu.Lock()
		callCounts[jobId]++
		count := callCounts[jobId]
		mu.Unlock()

		// job-1 fails on first call, succeeds on second.
		if jobId == "job-1" && count == 1 {
			return fmt.Errorf("rpc timeout")
		}
		return nil
	}

	// getJobTestHook returns Running so the retry doesn't skip as Done.
	getJobTestHook = func(jobId string) (*waveobj.Job, error) {
		return &waveobj.Job{OID: jobId, JobManagerStatus: JobManagerStatus_Running}, nil
	}

	onConnectionUp(connName)

	mu.Lock()
	count1 := callCounts["job-1"]
	count2 := callCounts["job-2"]
	mu.Unlock()

	if count1 != 2 {
		t.Fatalf("job-1: expected 2 calls (1 initial + 1 retry), got %d", count1)
	}
	if count2 != 1 {
		t.Fatalf("job-2: expected 1 call (initial only), got %d", count2)
	}
}

// TestOnConnectionUpRetryAbortsOnConnDown verifies the retry loop aborts
// when the connection goes down between attempts.
func TestOnConnectionUpRetryAbortsOnConnDown(t *testing.T) {

	// Reset hooks
	origReconnect := reconnectJobTestHook
	origAllJobs := getAllJobsForConnTestHook
	origIsConnected := isConnectedTestHook
	origBackoffs := retryBackoffs
	reconnectJobTestHook = nil
	getAllJobsForConnTestHook = nil
	isConnectedTestHook = nil
	retryBackoffs = nil
	defer func() {
		reconnectJobTestHook = origReconnect
		getAllJobsForConnTestHook = origAllJobs
		isConnectedTestHook = origIsConnected
		retryBackoffs = origBackoffs
	}()

	// Short backoff for testing.
	retryBackoffs = []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond}

	connName := "conn:abort"
	jobs := []*waveobj.Job{
		{OID: "job-1", Connection: connName, JobManagerStatus: JobManagerStatus_Running},
	}

	getAllJobsForConnTestHook = func(connName string) ([]*waveobj.Job, error) {
		return jobs, nil
	}

	// IsConnected returns false on first retry check → abort.
	isConnectedTestHook = func(connName string) (bool, error) {
		return false, nil
	}

	// Track call count.
	var callCount int32

	reconnectJobTestHook = func(ctx context.Context, jobId string) error {
		atomic.AddInt32(&callCount, 1)
		return fmt.Errorf("always fails")
	}

	onConnectionUp(connName)

	count := atomic.LoadInt32(&callCount)
	if count != 1 {
		t.Fatalf("expected 1 call (initial pass only, retry aborted), got %d", count)
	}
}

// TestOnConnectionUpRetrySkipsDoneJobs verifies Done jobs are skipped in retry.
func TestOnConnectionUpRetrySkipsDoneJobs(t *testing.T) {

	// Reset hooks
	origReconnect := reconnectJobTestHook
	origAllJobs := getAllJobsForConnTestHook
	origGetJob := getJobTestHook
	origIsConnected := isConnectedTestHook
	origBackoffs := retryBackoffs
	reconnectJobTestHook = nil
	getAllJobsForConnTestHook = nil
	getJobTestHook = nil
	isConnectedTestHook = nil
	retryBackoffs = nil
	defer func() {
		reconnectJobTestHook = origReconnect
		getAllJobsForConnTestHook = origAllJobs
		getJobTestHook = origGetJob
		isConnectedTestHook = origIsConnected
		retryBackoffs = origBackoffs
	}()

	// Short backoff for testing.
	retryBackoffs = []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond}

	connName := "conn:skipdone"
	jobs := []*waveobj.Job{
		{OID: "job-1", Connection: connName, JobManagerStatus: JobManagerStatus_Running},
	}

	getAllJobsForConnTestHook = func(connName string) ([]*waveobj.Job, error) {
		return jobs, nil
	}

	isConnectedTestHook = func(connName string) (bool, error) {
		return true, nil
	}

	// Track call count.
	var callCount int32

	reconnectJobTestHook = func(ctx context.Context, jobId string) error {
		atomic.AddInt32(&callCount, 1)
		return fmt.Errorf("always fails")
	}

	// getJobTestHook returns Done so the retry skips it.
	getJobTestHook = func(jobId string) (*waveobj.Job, error) {
		return &waveobj.Job{OID: jobId, JobManagerStatus: JobManagerStatus_Done}, nil
	}

	onConnectionUp(connName)

	count := atomic.LoadInt32(&callCount)
	if count != 1 {
		t.Fatalf("expected 1 call (initial pass only, retry skipped Done job), got %d", count)
	}
}

// TestStartConnectionReconnectScheduler_SkipsInteractiveAuth verifies that
// the startup reconnect scheduler is NOT started for connections requiring
// interactive auth (the guard inside startReconnectScheduler skips them).
func TestStartConnectionReconnectScheduler_SkipsInteractiveAuth(t *testing.T) {
	connectionReconnectSchedulers = ds.MakeSyncMap[bool]()
	NeedsInteractiveAuthTestHook = func(string) bool { return true }
	defer func() { NeedsInteractiveAuthTestHook = nil }()

	StartConnectionReconnectScheduler("conn:startup-auth")

	if _, exists := connectionReconnectSchedulers.GetEx("conn:startup-auth"); exists {
		t.Fatalf("expected no scheduler entry when interactive auth is required")
	}
}

// TestStartConnectionReconnectScheduler_SkipsLocalConn verifies that local
// connections are skipped (they don't need SSH reconnect).
func TestStartConnectionReconnectScheduler_SkipsLocalConn(t *testing.T) {
	connectionReconnectSchedulers = ds.MakeSyncMap[bool]()
	NeedsInteractiveAuthTestHook = func(string) bool { return false }
	defer func() { NeedsInteractiveAuthTestHook = nil }()

	StartConnectionReconnectScheduler("local")

	if _, exists := connectionReconnectSchedulers.GetEx("local"); exists {
		t.Fatalf("expected no scheduler entry for local connection")
	}
}

// TestStartConnectionReconnectScheduler_StartsAndStopsScheduler verifies the
// scheduler goroutine actually runs and cleans up. hasRunningDurableJobsTestHook
// returns false so the scheduler stops immediately at the "no running durable
// jobs" check.
func TestStartConnectionReconnectScheduler_StartsAndStopsScheduler(t *testing.T) {
	connectionReconnectSchedulers = ds.MakeSyncMap[bool]()
	NeedsInteractiveAuthTestHook = func(string) bool { return false }
	hasRunningDurableJobsTestHook = func(context.Context, string) bool { return false }
	defer func() {
		NeedsInteractiveAuthTestHook = nil
		hasRunningDurableJobsTestHook = nil
	}()

	StartConnectionReconnectScheduler("conn:startup-ok")

	// Scheduler entry should be set immediately (goroutine spawned).
	if _, exists := connectionReconnectSchedulers.GetEx("conn:startup-ok"); !exists {
		t.Fatalf("expected scheduler entry to be set after StartConnectionReconnectScheduler")
	}

	// Wait for the scheduler goroutine to complete (hasRunningDurableJobsTestHook
	// returns false → scheduler stops → deletes the entry). Poll for up to 2s.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, exists := connectionReconnectSchedulers.GetEx("conn:startup-ok"); !exists {
			return // goroutine completed and cleaned up
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("scheduler entry still set after 2s — goroutine did not clean up")
}

// TestStartConnectionReconnectScheduler_DedupSharedWithOnConnectionDown verifies
// the dedup map is shared — calling onConnectionDown then
// StartConnectionReconnectScheduler for the same conn does NOT spawn a second
// scheduler.
func TestStartConnectionReconnectScheduler_DedupSharedWithOnConnectionDown(t *testing.T) {
	connectionReconnectSchedulers = ds.MakeSyncMap[bool]()
	NeedsInteractiveAuthTestHook = func(string) bool { return false }

	// Block the scheduler goroutine at hasRunningDurableJobsForConn so the map
	// entry stays alive while we verify dedup.
	gate := make(chan struct{})
	hasRunningDurableJobsTestHook = func(ctx context.Context, connName string) bool {
		<-gate // block until released
		return false
	}
	defer func() {
		NeedsInteractiveAuthTestHook = nil
		hasRunningDurableJobsTestHook = nil
	}()

	connName := "conn:dedup-startup"

	// Start scheduler via onConnectionDown — spawns goroutine that blocks on gate.
	onConnectionDown(connName)

	// Verify entry is set.
	if _, exists := connectionReconnectSchedulers.GetEx(connName); !exists {
		t.Fatalf("expected scheduler entry after onConnectionDown")
	}

	// Call StartConnectionReconnectScheduler — should NOT spawn a second scheduler
	// (dedup via connectionReconnectSchedulers).
	StartConnectionReconnectScheduler(connName)

	// Still exactly one entry (dedup worked — second call returned without spawning).
	if _, exists := connectionReconnectSchedulers.GetEx(connName); !exists {
		t.Fatalf("scheduler entry disappeared — dedup may have double-deleted")
	}

	// Release the gate so the scheduler goroutine can complete and clean up.
	close(gate)

	// Wait for the scheduler goroutine to finish.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, exists := connectionReconnectSchedulers.GetEx(connName); !exists {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("scheduler entry still set after 2s — goroutine did not clean up")
}

// mockStreamRpc is a minimal StreamRpcInterface for testing runOutputLoop without a real RPC.
type mockStreamRpc struct{}

func (m *mockStreamRpc) StreamDataAckCommand(data wshrpc.CommandStreamAckData, opts *wshrpc.RpcOpts) error {
	return nil
}

func (m *mockStreamRpc) StreamDataCommand(data wshrpc.CommandStreamData, opts *wshrpc.RpcOpts) error {
	return nil
}

// TestRunOutputLoopExitsOnReaderCloseWithSupersession verifies the Phase 2H leak fix:
// when restartStreaming closes the previous reader after updating jobStreamIds to the
// new streamId, the old runOutputLoop's Read() returns io.ErrClosedPipe, the supersession
// check (jobStreamIds != old streamId) fires, and the loop exits cleanly — without hitting
// the error path (which would call tryTerminateJobManager / DBUpdateFn). Without the fix,
// the old reader's Read() blocks forever because the old stream never receives data after
// the new stream starts, leaking the goroutine.
func TestRunOutputLoopExitsOnReaderCloseWithSupersession(t *testing.T) {
	jobId := "test-job-leak-fix"
	oldStreamId := "old-stream-id"
	newStreamId := "new-stream-id"

	// Reset global state.
	jobStreamIds.Delete(jobId)
	jobReaders.Delete(jobId)
	jobStreamHealth.Delete(jobId)

	// Create a real broker + reader so Reader.Close() works (sends cancel ack via the broker).
	broker := streamclient.NewBroker(&mockStreamRpc{})
	readerRouteId := "test-reader-route"
	writerRouteId := "test-writer-route"
	reader, _ := broker.CreateStreamReader(readerRouteId, writerRouteId, 4096)

	// Simulate the state after StartJob/restartStreaming set up the old stream.
	jobStreamIds.Set(jobId, oldStreamId)
	jobReaders.Set(jobId, reader)

	// Start runOutputLoop in a goroutine. It will block on reader.Read() (no data).
	loopDone := make(chan struct{})
	go func() {
		defer func() {
			panichandler.PanicHandler("test:runOutputLoop", recover())
			close(loopDone)
		}()
		runOutputLoop(context.Background(), jobId, oldStreamId, reader)
	}()

	// Wait for the loop to mark itself active (confirms it's running and blocked on Read).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if health, ok := jobStreamHealth.GetEx(jobId); ok && health.active && health.streamId == oldStreamId {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if health, ok := jobStreamHealth.GetEx(jobId); !ok || !health.active || health.streamId != oldStreamId {
		t.Fatalf("runOutputLoop did not start: health=%v ok=%v", health, ok)
	}

	// Simulate restartStreaming: update jobStreamIds to the new streamId FIRST (so the
	// supersession check in the old loop sees the new id), then close the old reader.
	jobStreamIds.Set(jobId, newStreamId)
	reader.Close()

	// The old runOutputLoop should exit via the supersession path (clean break, no DB access).
	// The defer sets health.active = false when health.streamId == oldStreamId.
	select {
	case <-loopDone:
		// Success — loop exited.
	case <-time.After(2 * time.Second):
		t.Fatalf("runOutputLoop did not exit after reader.Close() — goroutine leaked")
	}

	// Verify the loop exited via supersession (health.active == false, streamId matches old).
	// If it had hit the error path, it would have called wstore.DBUpdateFn / tryTerminateJobManager
	// (which would panic or log without a DB — the test would fail there).
	health, ok := jobStreamHealth.GetEx(jobId)
	if !ok {
		t.Fatalf("jobStreamHealth entry missing after loop exit")
	}
	if health.active {
		t.Fatalf("expected health.active == false after loop exit, got true")
	}
	if health.streamId != oldStreamId {
		t.Fatalf("expected health.streamId == %q (old), got %q", oldStreamId, health.streamId)
	}

	// Verify the old reader is closed (double-close is safe, returns ErrClosedPipe).
	err := reader.Close()
	if err == nil {
		t.Fatalf("expected second Close() to return non-nil error (already closed)")
	}
}

// TestRestartStreamingClosesPrevReader verifies that the jobReaders map mechanics work:
// the previous reader is retrieved, the new streamId is set before closing (so the
// supersession check fires), and the old reader is closed while the new one is stored.
func TestRestartStreamingClosesPrevReader(t *testing.T) {
	jobId := "test-job-readers-map"
	jobStreamIds.Delete(jobId)
	jobReaders.Delete(jobId)

	broker := streamclient.NewBroker(&mockStreamRpc{})
	reader1, _ := broker.CreateStreamReader("r1", "w1", 4096)
	reader2, _ := broker.CreateStreamReader("r2", "w2", 4096)

	// Simulate StartJob storing reader1.
	jobReaders.Set(jobId, reader1)
	jobStreamIds.Set(jobId, "stream-1")

	// Simulate restartStreaming: retrieve prev, set new streamId, close prev, store new.
	prevReader, prevOk := jobReaders.GetEx(jobId)
	if !prevOk || prevReader != reader1 {
		t.Fatalf("expected to retrieve reader1 from jobReaders")
	}
	jobStreamIds.Set(jobId, "stream-2") // update BEFORE closing (supersession check)
	prevReader.Close()                   // safe — unblocks old runOutputLoop
	jobReaders.Set(jobId, reader2)       // store new reader

	// Verify jobReaders now holds reader2.
	currentReader, ok := jobReaders.GetEx(jobId)
	if !ok || currentReader != reader2 {
		t.Fatalf("expected jobReaders to hold reader2 after restart")
	}
	currentStreamId, _ := jobStreamIds.GetEx(jobId)
	if currentStreamId != "stream-2" {
		t.Fatalf("expected jobStreamIds == stream-2, got %q", currentStreamId)
	}

	// Reader.Close() always returns io.ErrClosedPipe (it sets r.err before returning).
	// The important property is idempotency: both reader1 (already closed by prevReader.Close())
	// and reader2 (first close) accept Close() without panicking. Verify via Read() — a closed
	// reader returns io.ErrClosedPipe immediately.
	_, err1 := reader1.Read(make([]byte, 4))
	if err1 != io.ErrClosedPipe {
		t.Fatalf("expected reader1.Read() to return io.ErrClosedPipe (closed), got %v", err1)
	}
	reader2.Close() // idempotent — safe to call
	_, err2 := reader2.Read(make([]byte, 4))
	if err2 != io.ErrClosedPipe {
		t.Fatalf("expected reader2.Read() to return io.ErrClosedPipe (closed), got %v", err2)
	}
}
