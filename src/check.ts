/**
 * overlap check — PreToolUse hook handler + CLI overlap detection.
 *
 * Two modes:
 *   1. Hook mode (no flags): reads JSON from stdin (Claude Code hook protocol),
 *      outputs hookSpecificOutput JSON to stdout.
 *   2. CLI mode (--json, --repo, --file, --all, --old-string, --strict, --context):
 *      called by skills or manually,
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
import type { TeamConfig, TeamState, TeamStateSession } from "./types";

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
  oldString: string | null;
  strict: boolean;
  context: boolean;
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
  git_branch: string | null;
  is_pushed: boolean;
  latest_edit: {
    old_string: string | null;
    new_string: string | null;
    timestamp: string;
  } | null;
};

type OverlapDecision = "proceed" | "warn" | "block";

// ── Main ─────────────────────────────────────────────────────────────────

export async function cmdCheck(): Promise<void> {
  // Parse CLI args
  const args = process.argv.slice(3); // after "overlap check"
  const flags = parseCheckArgs(args);
  const isHookMode = args.length === 0;

  // Early bail: no config = no teams = nothing to check
  const configPath = join(homedir(), ".overlap", "config.json");
  if (!existsSync(configPath)) {
    if (flags.json) outputJson({ decision: "proceed", overlaps: [], team_sessions: [] });
    process.exit(0);
  }
  const config = loadConfig();
  if (config.teams.length === 0) {
    if (flags.json) outputJson({ decision: "proceed", overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Determine mode: stdin (hook) or CLI args (skill)
  let input: HookInput | null = null;

  if (isHookMode) {
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
    if (flags.json) outputJson({ decision: "proceed", overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  const currentUserIds = new Set(config.teams.map((t) => t.user_id));

  // --all mode: return all teammate sessions (for overlap-context skill)
  if (flags.all) {
    const state = readTeamState();
    if (!state || state.sessions.length === 0) {
      if (flags.json) outputJson({ decision: "proceed", overlaps: [], team_sessions: [] });
      process.exit(0);
    }
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
    if (flags.json) outputJson({ decision: "proceed", overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Normalize file path to git-root-relative
  const gitRoot = gitInfo?.gitRoot || cwd;
  const absFilePath = resolve(cwd, filePath);
  const relPath = relative(gitRoot, absFilePath);

  // File is outside the repo — nothing to check
  if (relPath.startsWith("..")) {
    if (flags.json) outputJson({ decision: "proceed", overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Resolve target line range + function from old_string (for Edit tool)
  let targetStartLine: number | null = null;
  let targetEndLine: number | null = null;
  let targetFunctionName: string | null = null;
  const oldString = flags.oldString || input?.tool_input?.old_string || null;

  if (oldString && filePath) {
    try {
      const content = readFileSync(absFilePath, "utf-8");
      const idx = content.indexOf(oldString);
      if (idx !== -1) {
        const before = content.substring(0, idx);
        targetStartLine = before.split("\n").length;
        targetEndLine =
          targetStartLine +
          oldString.split("\n").length -
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

  // ── Server query (real-time, 2s timeout) ────────────────────────────
  const sessionId = input?.session_id || "cli";
  const serverResult = await tryServerOverlapQuery(
    config.teams,
    repoName!,
    relPath,
    sessionId,
    targetStartLine,
    targetEndLine,
    targetFunctionName,
  );

  if (serverResult) {
    outputMatchResult(
      serverResult.decision,
      serverResult.overlaps,
      relPath,
      gitInfo,
      isHookMode,
      flags,
      null,
      undefined,
      null,
      serverResult.guidance,
    );
    return;
  }

  // ── Fallback: local team-state cache ────────────────────────────────
  const state = readTeamState();
  if (!state) {
    if (!existsSync(TEAM_STATE_PATH)) {
      if (flags.json) {
        outputJson({
          decision: "proceed",
          overlaps: [],
          team_sessions: [],
          warning: "Server unreachable and team-state.json not found. Is the overlap daemon running?",
        });
      }
    } else {
      if (flags.json) {
        outputJson({
          decision: "proceed",
          overlaps: [],
          team_sessions: [],
          warning: "Server unreachable and team state is stale (>2 min). The daemon may have stopped.",
        });
      }
    }
    process.exit(0);
  }
  if (state.sessions.length === 0) {
    if (flags.json) outputJson({ decision: "proceed", overlaps: [], team_sessions: [] });
    process.exit(0);
  }

  // Find overlaps from cache
  const matches: OverlapMatch[] = [];

  for (const session of state.sessions) {
    if (currentUserIds.has(session.user_id)) continue;
    if (session.repo_name !== repoName) continue;

    for (const region of session.regions) {
      if (region.file_path !== relPath) continue;

      let tier: OverlapMatch["tier"] = "file";

      if (
        targetStartLine != null &&
        targetEndLine != null &&
        region.start_line != null &&
        region.end_line != null
      ) {
        if (
          targetStartLine <= region.end_line &&
          targetEndLine >= region.start_line
        ) {
          tier = "line";
        } else {
          const gap = Math.min(
            Math.abs(targetStartLine - region.end_line),
            Math.abs(targetEndLine - region.start_line),
          );
          if (gap <= 30) {
            tier = "adjacent";
          }
        }
      }

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
        git_branch: null,
        is_pushed: false,
        latest_edit: null,
      });
    }
  }

  if (matches.length === 0) {
    if (flags.json) {
      outputJson({
        decision: "proceed",
        overlaps: [],
        team_sessions: flags.context
          ? buildTeamSessions(state, currentUserIds, repoName)
          : [],
        git_host: gitInfo?.gitHost || null,
      });
    }
    process.exit(0);
  }

  const tierOrder = { line: 0, function: 1, adjacent: 2, file: 3 };
  matches.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
  const hasHardOverlap = matches.some(
    (m) => m.tier === "line" || m.tier === "function",
  );
  const decision: OverlapDecision = hasHardOverlap ? "block" : "warn";

  outputMatchResult(decision, matches, relPath, gitInfo, isHookMode, flags, state, currentUserIds, repoName);
}

// ── Server Query ────────────────────────────────────────────────────────

type ServerOverlap = {
  display_name: string;
  session_id: string;
  repo_name: string;
  started_at: string;
  summary: string | null;
  file_path: string;
  start_line: number | null;
  end_line: number | null;
  function_name: string | null;
  tier: OverlapMatch["tier"];
  last_touched_at: string;
  git_branch: string | null;
  is_pushed: boolean;
  latest_edit: {
    old_string: string | null;
    new_string: string | null;
    timestamp: string;
  } | null;
};

/**
 * Query all configured team instances for real-time overlap data.
 * Returns null if ALL instances are unreachable (triggers cache fallback).
 */
