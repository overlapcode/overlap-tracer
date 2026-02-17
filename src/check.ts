/**
 * overlap check — PreToolUse hook handler + CLI overlap detection.
 *
 * Two modes:
 *   1. Hook mode (no flags): reads JSON from stdin (Claude Code hook protocol),
 *      outputs hookSpecificOutput JSON to stdout.
 *   2. CLI mode (--json, --repo, --file, --all): called by skills or manually,
 *      outputs structured JSON to stdout.
 *
 * Exits silently (exit 0) when:
 *   - No config / no teams configured
 *   - Not in a git repo (global hook firing in non-git dir)
 *   - No team-state.json (daemon not running) — in hook mode
 *   - No overlaps found
 */

import { readFileSync, existsSync } from "fs";
import { basename, resolve, relative } from "path";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { readTeamState, TEAM_STATE_PATH } from "./team-state";
import { loadConfig } from "./config";
import { findEnclosingFunction } from "./enrichment";
import type { TeamState, TeamStateSession } from "./types";

// ── Types ────────────────────────────────────────────────────────────────

type HookInput = {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    notebook_path?: string;
    command?: string;
  };
};

type CheckFlags = {
  json: boolean;
  repo: string | null;
  file: string | null;
  all: boolean;
};

type GitInfo = {
  repoName: string;
  gitHost: "github" | "gitlab" | null;
  remoteUrl: string;
  gitRoot: string;
};

type OverlapMatch = {
  display_name: string;
  session_id: string;
  repo_name: string;
  started_at: string;
  summary: string | null;
  file_path: string;
  start_line: number | null;
  end_line: number | null;
  function_name: string | null;
  tier: "line" | "function" | "adjacent" | "file";
  session_url: string;
};

// ── Main ─────────────────────────────────────────────────────────────────

