#!/usr/bin/env bun
import { loadConfig, saveConfig, addTeam, removeTeam, hasTeams, ensureOverlapDir, getOverlapDir } from "./config";
import { loadState, saveState } from "./state";
import { loadCache, setRepoList, saveCache } from "./cache";
import { verifyToken, fetchRepos } from "./auth";
import { Tracer, getDaemonPid, signalReload } from "./tracer";
import { installService, uninstallService, isServiceInstalled } from "./service";
import { existsSync, unlinkSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawn, execSync } from "child_process";
import { cmdCheck } from "./check";

const VERSION = "1.7.2";
const REPO = "overlapcode/overlap-tracer";

// ── Helpers ──────────────────────────────────────────────────────────────

async function checkForUpdate(): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { tag_name?: string };
    const latest = data.tag_name?.replace(/^v/, "");
    if (latest && latest !== VERSION) return latest;
    return null;
  } catch {
    return null;
  }
}

function printBox(text: string): void {
  const line = "─".repeat(text.length + 8);
  console.log(`\n  ╭${line}╮`);
  console.log(`  │    ${text}    │`);
  console.log(`  ╰${line}╯\n`);
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(`  ${question}`);
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];

  // Read until newline
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    const text = Buffer.concat(chunks).toString();
    if (text.includes("\n")) {
      reader.releaseLock();
      return text.trim();
    }
  }
  reader.releaseLock();
  return Buffer.concat(chunks).toString().trim();
}

function printUsage(): void {
  console.log(`
  overlap v${VERSION} — See what your team is building with coding agents

  Usage:
    overlap join [url]  Join a team (or update token for existing team)
    overlap login       Open dashboard in browser (no token needed)
    overlap status      Show tracer status, teams, and repos
    overlap update      Update to the latest version
    overlap leave       Leave a team
    overlap backfill    Re-sync all sessions (optionally for one team)
    overlap start       Start the tracer daemon
    overlap stop        Stop the tracer daemon
    overlap restart     Restart the tracer daemon
    overlap daemon      Run as daemon (foreground, used by OS service)
    overlap debug       Print parsed events to stdout (no sending)
    overlap uninstall   Stop daemon, remove service, remove config
    overlap version     Show version
    overlap help        Show this help message
`);
}

// ── Commands ─────────────────────────────────────────────────────────────

