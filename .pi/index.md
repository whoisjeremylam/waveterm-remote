# waveterm-remote Fork

A fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) optimized for **remote development workflows**.

## Upstream

- Original: `https://github.com/wavetermdev/waveterm`
- This fork: `https://github.com/whoisjeremylam/waveterm-remote`
- CWD origin points to this fork

## Purpose

Most developer terminals assume code is installed, built, and tested locally. This fork targets developers who primarily work on remote machines via SSH — with the local machine as a thin client.

## Active Specs

- [[specs/reconnection-ux-backlog.md]] — **P0 + P1 + most of P2 merged**; remaining is UX-3.2 QA matrix + spec hygiene
- [[specs/reconnection.md]] — Implementation log (through stale hung-dial soft-cancel / password-cache hardening)
- [[specs/newtab-connect-dropdown.md]] — Implemented; ≥2-char auto-select; block-header is filter-free switcher
- [[specs/portforwarding.md]] — SSH port forwarding (`LocalForward` / `RemoteForward`) — landed earlier
- [[specs/tmux-cwd-tracking.md]] — CWD tracking under tmux/screen via `wsh setmeta`
- [[specs/widget-keepalive.md]] — Widget state persistence across toggle
- [[specs/remove-telemetry.md]] / [[specs/remove-waveai.md]] — earlier fork goals

## Current branch / handoff

- **Branch:** `feat/files-widget` (worktree; merged with `origin/odds-and-ends`)
- **In progress:** stream-freeze A1 (ACK retry/coalesce) + B2 (lock-free recv-loop metadata) — [[decisions.md#2026-08-22-stream-freeze--a1-ack-retry--b2-lock-free-recv-metadata]]
- **⚠️ ACTION (Jeremy):** run the reconnection UX-3.2 QA matrix (Q1–Q17) — manual tests, see [[specs/reconnection-p1-p2-verification.md]]
- **Todos:** [[todos.md]]

## Context & Decisions

- [[context.md]] — Full project background and goals
- [[decisions.md]] — Architecture decisions (ADRs)

## Tasks

- [[todos.md]] — Active work and backlog
