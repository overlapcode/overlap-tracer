/**
 * overlap check — PreToolUse hook handler for real-time coordination.
 *
 * Reads team-state.json, compares against the target file,
 * and outputs structured JSON for Claude Code's additionalContext.
 *
 * Input: JSON from stdin (Claude Code hook protocol)
 * Output: JSON to stdout with hookSpecificOutput (or silent exit 0)
 */

import { readFileSync } from "fs";
import { basename, resolve } from "path";
import { execSync } from "child_process";
import { readTeamState } from "./team-state";
import { loadConfig } from "./config";

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
};

/**
 * Run the check command. Called from CLI dispatcher.
 */
export async function cmdCheck(): Promise<void> {
  // Read hook input from stdin
  let input: HookInput;
  try {
    const raw = readFileSync(0, "utf-8"); // fd 0 = stdin
    input = JSON.parse(raw);
  } catch {
    // No stdin or invalid JSON — silent exit
    process.exit(0);
  }

  // Extract file path from tool input
  const filePath = input.tool_input.file_path
    || input.tool_input.notebook_path
    || null;

  if (!filePath) {
    // No file path (e.g., Bash command) — nothing to check
    process.exit(0);
  }

  // Read team state cache
  const state = readTeamState();
  if (!state || state.sessions.length === 0) {
    process.exit(0);
  }

  // Determine current repo name
  const repoName = detectRepoName(input.cwd);
  if (!repoName) {
    process.exit(0);
  }

  // Determine current user to exclude self
  const config = loadConfig();
  const currentUserIds = new Set(config.teams.map((t) => t.user_id));

  // Resolve file path relative to cwd
  const relPath = filePath.startsWith("/")
    ? filePath.replace(input.cwd + "/", "")
    : filePath;

  // Resolve target line range from old_string (for Edit)
  let targetStartLine: number | null = null;
  let targetEndLine: number | null = null;
  if (input.tool_input.old_string && filePath) {
    try {
      const absPath = resolve(input.cwd, filePath);
      const content = readFileSync(absPath, "utf-8");
      const idx = content.indexOf(input.tool_input.old_string);
      if (idx !== -1) {
        const before = content.substring(0, idx);
        targetStartLine = before.split("\n").length;
        targetEndLine = targetStartLine + input.tool_input.old_string.split("\n").length - 1;
      }
    } catch {
      // File not readable
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
        targetStartLine != null && targetEndLine != null &&
        region.start_line != null && region.end_line != null
      ) {
        // Check line overlap
        if (targetStartLine <= region.end_line && targetEndLine >= region.start_line) {
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

      // Check function overlap (if both have function names)
      if (tier === "file" && region.function_name) {
        // We'd need to resolve the target function too, but for now
        // function-level detection happens server-side. Keep as file tier.
      }

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
      });
    }
  }

  if (matches.length === 0) {
    // No overlaps — silent exit, don't block
    process.exit(0);
  }

  // Sort: line > function > adjacent > file
  const tierOrder = { line: 0, function: 1, adjacent: 2, file: 3 };
  matches.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  // Build context message
  const instanceUrl = state.instance_url;
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
    if (instanceUrl) {
      lines.push(`Session: ${instanceUrl}/session/${m.session_id}`);
    }
    if (m.summary) {
      lines.push(`Session summary: "${m.summary}"`);
    }
    lines.push("");
  }

  // Add recommendation
  const hasHardOverlap = matches.some((m) => m.tier === "line" || m.tier === "function");
  if (hasHardOverlap) {
    lines.push("Recommendation: Review the other session before modifying this region. If the work conflicts, coordinate with the other developer.");
  } else {
    lines.push("Note: Another developer is working in the same file. Proceed with awareness.");
  }

  // Add PR check suggestion
  const gitHost = detectGitHost(input.cwd);
  if (gitHost === "github") {
    lines.push("");
    lines.push("Also check for existing PRs that may cover this work:");
    lines.push(`  gh pr list --search "${relPath}" --state open --limit 5`);
  } else if (gitHost === "gitlab") {
    lines.push("");
    lines.push("Also check for existing MRs that may cover this work:");
    lines.push(`  glab mr list --search "${relPath}" --state opened`);
  }

  // Output structured JSON for Claude Code
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

function detectRepoName(cwd: string): string | null {
  // Try git remote first
  try {
    const url = execSync("git remote get-url origin", { cwd, timeout: 3000 })
      .toString()
      .trim();
    const match = url.match(/[/:]([^/:]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    // Not a git repo or no remote
  }
  // Fall back to directory basename
  return basename(cwd);
}

function detectGitHost(cwd: string): "github" | "gitlab" | null {
  try {
    const url = execSync("git remote get-url origin", { cwd, timeout: 3000 })
      .toString()
      .trim();
    if (url.includes("github.com")) return "github";
    if (url.includes("gitlab.com") || url.includes("gitlab")) return "gitlab";
  } catch {
    // Not a git repo
  }
  return null;
}