async function cmdJoin(): Promise<void> {
  // Accept URL from command line: overlap join <url>
  let instanceUrl = process.argv[3] || "";
  if (instanceUrl) {
    // Normalize: strip trailing slashes
    instanceUrl = instanceUrl.replace(/\/+$/, "");
  } else {
    printBox("overlap · join a team");
    instanceUrl = (await prompt("Instance URL: ")).replace(/\/+$/, "");
  }
  if (!instanceUrl) {
    console.log("  Cancelled.\n");
    return;
  }

  // Check if this team already exists in config
  const existingConfig = loadConfig();
  const existingTeam = existingConfig.teams.find((t) => t.instance_url === instanceUrl);

  if (existingTeam) {
    printBox("overlap · update token");
    console.log(`  Team: ${existingTeam.name} (${instanceUrl})`);
    console.log(`  This team is already configured. Enter a new token to update.\n`);
  } else {
    if (process.argv[3]) {
      printBox("overlap · join a team");
    }
    console.log(`  Instance URL: ${instanceUrl}`);
  }

  const userToken = await prompt("Your token: ");
  if (!userToken) {
    console.log("  Cancelled.\n");
    return;
  }

  // Verify token
  process.stdout.write("  Verifying...");
  let verifyResult;
  try {
    verifyResult = await verifyToken(instanceUrl, userToken);
  } catch (err) {
    console.log(` ✗\n  Error: ${err instanceof Error ? err.message : err}\n`);
    return;
  }
  console.log(` ✓ Token valid. Welcome, ${verifyResult.display_name}!`);

  // Fetch repos
  let repos: string[];
  try {
    repos = await fetchRepos(instanceUrl, userToken);
  } catch (err) {
    console.log(`  Warning: Could not fetch repos: ${err instanceof Error ? err.message : err}`);
    repos = [];
  }

  console.log(`\n  Team: ${verifyResult.team_name}`);
  if (repos.length > 0) {
    console.log(`  Repos: ${repos.join(", ")}`);
  }

  // Save config (addTeam replaces existing team by instance_url)
  ensureOverlapDir();
  const config = addTeam({
    name: verifyResult.team_name,
    instance_url: instanceUrl,
    user_token: userToken,
    user_id: verifyResult.user_id,
  });

  // Cache repos
  const cache = loadCache();
  setRepoList(cache, instanceUrl, repos);
  saveCache(cache);

  if (existingTeam) {
    console.log(`\n  ✓ Token updated for "${verifyResult.team_name}".`);
  }

  // Handle daemon
  const pid = getDaemonPid();
  if (pid) {
    console.log(`  Tracer already running (PID ${pid}).`);
    if (!existingTeam) {
      console.log(`  Added "${verifyResult.team_name}" to config.`);
    }
    console.log("  Reloading tracer...");
    signalReload(pid);
    console.log(`\n  ✓ Now tracking ${config.teams.length} team(s):`);
    for (const team of config.teams) {
      const teamRepos = cache.repo_lists[team.instance_url]?.repos ?? [];
      console.log(`    ${team.name.padEnd(16)} · ${teamRepos.length} repo(s)`);
    }
  } else {
    console.log("\n  Starting tracer...");
    startDaemonBackground();
    console.log(`  ✓ Tracer started`);

    if (!isServiceInstalled()) {
      installService();
      console.log("  ✓ Registered as startup service");
    }
  }

  // Set up global Claude Code hooks and skills
  setupGlobalHooksAndSkills();

  console.log(`\n  Dashboard: ${instanceUrl}`);
  console.log(`  Tip: Run 'overlap login' anytime to open the dashboard.\n`);
}

/**
 * Set up Claude Code hooks and skills globally in ~/.claude/.
 * Merges PreToolUse hook into ~/.claude/settings.json and creates
 * skill files for overlap-check and overlap-context.
 * Skips if ~/.claude/ doesn't exist (user doesn't have Claude Code).
 */
