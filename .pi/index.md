# waveterm-remote Fork

A fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) optimized for **remote development workflows**.

## Upstream

- Original: `https://github.com/wavetermdev/waveterm`
- This fork: `https://github.com/whoisjeremylam/waveterm-remote`
- CWD origin points to this fork

## Purpose

Most developer terminals assume code is installed, built, and tested locally. This fork targets developers who primarily work on remote machines via SSH — with the local machine as a thin client.

## Active Specs

- [[specs/wsh-agent-api.md]] — **"Agent Control Fabric"** — design converged; phased implementation (worktree `waveterm-remote-agent-fabric`, branch `feat/agent-control-fabric`)
- [[specs/reconnection-ux-backlog.md]] — **P0 + P1 + most of P2 merged**; remaining is UX-3.2 QA matrix + spec hygiene
- [[specs/reconnection.md]] — Implementation log (through stale hung-dial soft-cancel / password-cache hardening)
- [[specs/newtab-connect-dropdown.md]] — Implemented; ≥2-char auto-select; block-header is filter-free switcher
- [[specs/portforwarding.md]] — SSH port forwarding (`LocalForward` / `RemoteForward`) — landed earlier
- [[specs/tmux-cwd-tracking.md]] — CWD tracking under tmux/screen via `wsh setmeta`
- [[specs/widget-keepalive.md]] — Widget state persistence across toggle
- [[specs/remove-telemetry.md]] / [[specs/remove-waveai.md]] — earlier fork goals

## Current branch / handoff

- **Branch:** `odds-and-ends` (reconnection UX P0/P1/P2 already merged into `main`/`odds-and-ends`)
- **⚠️ ACTION (Jeremy):** run the reconnection UX-3.2 QA matrix (Q1–Q17) — manual tests, see [[specs/reconnection-p1-p2-verification.md]] for steps/expected results and [[todos.md]] for the recommended order
- **Next (agent):** wsh Agent API ("agent control fabric") — see [[specs/wsh-agent-api.md]]; developed in worktree `waveterm-remote-agent-fabric` on branch `feat/agent-control-fabric` (branched off `odds-and-ends`, which will merge first)
- **Todos:** [[todos.md]] — see the "Open action — manual QA" section at top

## Context & Decisions

- [[context.md]] — Full project background and goals
- [[decisions.md]] — Architecture decisions (ADRs)

## Tasks

- [[todos.md]] — Active work and backlog