async function tryServerOverlapQuery(
  teams: TeamConfig[],
  repoName: string,
  filePath: string,
  sessionId: string,
  startLine: number | null,
  endLine: number | null,
  functionName: string | null,
): Promise<{ decision: OverlapDecision; overlaps: OverlapMatch[]; guidance: string | null } | null> {
  const allOverlaps: OverlapMatch[] = [];
  let anySuccess = false;
  let serverGuidance: string | null = null;

  for (const team of teams) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${team.instance_url}/api/v1/overlap-query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${team.user_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo_name: repoName,
          file_path: filePath,
          session_id: sessionId,
          start_line: startLine,
          end_line: endLine,
          function_name: functionName,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) continue;

      const result = (await response.json()) as {
        data: { decision: OverlapDecision; overlaps: ServerOverlap[]; guidance: string | null };
      };
      anySuccess = true;
      if (result.data.guidance) serverGuidance = result.data.guidance;

      for (const o of result.data.overlaps) {
        allOverlaps.push({
          display_name: o.display_name,
          session_id: o.session_id,
          repo_name: o.repo_name,
          started_at: o.started_at,
          summary: o.summary,
          file_path: o.file_path,
          start_line: o.start_line,
          end_line: o.end_line,
          function_name: o.function_name,
          tier: o.tier,
          session_url: `${team.instance_url}/session/${o.session_id}`,
          git_branch: o.git_branch,
          is_pushed: o.is_pushed,
          latest_edit: o.latest_edit,
        });
      }
    } catch {
      // Timeout or network error — this team's instance is unreachable
    }
  }

  if (!anySuccess) return null;

  // Re-sort merged results across teams
  const tierOrder = { line: 0, function: 1, adjacent: 2, file: 3 };
  allOverlaps.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  const hasHardOverlap = allOverlaps.some(
    (m) => m.tier === "line" || m.tier === "function",
  );
  const decision: OverlapDecision =
    allOverlaps.length === 0 ? "proceed" : hasHardOverlap ? "block" : "warn";

  return { decision, overlaps: allOverlaps, guidance: serverGuidance };
}

