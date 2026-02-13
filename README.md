# Overlap Tracer

[![CI](https://github.com/overlapcode/overlap-tracer/actions/workflows/ci.yml/badge.svg)](https://github.com/overlapcode/overlap-tracer/actions/workflows/ci.yml)
[![Release](https://github.com/overlapcode/overlap-tracer/actions/workflows/release.yml/badge.svg)](https://github.com/overlapcode/overlap-tracer/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/overlapdev.svg)](https://www.npmjs.com/package/overlapdev)
[![GitHub Release](https://img.shields.io/github/v/release/overlapcode/overlap-tracer)](https://github.com/overlapcode/overlap-tracer/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A lightweight background daemon that watches coding agent sessions (Claude Code, with more agents coming) and forwards activity signals to your team's [Overlap](https://overlap.dev) instance.

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

The tracer extracts **signals, not code**. File contents, assistant responses, and thinking blocks never leave your machine. See [Privacy](#privacy) for the full breakdown.

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
overlap status      # Show tracer status, teams, and tracked repos
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

3. **Events are extracted and batched** — session starts, file operations, prompts, and session ends are parsed from JSONL lines, batched (every 2s or 50 events), and sent to your team's Overlap instance via `POST /api/v1/ingest`.

4. **The daemon survives restarts** — byte offsets are persisted to `~/.overlap/state.json`. If the daemon crashes or your machine reboots, it picks up exactly where it left off. No data lost, no duplicates.

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

| Sent to your team's Overlap instance | Stays on your machine |
|--------------------------------------|----------------------|
| Session ID, timestamps | Assistant response text |
| Agent type, version | File contents |
| File paths (relative, stripped of home dir) | Tool outputs / results |
| Tool names (Write, Edit, Bash, etc.) | Thinking blocks |
| User prompts | Full absolute paths |
| Git branch name | API keys, env vars |
| Cost, tokens, duration | System environment variables |
| Model name | |
| Bash commands | |
| Hostname | |

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