function setupGlobalHooksAndSkills(): void {
  const claudeDir = join(homedir(), ".claude");

  // Only set up if user has Claude Code installed
  if (!existsSync(claudeDir)) {
    return;
  }

  try {
    // ── 1. Merge hook into ~/.claude/settings.json ──
    const settingsPath = join(claudeDir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        settings = {};
      }
    }

    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown[]>;

    if (!hooks.PreToolUse) {
      hooks.PreToolUse = [];
    }
    const preToolUse = hooks.PreToolUse as Array<Record<string, unknown>>;

    // Check if overlap hook already present (matches both old .sh and new direct command)
    const hasOverlapHook = preToolUse.some((entry) => {
      const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      return innerHooks?.some(
        (h) =>
          typeof h.command === "string" && h.command.includes("overlap"),
      );
    });

    if (!hasOverlapHook) {
      preToolUse.push({
        matcher: "Edit|Write|MultiEdit",
        hooks: [
          {
            type: "command",
            command: "overlap check",
            timeout: 10,
          },
        ],
      });
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

    // ── 2. Create overlap-check skill ──
    const checkSkillDir = join(claudeDir, "skills", "overlap-check");
    mkdirSync(checkSkillDir, { recursive: true });

    writeFileSync(
      join(checkSkillDir, "SKILL.md"),
      `---
name: overlap-check
description: Check if any teammate is currently working on the same files or code regions. Use when about to edit shared code, before starting work on a file, or when the user asks to check for overlaps.
allowed-tools: Bash, Read
---

# Overlap Check

Check for active teammate sessions that overlap with your current work.

## When to Use

- Before editing a file that might be shared
- User asks "is anyone else working on this?"
- User says "check for overlaps" or "overlap check"
- Starting work on a critical shared module

## Step 1: Run the check

\`\`\`bash
overlap check --json --repo $(basename $(git rev-parse --show-toplevel 2>/dev/null) 2>/dev/null)
\`\`\`

If you want to check a specific file:

\`\`\`bash
overlap check --json --file <relative-path>
\`\`\`

## Step 2: Parse the JSON output

The output has this structure:

\`\`\`json
{
  "overlaps": [
    {
      "display_name": "Alice",
      "session_id": "abc123",
      "repo_name": "my-repo",
      "file_path": "src/index.ts",
      "tier": "line|function|adjacent|file",
      "function_name": "handleRequest",
      "start_line": 42,
      "end_line": 58,
      "session_url": "https://app.example.com/session/abc123",
      "summary": "Refactoring auth middleware"
    }
  ],
  "git_host": "github|gitlab|null",
  "warning": "optional warning message"
}
\`\`\`

## Step 3: Report findings

For each overlap:
- **Who** is working there (display_name)
- **What** they are editing (file, function, line range)
- **Tier** severity: line (direct conflict) > function (same function) > adjacent (nearby) > file (same file)
- **Link** to their session (session_url)
- **Summary** of what they are doing

## Step 4: Check for related PRs

If \`git_host\` is "github":
\`\`\`bash
gh pr list --state open --limit 10
\`\`\`

If \`git_host\` is "gitlab":
\`\`\`bash
glab mr list --state opened
\`\`\`

## Step 5: Recommendation

- **Line/function overlap**: Warn strongly. Suggest reviewing the other session first and coordinating.
- **Adjacent/file overlap**: Note for awareness. Proceed with caution.
- **No overlaps, no related PRs**: Confirm the coast is clear.
- **Warning present**: Mention it (e.g., daemon not running).
`,
    );

    // ── 3. Create overlap-context skill ──
    const contextSkillDir = join(claudeDir, "skills", "overlap-context");
    mkdirSync(contextSkillDir, { recursive: true });

    writeFileSync(
      join(contextSkillDir, "SKILL.md"),
      `---
name: overlap-context
description: Load team context - see what all teammates are currently working on across all repos. Use at session start, when user asks "what is the team doing", or to maintain awareness throughout a session.
allowed-tools: Bash
---

# Overlap Team Context

Load a summary of all active teammate sessions for awareness.

## When to Use

- Start of a session (team awareness)
- User asks "what is the team working on?"
- User says "overlap context" or "team status"
- Before starting a large refactor

## Step 1: Fetch all sessions

\`\`\`bash
overlap check --json --all
\`\`\`

## Step 2: Parse the JSON output

\`\`\`json
{
  "overlaps": [],
  "team_sessions": [
    {
      "display_name": "Alice",
      "session_id": "abc123",
      "repo_name": "my-repo",
      "started_at": "2025-01-15T10:30:00Z",
      "summary": "Building user dashboard",
      "session_url": "https://...",
      "regions": [
        { "file_path": "src/dashboard.tsx", "function_name": "Dashboard", "start_line": 1, "end_line": 45 }
      ]
    }
  ]
}
\`\`\`

## Step 3: Present team status

For each active session:
- **Who**: display_name
- **Repo**: repo_name
- **What**: summary and files/functions they have touched
- **When**: how long ago the session started
- **Link**: session_url

Highlight any files in the same repository as the current working directory.

## Step 4: Keep context in mind

When you are about to edit a file that a teammate is actively working on,
mention it proactively before proceeding.

If no active sessions, confirm the team is clear.
`,
    );

    console.log("  ✓ Claude Code coordination hooks + skills installed");

    // ── 4. Migrate: clean up old per-project hooks if present in CWD ──
    migrateOldProjectHooks();
  } catch (err) {
    // Non-fatal: hooks are optional enhancement
    console.log(
      `  Note: Could not set up Claude Code hooks: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}

/**
 * Remove Overlap hooks and skills from ~/.claude/.
 * Called by uninstall and leave (when last team removed).
 */
function removeGlobalHooksAndSkills(): void {
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) return;

  try {
    // Remove hook from settings.json
    const settingsPath = join(claudeDir, "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(
        readFileSync(settingsPath, "utf-8"),
      ) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;

      if (hooks?.PreToolUse) {
        const preToolUse = hooks.PreToolUse as Array<
          Record<string, unknown>
        >;
        hooks.PreToolUse = preToolUse.filter((entry) => {
          const innerHooks = entry.hooks as
            | Array<Record<string, unknown>>
            | undefined;
          return !innerHooks?.some(
            (h) =>
              typeof h.command === "string" &&
              h.command.includes("overlap"),
          );
        });
        if ((hooks.PreToolUse as unknown[]).length === 0) {
          delete hooks.PreToolUse;
        }
        // Clean up empty hooks object
        if (Object.keys(hooks).length === 0) {
          delete settings.hooks;
        }
        writeFileSync(
          settingsPath,
          JSON.stringify(settings, null, 2) + "\n",
        );
      }
    }

    // Remove skill directories
    const checkSkillDir = join(claudeDir, "skills", "overlap-check");
    if (existsSync(checkSkillDir)) {
      rmSync(checkSkillDir, { recursive: true, force: true });
    }
    const contextSkillDir = join(claudeDir, "skills", "overlap-context");
    if (existsSync(contextSkillDir)) {
      rmSync(contextSkillDir, { recursive: true, force: true });
    }

    console.log("  ✓ Removed Claude Code hooks and skills");
  } catch (err) {
    console.log(
      `  Note: Could not clean up Claude Code hooks: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}

/**
 * Clean up old per-project .claude/scripts/overlap-hook.sh and .claude/commands/overlap-*.md
 * if present in the current working directory. Best-effort migration.
 */
function migrateOldProjectHooks(): void {
  try {
    const cwd = process.cwd();
    const localClaudeDir = join(cwd, ".claude");
    const localHookScript = join(localClaudeDir, "scripts", "overlap-hook.sh");

    if (!existsSync(localHookScript)) return;

    unlinkSync(localHookScript);

    // Remove old per-project hook from local settings.json
    const localSettingsPath = join(localClaudeDir, "settings.json");
    if (existsSync(localSettingsPath)) {
      const localSettings = JSON.parse(
        readFileSync(localSettingsPath, "utf-8"),
      ) as Record<string, unknown>;
      const localHooks = (localSettings.hooks as Record<string, unknown[]>)
        ?.PreToolUse as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(localHooks)) {
        const hooks = localSettings.hooks as Record<string, unknown[]>;
        hooks.PreToolUse = localHooks.filter((entry) => {
          const innerHooks = entry.hooks as
            | Array<Record<string, unknown>>
            | undefined;
          return !innerHooks?.some(
            (h) =>
              typeof h.command === "string" &&
              h.command.includes("overlap-hook.sh"),
          );
        });
        if ((hooks.PreToolUse as unknown[]).length === 0) {
          delete hooks.PreToolUse;
        }
        if (Object.keys(hooks).length === 0) {
          delete localSettings.hooks;
        }
        writeFileSync(
          localSettingsPath,
          JSON.stringify(localSettings, null, 2) + "\n",
        );
      }
    }

    // Clean up old command files
    const oldCheckCmd = join(localClaudeDir, "commands", "overlap-check.md");
    const oldContextCmd = join(
      localClaudeDir,
      "commands",
      "overlap-context.md",
    );
    if (existsSync(oldCheckCmd)) unlinkSync(oldCheckCmd);
    if (existsSync(oldContextCmd)) unlinkSync(oldContextCmd);
  } catch {
    // Migration is best-effort
  }
}

async function cmdLogin(): Promise<void> {
  const config = loadConfig();

  if (config.teams.length === 0) {
    console.log("\n  No teams configured. Run 'overlap join' first.\n");
    return;
  }

  let team: typeof config.teams[0];

  if (config.teams.length === 1) {
    team = config.teams[0];
  } else {
    console.log("\n  Select a team to open:");
    for (let i = 0; i < config.teams.length; i++) {
      console.log(`    ${i + 1}. ${config.teams[i].name} (${config.teams[i].instance_url})`);
    }
    const choice = await prompt("Choice (number): ");
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= config.teams.length) {
      console.log("  Invalid choice.\n");
      return;
    }
    team = config.teams[idx];
  }

  process.stdout.write(`\n  Opening ${team.name} dashboard...`);

  try {
    const res = await fetch(`${team.instance_url}/api/v1/auth/login-link`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${team.user_token}`,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 401) {
      console.log(` ✗\n  Token rejected. Run 'overlap join ${team.instance_url}' to update your token.\n`);
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      throw new Error((body as Record<string, unknown>).error as string || `HTTP ${res.status}`);
    }

    const body = (await res.json()) as { data: { login_url: string } };
    const loginUrl = body.data.login_url;

    // Open in default browser
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      execSync(`${openCmd} "${loginUrl}"`, { stdio: "pipe" });
      console.log(" ✓\n");
    } catch {
      console.log(` ✓\n\n  Open this URL in your browser:\n  ${loginUrl}\n`);
    }
  } catch (err) {
    console.log(` ✗\n  Error: ${err instanceof Error ? err.message : err}\n`);
  }
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const pid = getDaemonPid();
  const state = loadState();
  const cache = loadCache();

  // Check for updates in parallel with display
  const updatePromise = checkForUpdate();

  console.log(`\n  overlap v${VERSION}\n`);

  // Daemon status
  if (pid) {
    console.log(`  Tracer:  running (PID ${pid})`);
  } else {
    console.log("  Tracer:  stopped");
  }

  console.log(`  Service: ${isServiceInstalled() ? "registered" : "not registered"}`);

  // Teams
  if (config.teams.length === 0) {
    const latestVersion = await updatePromise;
    if (latestVersion) {
      console.log(`\n  Update available: v${VERSION} → v${latestVersion}`);
      console.log("  Run: overlap update");
    }
    console.log("\n  No teams configured. Run 'overlap join' to get started.\n");
    return;
  }

  console.log(`\n  Teams (${config.teams.length}):`);
  // Quick-verify each team's token in parallel
  const verifyResults = await Promise.allSettled(
    config.teams.map(async (team) => {
      try {
        const res = await fetch(`${team.instance_url}/api/v1/auth/verify`, {
          headers: { Authorization: `Bearer ${team.user_token}` },
          signal: AbortSignal.timeout(5000),
        });
        return { url: team.instance_url, status: res.status };
      } catch {
        return { url: team.instance_url, status: 0 };
      }
    }),
  );
  const tokenStatus = new Map<string, number>();
  for (const result of verifyResults) {
    if (result.status === "fulfilled") {
      tokenStatus.set(result.value.url, result.value.status);
    }
  }

  for (const team of config.teams) {
    const repos = cache.repo_lists[team.instance_url]?.repos ?? [];
    const status = tokenStatus.get(team.instance_url);
    const warning = status === 401 ? " ⚠ token rejected" : status === 0 ? " ⚠ unreachable" : "";
    console.log(`    ${team.name.padEnd(20)} · ${repos.length} repo(s) · ${team.instance_url}${warning}`);
  }

  // Tracked sessions
  const trackedCount = Object.keys(state.tracked_files).length;
  if (trackedCount > 0) {
    console.log(`\n  Tracked sessions: ${trackedCount}`);
    const entries = Object.entries(state.tracked_files).slice(-5);
    for (const [_path, tracked] of entries) {
      console.log(`    ${tracked.session_id.slice(0, 8)}... → ${tracked.matched_repo} (turn ${tracked.turn_number})`);
    }
  }

  // Show update notice if available
  const latestVersion = await updatePromise;
  if (latestVersion) {
    console.log(`\n  Update available: v${VERSION} → v${latestVersion}`);
    console.log("  Run: overlap update");
  }

  console.log();
}

async function cmdLeave(): Promise<void> {
  const config = loadConfig();

  if (config.teams.length === 0) {
    console.log("\n  No teams to leave.\n");
    return;
  }

  let teamToLeave: typeof config.teams[0];

  if (config.teams.length === 1) {
    teamToLeave = config.teams[0];
    console.log(`\n  Leaving "${teamToLeave.name}"...`);
  } else {
    console.log("\n  Select a team to leave:");
    for (let i = 0; i < config.teams.length; i++) {
      console.log(`    ${i + 1}. ${config.teams[i].name} (${config.teams[i].instance_url})`);
    }
    const choice = await prompt("Choice (number): ");
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= config.teams.length) {
      console.log("  Invalid choice.\n");
      return;
    }
    teamToLeave = config.teams[idx];
    console.log(`  Leaving "${teamToLeave.name}"...`);
  }

  const updated = removeTeam(teamToLeave.instance_url);

  if (updated.teams.length === 0) {
    // Last team — stop everything
    // Uninstall service first (KeepAlive would respawn killed daemon)
    uninstallService();
    console.log("  ✓ Removed startup service");
    const pid = getDaemonPid();
    if (pid) {
      console.log("  Stopping tracer...");
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    // Clean up Claude Code hooks and skills
    removeGlobalHooksAndSkills();
    console.log(`  ✓ Left "${teamToLeave.name}". No teams remaining.\n`);
  } else {
    // Reload daemon with updated config
    const pid = getDaemonPid();
    if (pid) {
      signalReload(pid);
      console.log(`  ✓ Left "${teamToLeave.name}". Still tracking ${updated.teams.length} team(s).`);
    }
    console.log();
  }
}

async function cmdBackfill(): Promise<void> {
  const teamFilter = process.argv[3]; // optional team name
  const config = loadConfig();
  const state = loadState();

  if (config.teams.length === 0) {
    console.log("\n  No teams configured. Run 'overlap join' first.\n");
    return;
  }

  // Find matching team(s)
  let targetTeamUrls: Set<string>;
  if (teamFilter) {
    const team = config.teams.find(
      (t) => t.name.toLowerCase() === teamFilter.toLowerCase() || t.instance_url === teamFilter,
    );
    if (!team) {
      console.log(`\n  Team "${teamFilter}" not found. Available teams:`);
      for (const t of config.teams) {
        console.log(`    ${t.name} (${t.instance_url})`);
      }
      console.log();
      return;
    }
    targetTeamUrls = new Set([team.instance_url]);
    console.log(`\n  Resetting byte offsets for team "${team.name}"...`);
  } else {
    targetTeamUrls = new Set(config.teams.map((t) => t.instance_url));
    console.log(`\n  Resetting byte offsets for all ${config.teams.length} team(s)...`);
  }

  // Reset byte_offsets for matching tracked files
  let resetCount = 0;
  for (const [filePath, tracked] of Object.entries(state.tracked_files)) {
    const matchesTeam = tracked.matched_teams.some((url: string) => targetTeamUrls.has(url));
    if (matchesTeam && tracked.byte_offset > 0) {
      tracked.byte_offset = 0;
      resetCount++;
    }
  }

  if (resetCount === 0) {
    console.log("  No sessions to backfill.\n");
    return;
  }

  // Save updated state
  saveState(state);
  console.log(`  ✓ Reset ${resetCount} session(s) for re-sync.`);

  // Restart daemon to trigger backfill
  const pid = getDaemonPid();
  if (pid) {
    console.log("  Restarting tracer to begin backfill...");
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 1000));
    startDaemonBackground();
    console.log("  ✓ Tracer restarted. Backfill in progress.");
    console.log("  Server dedup ensures no duplicate events are created.\n");
  } else {
    console.log("  Tracer not running. Start it with 'overlap start' to begin backfill.\n");
  }
}

async function cmdStart(): Promise<void> {
  if (!hasTeams()) {
    console.log("\n  No teams configured. Run 'overlap join' first.\n");
    return;
  }

  const pid = getDaemonPid();
  if (pid) {
    console.log(`\n  Tracer already running (PID ${pid}).\n`);
    return;
  }

  startDaemonBackground();

  if (!isServiceInstalled()) {
    installService();
    console.log("\n  ✓ Tracer started. Registered as startup service.\n");
  } else {
    console.log("\n  ✓ Tracer started.\n");
  }
}

async function cmdStop(): Promise<void> {
  const pid = getDaemonPid();
  if (!pid) {
    console.log("\n  Tracer is not running.\n");
    return;
  }

  process.kill(pid, "SIGTERM");
  console.log(`\n  ✓ Tracer stopped (was PID ${pid}).\n`);
}

async function cmdRestart(): Promise<void> {
  const pid = getDaemonPid();
  if (pid) {
    process.kill(pid, "SIGTERM");
    // Wait a moment for clean shutdown
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!hasTeams()) {
    console.log("\n  No teams configured. Run 'overlap join' first.\n");
    return;
  }

  startDaemonBackground();
  console.log("\n  ✓ Tracer restarted.\n");
}

async function cmdDaemon(): Promise<void> {
  if (!hasTeams()) {
    console.error("[daemon] No teams configured. Run 'overlap join' first.");
    process.exit(1);
  }

  // Kill any other overlap daemon processes before starting
  killOtherDaemons();

  const tracer = new Tracer();
  await tracer.start();

  // Keep alive — the event loop stays open from watchers and timers
}

/**
 * Kill any other `overlap daemon` processes besides ourselves.
 * Prevents duplicate daemons from launchd KeepAlive + manual starts.
 */
function killOtherDaemons(): void {
  const myPid = process.pid;
  try {
    const output = execSync("pgrep -f 'overlap daemon'", { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    const pids = output.split("\n").map((p) => parseInt(p, 10)).filter((p) => !isNaN(p) && p !== myPid);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (pids.length > 0) {
      console.log(`[daemon] Killed ${pids.length} stale daemon process(es).`);
    }
  } catch {
    // pgrep returns non-zero if no matches — that's fine
  }
}

async function cmdDebug(): Promise<void> {
  if (!hasTeams()) {
    console.log("\n  No teams configured. Run 'overlap join' first.\n");
    return;
  }

  const tracer = new Tracer();
  await tracer.debug();
}

async function cmdUninstall(): Promise<void> {
  console.log("\n  Uninstalling Overlap tracer...");

  // Remove service FIRST — launchd has KeepAlive=true, so killing the
  // daemon manually would cause launchd to respawn it immediately.
  // launchctl unload properly stops the managed process and removes the job.
  uninstallService();
  console.log("  ✓ Removed startup service");

  // Kill daemon if still running (e.g. started manually without service)
  const pid = getDaemonPid();
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    console.log("  ✓ Stopped tracer daemon");
  }

  // Clean up Claude Code hooks and skills
  removeGlobalHooksAndSkills();

  // Remove config directory
  const overlapDir = getOverlapDir();
  if (existsSync(overlapDir)) {
    rmSync(overlapDir, { recursive: true, force: true });
    console.log("  ✓ Removed ~/.overlap/");
  }

  // Remove the binary itself
  const binaryPath = process.execPath;
  if (!removeBinary(binaryPath)) {
    console.log(`\n  Note: Could not auto-remove the binary at ${binaryPath}`);
    console.log("  Remove it manually:");
    console.log(`    rm "${binaryPath}"`);
  }

  console.log("\n  Overlap tracer has been uninstalled.\n");
}

function removeBinary(binaryPath: string): boolean {
  // Check if installed via npm (path contains node_modules or npx cache)
  if (binaryPath.includes("node_modules") || binaryPath.includes("npm")) {
    try {
      execSync("npm uninstall -g overlapdev", { stdio: "pipe" });
      console.log("  ✓ Removed npm package (overlapdev)");
      return true;
    } catch { /* fall through */ }
  }

  // Direct binary — try to delete it
  try {
    unlinkSync(binaryPath);
    console.log(`  ✓ Removed binary (${binaryPath})`);
    return true;
  } catch {
    return false;
  }
}

function startDaemonBackground(): void {
  // In Bun-compiled binaries, process.argv[0] is "bun" — use execPath instead
  const execPath = process.execPath;
  const logsDir = join(homedir(), ".overlap", "logs");

  // Use nohup via shell — Bun-compiled binaries don't reliably
  // self-fork with Node's spawn({ detached: true }).
  const child = spawn("sh", ["-c", `nohup "${execPath}" daemon >> "${logsDir}/tracer.log" 2>> "${logsDir}/tracer.error.log" &`], {
    stdio: "ignore",
  });
  child.unref();
}

async function cmdUpdate(): Promise<void> {
  process.stdout.write(`\n  overlap v${VERSION} — checking for updates...`);

  const latest = await checkForUpdate();
  if (!latest) {
    console.log(` ✓\n  You're on the latest version.\n`);
    return;
  }

  console.log(`\n  Update available: v${VERSION} → v${latest}\n`);

  // Detect platform
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const assetName = `overlap-${os}-${arch}`;
  const downloadUrl = `https://github.com/${REPO}/releases/download/v${latest}/${assetName}`;

  // Determine install location (where this binary lives)
  const currentBinary = process.execPath;

  process.stdout.write(`  Downloading v${latest}...`);

  try {
    const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) {
      console.log(` ✗\n  Download failed: HTTP ${resp.status}`);
      console.log(`  Try manually: curl -fsSL https://overlap.dev/install.sh | sh\n`);
      return;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());

    // Write to a temp file first, then replace
    const tmpPath = `${currentBinary}.tmp`;
    writeFileSync(tmpPath, buffer, { mode: 0o755 });

    // Atomic replace
    renameSync(tmpPath, currentBinary);

    console.log(` ✓`);

    // Restart daemon if running
    const pid = getDaemonPid();
    if (pid) {
      process.stdout.write("  Restarting tracer...");
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 1000));
      startDaemonBackground();
      console.log(" ✓");
    }

    // Run post-update setup with the NEW binary (not the old one running now)
    if (hasTeams()) {
      try {
        execSync(`"${currentBinary}" _post-update`, { stdio: "inherit", timeout: 10000 });
      } catch {
        // Non-fatal — user can run 'overlap join' to set up hooks manually
      }
    }

    console.log(`\n  ✓ Updated to v${latest}\n`);
  } catch (err) {
    console.log(` ✗\n  Error: ${err instanceof Error ? err.message : err}`);
    console.log(`  Try manually: curl -fsSL https://overlap.dev/install.sh | sh\n`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "join":      await cmdJoin(); break;
  case "login":     await cmdLogin(); break;
  case "check":     await cmdCheck(); break;
  case "backfill":  await cmdBackfill(); break;
  case "status":    await cmdStatus(); break;
  case "update":    await cmdUpdate(); break;
  case "leave":     await cmdLeave(); break;
  case "start":     await cmdStart(); break;
  case "stop":      await cmdStop(); break;
  case "restart":   await cmdRestart(); break;
  case "daemon":    await cmdDaemon(); break;
  case "debug":     await cmdDebug(); break;
  case "uninstall": await cmdUninstall(); break;
  case "_post-update": setupGlobalHooksAndSkills(); break;
  case "version":
  case "--version":
  case "-v":
    console.log(`overlap v${VERSION}`);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.log(`\n  Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