// ── Output ──────────────────────────────────────────────────────────────

/**
 * Unified output for overlap results (used by both server and cache paths).
 */
function outputMatchResult(
  decision: OverlapDecision,
  matches: OverlapMatch[],
  relPath: string,
  gitInfo: GitInfo | null,
  isHookMode: boolean,
  flags: CheckFlags,
  state?: TeamState | null,
  currentUserIds?: Set<string>,
  repoName?: string | null,
  guidance?: string | null,
): void {
  if (matches.length === 0) {
    if (flags.json) {
      outputJson({
        decision: "proceed",
        overlaps: [],
        team_sessions: [],
        git_host: gitInfo?.gitHost || null,
      });
    }
    process.exit(0);
  }

  if (flags.json) {
    const payload: Record<string, unknown> = {
      decision,
      overlaps: matches,
      git_host: gitInfo?.gitHost || null,
    };
    if (flags.context && state && currentUserIds && repoName) {
      payload.team_sessions = buildTeamSessions(state, currentUserIds, repoName);
    }
    outputJson(payload);
    if (flags.strict && decision === "block" && !isHookMode) {
      process.exit(2);
    }
    process.exit(0);
  }

  if (isHookMode) {
    outputHookFormat(matches, relPath, gitInfo, decision, guidance);
    // outputHookFormat calls process.exit(0)
  }

  outputCliText(matches, relPath, gitInfo, decision);
  if (flags.strict && decision === "block") {
    process.exit(2);
  }
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function parseCheckArgs(args: string[]): CheckFlags {
  const flags: CheckFlags = {
    json: false,
    repo: null,
    file: null,
    all: false,
    oldString: null,
    strict: false,
    context: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--old-string=")) {
      flags.oldString = arg.slice("--old-string=".length) || null;
      continue;
    }
    switch (arg) {
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
      case "--old-string":
        flags.oldString = args[++i] || null;
        break;
      case "--strict":
        flags.strict = true;
        break;
      case "--context":
        flags.context = true;
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
  const sessions = buildTeamSessions(state, currentUserIds, null);

  if (jsonMode) {
    outputJson({
      decision: "proceed",
      overlaps: [],
      team_sessions: sessions,
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
  decision: OverlapDecision,
  guidance?: string | null,
): void {
  const lines: string[] = [];
  const isBlock = decision === "block";

  for (const m of matches) {
    const ago = formatAgo(m.started_at);
    const region = m.function_name
      ? `${m.function_name}() (lines ${m.start_line}-${m.end_line})`
      : m.start_line
        ? `lines ${m.start_line}-${m.end_line}`
        : "this file";

    const pushState = m.is_pushed ? "pushed" : "unpushed";
    const branch = m.git_branch ? ` on branch '${m.git_branch}'` : "";

    lines.push(`OVERLAP ${isBlock ? "BLOCKED" : "WARNING"}: ${m.file_path}`);
    lines.push("");
    lines.push(`${m.display_name} is actively editing ${region} (${pushState}${branch}).`);
    lines.push(`Overlap tier: ${m.tier}. Session started ${ago}.`);
    if (m.session_url) {
      lines.push(`Session: ${m.session_url}`);
    }
    if (m.summary) {
      lines.push(`Session summary: "${m.summary}"`);
    }

    // Include latest diff if available
    if (m.latest_edit) {
      lines.push("");
      lines.push("Latest edit on this file:");
      if (m.latest_edit.old_string) {
        lines.push(`  Removed: "${m.latest_edit.old_string}"`);
      }
      if (m.latest_edit.new_string) {
        lines.push(`  Added:   "${m.latest_edit.new_string}"`);
      }
    }

    lines.push("");
  }

  // Server guidance or fallback recommendation
  if (guidance) {
    lines.push(guidance);
  } else if (isBlock) {
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

  const contextText = lines.join("\n");

  if (isBlock) {
    // Hard overlap: DENY the tool so Claude can decide what to do
    const hardMatches = matches.filter(
      (m) => m.tier === "line" || m.tier === "function",
    );
    const reasons: string[] = [];
    for (const m of hardMatches) {
      const region = m.function_name
        ? `${m.function_name}() (lines ${m.start_line}-${m.end_line})`
        : m.start_line
          ? `lines ${m.start_line}-${m.end_line}`
          : m.file_path;
      const pushInfo = m.is_pushed ? "pushed" : "unpushed";
      const branch = m.git_branch ? ` branch '${m.git_branch}'` : "";
      reasons.push(
        `${m.display_name} is editing ${region} (${m.tier} overlap, ${pushInfo}${branch})`,
      );
    }

    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `OVERLAP BLOCKED: ${reasons.join("; ")}. Review their changes and coordinate before editing this region.`,
        additionalContext: contextText,
      },
    };
    process.stdout.write(JSON.stringify(output));
  } else {
    // Soft overlap: proceed with context
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: contextText,
      },
    };
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

function outputCliText(
  matches: OverlapMatch[],
  relPath: string,
  gitInfo: GitInfo | null,
  decision: OverlapDecision,
): void {
  for (const m of matches) {
    const ago = formatAgo(m.started_at);
    const regionDesc = m.function_name
      ? `${m.function_name}() (lines ${m.start_line}-${m.end_line})`
      : m.start_line
        ? `lines ${m.start_line}-${m.end_line}`
        : "this file";

    console.log(`OVERLAP WARNING: ${m.file_path}`);
    console.log(`${m.display_name} is actively editing ${regionDesc} (${ago}).`);
    if (m.session_url) console.log(`Session: ${m.session_url}`);
    if (m.summary) console.log(`Session summary: "${m.summary}"`);
    console.log("");
  }

  if (decision === "block") {
    console.log(
      "Decision: block (hard overlap). Review teammate session and coordinate before editing.",
    );
  } else {
    console.log("Decision: warn (same file/adjacent activity). Proceed with awareness.");
  }

  if (gitInfo?.gitHost === "github") {
    console.log("");
    console.log("Also check for existing PRs that may cover this work:");
    console.log(`  gh pr list --search "${relPath}" --state open --limit 5`);
  } else if (gitInfo?.gitHost === "gitlab") {
    console.log("");
    console.log("Also check for existing MRs that may cover this work:");
    console.log(`  glab mr list --search "${relPath}" --state opened`);
  }
}

function buildTeamSessions(
  state: TeamState,
  currentUserIds: Set<string>,
  repoName: string | null,
): Array<{
  display_name: string;
  session_id: string;
  repo_name: string;
  started_at: string;
  summary: string | null;
  session_url: string;
  regions: TeamStateSession["regions"];
}> {
  const sessions = state.sessions.filter((s) => !currentUserIds.has(s.user_id));
  const sameRepo = repoName
    ? sessions.filter((s) => s.repo_name === repoName)
    : sessions;
  const scoped = sameRepo.length > 0 ? sameRepo : sessions;

  return scoped
    .slice()
    .sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    )
    .map((s) => ({
      display_name: s.display_name,
      session_id: s.session_id,
      repo_name: s.repo_name,
      started_at: s.started_at,
      summary: s.summary,
      session_url: `${s.instance_url || state.instance_url}/session/${s.session_id}`,
      regions: s.regions,
    }));
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ${min % 60}m ago`;
}
