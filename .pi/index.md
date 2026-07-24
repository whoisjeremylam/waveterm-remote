# waveterm-remote Fork

A fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) optimized for **remote development workflows**.

## Upstream

- Original: `https://github.com/wavetermdev/waveterm`
- This fork: `https://github.com/whoisjeremylam/waveterm-remote`
- CWD origin points to this fork

## Purpose

Most developer terminals assume code is installed, built, and tested locally. This fork targets developers who primarily work on remote machines via SSH — with the local machine as a thin client.

## Active Specs

- [[specs/reconnection-ux-backlog.md]] — **P0 done on `feat/reconnect-ux-p0`**; P1 clarity next after merge
- [[specs/reconnection.md]] — Implementation log (phases through password-cache / suppress hardening)
- [[specs/newtab-connect-dropdown.md]] — **Implemented on same branch**; frecency + typeahead
- [[specs/portforwarding.md]] — SSH port forwarding (`LocalForward` / `RemoteForward`) — landed earlier
- [[specs/tmux-cwd-tracking.md]] — CWD tracking under tmux/screen via `wsh setmeta`
- [[specs/widget-keepalive.md]] — Widget state persistence across toggle
- [[specs/remove-telemetry.md]] / [[specs/remove-waveai.md]] — earlier fork goals

## Current branch / handoff

- **Branch:** `feat/reconnect-ux-p0` (worktree `../waveterm-remote-reconnect-ux-p0`)
- **Next:** finish user retest → push → PR → merge → then P1 from reconnection UX backlog
- **Todos:** [[todos.md]] — see **Current focus (2026-07-24)** at top

## Context & Decisions

- [[context.md]] — Full project background and goals
- [[decisions.md]] — Architecture decisions (ADRs)

## Tasks

- [[todos.md]] — Active work and backlog