export async function cmdCheck(): Promise<void> {
  // Parse CLI args
  const args = process.argv.slice(3); // after "overlap check"
  const flags = parseCheckArgs(args);

  // Early bail: no config = no teams = nothing to check
  const configPath = join(homedir(), ".overlap", "config.json");
  if (!existsSync(configPath)) {
    if (flags.json) outputJson({ overlaps: [], team_sessions: [] });
    process.exit(0);
  }
  const config = loadConfig();
  if (config.teams.length === 0) {
    if (flags.json) outputJson({ overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Determine mode: stdin (hook) or CLI args (skill)
  let input: HookInput | null = null;

  if (!flags.file && !flags.repo && !flags.all) {
    // Hook mode: read from stdin
    try {
      const raw = readFileSync(0, "utf-8"); // fd 0 = stdin
      input = JSON.parse(raw);
    } catch {
      // No stdin or invalid JSON — not a hook invocation, bail silently
      process.exit(0);
    }
  }

  // Resolve parameters
  const cwd = input?.cwd || process.cwd();
  const gitInfo = getGitInfo(cwd);
  const repoName = flags.repo || gitInfo?.repoName || null;

  // Not in a git repo and no --repo flag — global hook in non-git dir
  if (!repoName && !flags.all) {
    if (flags.json) outputJson({ overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Read team state cache
  const state = readTeamState();
  if (!state) {
    if (!existsSync(TEAM_STATE_PATH)) {
      // File doesn't exist — daemon likely not running
      if (flags.json) {
        outputJson({
          overlaps: [],
          team_sessions: [],
          warning: "team-state.json not found. Is the overlap daemon running?",
        });
      }
      // Hook mode: silent, don't block the user
    } else {
      // File exists but is stale (>2 min old)
      if (flags.json) {
        outputJson({
          overlaps: [],
          team_sessions: [],
          warning: "Team state is stale (>2 min). The daemon may have stopped.",
        });
      }
    }
    process.exit(0);
  }
  if (state.sessions.length === 0) {
    if (flags.json) outputJson({ overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Exclude own sessions
  const currentUserIds = new Set(config.teams.map((t) => t.user_id));

  // --all mode: return all teammate sessions (for overlap-context skill)
  if (flags.all) {
    outputAllSessions(state, currentUserIds, flags.json);
    process.exit(0);
  }

  // Extract file path
  const filePath =
    flags.file ||
    input?.tool_input?.file_path ||
    input?.tool_input?.notebook_path ||
    null;

  if (!filePath) {
    if (flags.json) outputJson({ overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Normalize file path to git-root-relative
  const gitRoot = gitInfo?.gitRoot || cwd;
  const absFilePath = resolve(cwd, filePath);
  const relPath = relative(gitRoot, absFilePath);

  // File is outside the repo — nothing to check
  if (relPath.startsWith("..")) {
    if (flags.json) outputJson({ overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Resolve target line range + function from old_string (for Edit tool)
  let targetStartLine: number | null = null;
  let targetEndLine: number | null = null;
  let targetFunctionName: string | null = null;

  if (input?.tool_input?.old_string && filePath) {
    try {
      const content = readFileSync(absFilePath, "utf-8");
      const idx = content.indexOf(input.tool_input.old_string);
      if (idx !== -1) {
        const before = content.substring(0, idx);
        targetStartLine = before.split("\n").length;
        targetEndLine =
          targetStartLine +
          input.tool_input.old_string.split("\n").length -
          1;

        // Resolve enclosing function for the target edit
        const lines = content.split("\n");
        targetFunctionName =
          findEnclosingFunction(lines, targetStartLine - 1) || null;
      }
    } catch {
      // File not readable — proceed without line data
    }
  }

  // Find overlaps
  const matches: OverlapMatch[] = [];

  for (const session of state.sessions) {
    // Skip self
    if (currentUserIds.has(session.user_id)) continue;
    // Skip other repos
    if (session.repo_name !== repoName) continue;

    for (const region of session.regions) {
      if (region.file_path !== relPath) continue;

      // Determine overlap tier
      let tier: OverlapMatch["tier"] = "file";

      if (
        targetStartLine != null &&
        targetEndLine != null &&
        region.start_line != null &&
        region.end_line != null
      ) {
        // Check line overlap
        if (
          targetStartLine <= region.end_line &&
          targetEndLine >= region.start_line
        ) {
          tier = "line";
        } else {
          // Check adjacency (within 30 lines)
          const gap = Math.min(
            Math.abs(targetStartLine - region.end_line),
            Math.abs(targetEndLine - region.start_line),
          );
          if (gap <= 30) {
            tier = "adjacent";
          }
        }
      }

      // Function tier: both sides have function names and they match
      if (tier === "file" && region.function_name && targetFunctionName) {
        if (region.function_name === targetFunctionName) {
          tier = "function";
        }
      }

      const sessionUrl =
        session.instance_url || state.instance_url || "";

      matches.push({
        display_name: session.display_name,
        session_id: session.session_id,
        repo_name: session.repo_name,
        started_at: session.started_at,
        summary: session.summary,
        file_path: region.file_path,
        start_line: region.start_line,
        end_line: region.end_line,
        function_name: region.function_name,
        tier,
        session_url: sessionUrl
          ? `${sessionUrl}/session/${session.session_id}`
          : "",
      });
    }
  }

  if (matches.length === 0) {
    if (flags.json) outputJson({ overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Sort: line > function > adjacent > file
  const tierOrder = { line: 0, function: 1, adjacent: 2, file: 3 };
  matches.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  // Output
  if (flags.json) {
    outputJson({
      overlaps: matches,
      git_host: gitInfo?.gitHost || null,
    });
    process.exit(0);
  }

  // Hook mode: hookSpecificOutput for Claude Code
  outputHookFormat(matches, relPath, gitInfo);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function parseCheckArgs(args: string[]): CheckFlags {
  const flags: CheckFlags = { json: false, repo: null, file: null, all: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--json":
        flags.json = true;
        break;
      case "--repo":
        flags.repo = args[++i] || null;
        break;
      case "--file":
        flags.file = args[++i] || null;
        break;
      case "--all":
        flags.all = true;
        break;
    }
  }
  return flags;
}

/**
 * Single git call to get repo name, host, remote URL, and root.
 * Returns null if not in a git repo.
 */
function getGitInfo(cwd: string): GitInfo | null {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();

    // Get remote URL (single call, may not exist)
    let remoteUrl = "";
    try {
      remoteUrl = execSync("git remote get-url origin", {
        cwd,
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();
    } catch {
      // No remote — still a valid git repo
    }

    // Extract repo name from remote URL
    let repoName: string | null = null;
    if (remoteUrl) {
      const match = remoteUrl.match(/[/:]([^/:]+?)(?:\.git)?$/);
      if (match) repoName = match[1];
    }
    // Fallback: use git root directory name (NOT arbitrary cwd basename)
    if (!repoName) {
      repoName = basename(gitRoot);
    }

    // Detect host
    let gitHost: "github" | "gitlab" | null = null;
    if (remoteUrl.includes("github.com")) gitHost = "github";
    else if (remoteUrl.includes("gitlab")) gitHost = "gitlab";

    return { repoName, gitHost, remoteUrl, gitRoot };
  } catch {
    // Not a git repo
    return null;
  }
}

function outputJson(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data));
}

function outputAllSessions(
  state: TeamState,
  currentUserIds: Set<string>,
  jsonMode: boolean,
): void {
  const sessions = state.sessions.filter(
    (s) => !currentUserIds.has(s.user_id),
  );

  if (jsonMode) {
    outputJson({
      overlaps: [],
      team_sessions: sessions.map((s) => ({
        display_name: s.display_name,
        session_id: s.session_id,
        repo_name: s.repo_name,
        started_at: s.started_at,
        summary: s.summary,
        session_url: `${s.instance_url || state.instance_url}/session/${s.session_id}`,
        regions: s.regions,
      })),
    });
  } else {
    // Human-readable fallback
    if (sessions.length === 0) {
      console.log("No active teammate sessions.");
    } else {
      for (const s of sessions) {
        const ago = formatAgo(s.started_at);
        console.log(`${s.display_name} — ${s.repo_name} (${ago})`);
        if (s.summary) console.log(`  ${s.summary}`);
        for (const r of s.regions) {
          const fn = r.function_name ? ` → ${r.function_name}()` : "";
          console.log(`  ${r.file_path}${fn}`);
        }
        console.log();
      }
    }
  }
}

function outputHookFormat(
  matches: OverlapMatch[],
  relPath: string,
  gitInfo: GitInfo | null,
): void {
  const lines: string[] = [];

  for (const m of matches) {
    const ago = formatAgo(m.started_at);
    const regionDesc = m.function_name
      ? `${m.function_name}() (lines ${m.start_line}-${m.end_line})`
      : m.start_line
        ? `lines ${m.start_line}-${m.end_line}`
        : "this file";

    lines.push(`OVERLAP WARNING: ${m.file_path}`);
    lines.push("");
    lines.push(`${m.display_name} is actively editing ${regionDesc}.`);
    lines.push(`Session started ${ago}.`);
    if (m.session_url) {
      lines.push(`Session: ${m.session_url}`);
    }
    if (m.summary) {
      lines.push(`Session summary: "${m.summary}"`);
    }
    lines.push("");
  }

  // Recommendation
  const hasHardOverlap = matches.some(
    (m) => m.tier === "line" || m.tier === "function",
  );
  if (hasHardOverlap) {
    lines.push(
      "Recommendation: Review the other session before modifying this region. If the work conflicts, coordinate with the other developer.",
    );
  } else {
    lines.push(
      "Note: Another developer is working in the same file. Proceed with awareness.",
    );
  }

  // PR check suggestion
  if (gitInfo?.gitHost === "github") {
    lines.push("");
    lines.push("Also check for existing PRs that may cover this work:");
    lines.push(`  gh pr list --search "${relPath}" --state open --limit 5`);
  } else if (gitInfo?.gitHost === "gitlab") {
    lines.push("");
    lines.push("Also check for existing MRs that may cover this work:");
    lines.push(`  glab mr list --search "${relPath}" --state opened`);
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: lines.join("\n"),
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ${min % 60}m ago`;
}
