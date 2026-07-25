# waveterm-remote Fork

A fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) optimized for **remote development workflows**.

## Upstream

- Original: `https://github.com/wavetermdev/waveterm`
- This fork: `https://github.com/whoisjeremylam/waveterm-remote`
- CWD origin points to this fork

## Purpose

Most developer terminals assume code is installed, built, and tested locally. This fork targets developers who primarily work on remote machines via SSH — with the local machine as a thin client.

## Active Specs

- [[specs/reconnection-ux-backlog.md]] — **P0 code + user retest done on `feat/reconnect-ux-p0`**; ready to merge; P1 clarity next
- [[specs/reconnection.md]] — Implementation log (through stale hung-dial soft-cancel / password-cache hardening)
- [[specs/newtab-connect-dropdown.md]] — Implemented; ≥2-char auto-select; block-header is filter-free switcher
- [[specs/portforwarding.md]] — SSH port forwarding (`LocalForward` / `RemoteForward`) — landed earlier
- [[specs/tmux-cwd-tracking.md]] — CWD tracking under tmux/screen via `wsh setmeta`
- [[specs/widget-keepalive.md]] — Widget state persistence across toggle
- [[specs/remove-telemetry.md]] / [[specs/remove-waveai.md]] — earlier fork goals

## Current branch / handoff

- **Branch:** `feat/reconnect-ux-p0` (worktree `../waveterm-remote-reconnect-ux-p0`)
- **Next:** push → PR → merge to `main` → then P1 from reconnection UX backlog
- **Todos:** [[todos.md]] — see **Current focus** at top (P0 retest matrix complete)

## Context & Decisions

- [[context.md]] — Full project background and goals
- [[decisions.md]] — Architecture decisions (ADRs)

## Tasks

- [[todos.md]] — Active work and backlog
