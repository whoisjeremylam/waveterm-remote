// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package remote

import (
	"net"
	"testing"
	"time"
)

// TestHandshakeDeadlineExtenderRegistry covers the store/lookup/delete plumbing
// behind ExtendActiveHandshakeDeadline. Uses distinct conn names so the shared
// sync.Map is safe under parallel subtests.
func TestHandshakeDeadlineExtenderRegistry(t *testing.T) {
	t.Run("no-op for empty conn name", func(t *testing.T) {
		// Must not panic and must not invoke anything.
		ExtendActiveHandshakeDeadline("", time.Second)
	})

	t.Run("no-op when not registered", func(t *testing.T) {
		ExtendActiveHandshakeDeadline("deadline-test-unregistered", time.Second)
	})

	t.Run("invokes registered extender with duration", func(t *testing.T) {
		var called bool
		var got time.Duration
		unregister := registerHandshakeExtender("deadline-test-a", func(d time.Duration) {
			called = true
			got = d
		})
		defer unregister()

		ExtendActiveHandshakeDeadline("deadline-test-a", 42*time.Second)
		if !called {
			t.Fatal("expected registered extender to be invoked")
		}
		if got != 42*time.Second {
			t.Fatalf("expected 42s, got %v", got)
		}
	})

	t.Run("unregister removes extender", func(t *testing.T) {
		var called bool
		unregister := registerHandshakeExtender("deadline-test-b", func(time.Duration) {
			called = true
		})
		unregister()

		ExtendActiveHandshakeDeadline("deadline-test-b", time.Second)
		if called {
			t.Fatal("expected no invocation after unregister")
		}
	})

	t.Run("register with empty name is a no-op unregister", func(t *testing.T) {
		unregister := registerHandshakeExtender("", func(time.Duration) {
			t.Fatal("extender for empty conn name must never be invoked")
		})
		unregister() // must not panic
		ExtendActiveHandshakeDeadline("", time.Second)
	})
}

// recordingConn is a minimal net.Conn that records SetDeadline calls. It embeds
// the net.Conn interface so the unimplemented methods are satisfied (and would
// panic only if called, which this test does not do).
type recordingConn struct {
	net.Conn
	deadlines []time.Time
}

func (c *recordingConn) SetDeadline(t time.Time) error {
	c.deadlines = append(c.deadlines, t)
	return nil
}

func TestNewConnDeadlineExtender(t *testing.T) {
	t.Parallel()

	conn := &recordingConn{}
	before := time.Now()
	ext := newConnDeadlineExtender(conn)
	ext(60 * time.Second)
	after := time.Now()

	if len(conn.deadlines) != 1 {
		t.Fatalf("expected exactly 1 SetDeadline call, got %d", len(conn.deadlines))
	}
	got := conn.deadlines[0]
	// The extender records time.Now()+60s, where time.Now() is between before and after.
	if got.Before(before.Add(60*time.Second)) || got.After(after.Add(60*time.Second)) {
		t.Fatalf("deadline %v outside expected window [%v, %v]", got, before.Add(60*time.Second), after.Add(60*time.Second))
	}
}

func TestNewTimerDeadlineExtender(t *testing.T) {
	t.Run("reset extends an active timer", func(t *testing.T) {
		timer := time.NewTimer(150 * time.Millisecond)
		defer timer.Stop()

		ext := newTimerDeadlineExtender(timer)
		ext(400 * time.Millisecond)

		// At 250ms the original 150ms would have fired; the reset should keep it pending.
		select {
		case <-timer.C:
			t.Fatal("timer fired before the extended deadline (Reset did not take effect)")
		case <-time.After(250 * time.Millisecond):
		}

		// It should fire within the extended 400ms budget.
		select {
		case <-timer.C:
		case <-time.After(300 * time.Millisecond):
			t.Fatal("timer did not fire within the extended deadline")
		}
	})

	t.Run("reset works after the timer already fired", func(t *testing.T) {
		timer := time.NewTimer(20 * time.Millisecond)
		defer timer.Stop()
		<-timer.C // let it fire so the Stop/drain path is exercised

		ext := newTimerDeadlineExtender(timer)
		ext(150 * time.Millisecond)

		select {
		case <-timer.C:
		case <-time.After(250 * time.Millisecond):
			t.Fatal("timer did not re-fire after reset-on-expired-timer")
		}
	})
}
