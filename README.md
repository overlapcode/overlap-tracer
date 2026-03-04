# Overlap Tracer

[![CI](https://github.com/overlapcode/overlap-tracer/actions/workflows/ci.yml/badge.svg)](https://github.com/overlapcode/overlap-tracer/actions/workflows/ci.yml)
[![Release](https://github.com/overlapcode/overlap-tracer/actions/workflows/release.yml/badge.svg)](https://github.com/overlapcode/overlap-tracer/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/overlapdev.svg)](https://www.npmjs.com/package/overlapdev)
[![GitHub Release](https://img.shields.io/github/v/release/overlapcode/overlap-tracer)](https://github.com/overlapcode/overlap-tracer/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The local agent for [Overlap](https://overlap.dev) — stop your coding agents from writing conflicting code. This lightweight daemon watches coding agent sessions (Claude Code, with more agents coming), detects overlapping work in real time, and blocks conflicts before they ship.

## What It Does

```
Developer uses Claude Code → writes JSONL session logs
                                        ↓
                              Overlap tracer watches files
                                        ↓
                              Parses signals (session lifecycle,
                              file ops, prompts, costs)
                                        ↓
                              Batches & sends to your team's
                              Overlap dashboard
```

The tracer extracts **signals, not code**. File contents and tool outputs never leave your machine. Session metadata, prompts, and assistant responses are sent to your self-hosted Overlap instance. See [Privacy](#privacy) for the full breakdown.

## Install

```bash
# Recommended — downloads the right binary for your OS
curl -fsSL https://overlap.dev/install.sh | sh
```

Or via npm:

```bash
npm install -g overlapdev
```

Or download the binary directly from [GitHub Releases](https://github.com/overlapcode/overlap-tracer/releases/latest).

### Supported Platforms

| Platform | Architecture | Binary |
|----------|-------------|--------|
| macOS | Apple Silicon (arm64) | `overlap-darwin-arm64` |
| macOS | Intel (x64) | `overlap-darwin-x64` |
| Linux | x64 | `overlap-linux-x64` |
| Linux | arm64 | `overlap-linux-arm64` |
| Windows | x64 | `overlap-windows-x64.exe` |

## Quick Start

```bash
# Join your team (your admin gives you the URL + token)
overlap join

# Check status
overlap status

# That's it — sessions are tracked automatically
```

## Commands

```bash
overlap join        # Join a team (prompts for instance URL + token)
overlap login       # Open dashboard in browser
overlap check       # Check for team overlaps (used by Claude Code hook)
overlap status      # Show tracer status, teams, and tracked repos
overlap update      # Update to the latest version
overlap backfill    # Re-sync all sessions (optionally for one team)
overlap leave       # Leave a team
overlap start       # Start the tracer daemon
overlap stop        # Stop the tracer daemon
overlap restart     # Restart the tracer daemon
overlap debug       # Print parsed events to stdout (no sending)
overlap uninstall   # Stop daemon, remove service, remove all config
overlap version     # Show version
```

## How It Works

1. **You run `overlap join`** — enter your team's Overlap instance URL and the token your admin gave you. The tracer verifies the token, fetches your team's repo list, starts the background daemon, and registers it as a startup service.

2. **The daemon watches `~/.claude/projects/`** for JSONL session files. When you start a Claude Code session in a repo that matches your team's registered repos, the tracer starts tailing the session file.

3. **Events are extracted, enriched, and batched** — session starts, file operations (with line ranges and function names), prompts, and session ends are parsed from JSONL lines, batched (every 2s or 100 events), and sent to your team's Overlap instance via `POST /api/v1/ingest`.

4. **The daemon polls for team state** — every 30 seconds, the daemon fetches active sessions from your team's instance and caches them locally at `~/.overlap/team-state.json`. This powers the real-time coordination hook.

5. **The daemon survives restarts** — byte offsets are persisted to `~/.overlap/state.json`. If the daemon crashes or your machine reboots, it picks up exactly where it left off. No data lost, no duplicates.

## Real-Time Coordination

When you run `overlap join` in a project directory, the tracer sets up Claude Code hooks and commands:

- **PreToolUse hook** — before Claude Code edits a file, `overlap check` reads the local team-state cache and warns if a teammate is working on the same region. The warning includes the teammate's name, a link to their session, and their session summary.
- **`/project:overlap-check`** — a slash command to manually check for overlaps at any point during a session.
- **`/project:overlap-context`** — loads what your team is currently working on as context for the session.

The hook is non-blocking: if overlap isn't installed or the cache is stale, it silently exits. Safe to commit `.claude/` to your repo — teammates without overlap installed are unaffected.

## Multi-Team Support

You can join multiple teams. The daemon matches sessions against all teams' repo lists and routes events accordingly.

```bash
overlap join   # Join first team
overlap join   # Join second team — daemon reloads automatically
overlap status # Shows both teams and their repos
```

## Agent Support

| Agent | Status | `agent_type` |
|-------|--------|-------------|
| Claude Code | Supported | `claude_code` |
| Codex CLI | Planned | `codex` |
| Gemini CLI | Planned | `gemini_cli` |

The tracer is built on an agent adapter system — each agent gets its own parser. Adding a new agent means implementing one interface, no changes to the server or existing code.

## Privacy

Overlap has three data zones:

### Stays on your machine

These are never sent anywhere — not to your instance, not to overlap.dev:

- File contents (source code, diffs, file bodies)
- Tool outputs / results
- Full absolute paths (paths are stripped to relative before sending)
- API keys, env vars, system environment variables

### Sent to your self-hosted instance

Sent to the Overlap dashboard you deployed on your own Cloudflare account:

- Session ID, timestamps, status
- Agent type, version, model name
- File paths (relative, home directory stripped)
- Tool names (Write, Edit, Bash, etc.)
- User prompts
- Assistant response text
- Thinking blocks
- Git branch name
- Cost, tokens, duration
- Bash commands
- Hostname

Your instance is under your control — you own the Cloudflare account, the D1 database, and the encryption keys.

### Anonymous telemetry to overlap.dev

On startup and periodically, lightweight pings are sent to `overlap.dev` for version checks and anonymous usage stats:

| Data | Purpose |
|------|---------|
| Hashed instance URL | Anonymous instance counting |
| Hashed user token | Anonymous user counting |
| Tracer/dashboard version | Update notifications |
| OS, architecture | Platform analytics |
| User count, repo count | Aggregate usage (heartbeat only) |
| Overlap/warn/block counts | Feature adoption (heartbeat only) |

No session content, file paths, prompts, or response text is sent to overlap.dev. All identifiers are SHA-256 hashed and truncated. To opt out, block `overlap.dev` at the network level.

## Configuration

All tracer data lives in `~/.overlap/`:

```
~/.overlap/
├── config.json     # Teams, tokens, tracer settings
├── state.json      # Byte offsets per session file
├── cache.json      # Cached repo lists + git remote lookups
├── logs/
│   ├── tracer.log
│   └── tracer.error.log
└── tracer.pid      # PID of running daemon
```

## Building from Source

```bash
# Install dependencies
bun install

# Run in dev mode
bun run dev

# Run tests
bun test

# Build binaries for all platforms
bash scripts/build-all.sh
```

## License

MIT
