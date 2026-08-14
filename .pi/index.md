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

- **Branch:** `odds-and-ends` (reconnection UX P0/P1/P2 already merged into `main`/`odds-and-ends`)
- **Next:** run the UX-3.2 QA matrix (Q1–Q17) to sign off reconnection as production-ready; reconcile `reconnection.md` "current behavior"
- **Todos:** [[todos.md]] — see the 2026-08-14 status note at top

## Context & Decisions

- [[context.md]] — Full project background and goals
- [[decisions.md]] — Architecture decisions (ADRs)

## Tasks

- [[todos.md]] — Active work and backlog
