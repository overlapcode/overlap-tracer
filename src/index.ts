#!/usr/bin/env bun
import { loadConfig, saveConfig, addTeam, removeTeam, hasTeams, ensureOverlapDir, getOverlapDir } from "./config";
import { loadState } from "./state";
import { loadCache, setRepoList, saveCache } from "./cache";
import { verifyToken, fetchRepos } from "./auth";
import { Tracer, getDaemonPid, signalReload } from "./tracer";
import { installService, uninstallService, isServiceInstalled } from "./service";
import { existsSync, unlinkSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawn, execSync } from "child_process";
import { cmdCheck } from "./check";

const VERSION = "1.1.1";
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
    overlap join        Join a team (prompts for instance URL + token)
    overlap status      Show tracer status, teams, and repos
    overlap leave       Leave a team
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
  printBox("overlap · join a team");

  const instanceUrl = await prompt("Instance URL: ");
  if (!instanceUrl) {
    console.log("  Cancelled.\n");
    return;
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

  // Save config
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

  // Handle daemon
  const pid = getDaemonPid();
  if (pid) {
    console.log(`\n  Tracer already running (PID ${pid}).`);
    console.log(`  Added "${verifyResult.team_name}" to config.`);
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

  // Set up Claude Code hooks and commands in current directory
  setupHooksAndCommands();

  console.log(`\n  Dashboard: ${instanceUrl}/app\n`);
}

/**
 * Set up Claude Code hooks and commands in the current working directory.
 * Creates .claude/scripts/overlap-hook.sh, .claude/commands/, and merges hooks into settings.json.
 */
function setupHooksAndCommands(): void {
  const cwd = process.cwd();
  const claudeDir = join(cwd, ".claude");

  // Only set up if this looks like a project directory (has .git or package.json etc.)
  if (!existsSync(join(cwd, ".git")) && !existsSync(join(cwd, "package.json"))) {
    return;
  }

  try {
    // Create directories
    const scriptsDir = join(claudeDir, "scripts");
    const commandsDir = join(claudeDir, "commands");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(commandsDir, { recursive: true });

    // Write hook script (graceful fallback when overlap not installed)
    const hookScript = `#!/usr/bin/env sh
# Overlap coordination hook — silently skips if overlap is not installed
command -v overlap >/dev/null 2>&1 || exit 0
overlap check
`;
    writeFileSync(join(scriptsDir, "overlap-hook.sh"), hookScript, { mode: 0o755 });

    // Write overlap-check command
    const checkCommand = `Check if anyone on your team is currently working on the same files or
code regions. Run:

  overlap check --repo $(basename $(git rev-parse --toplevel)) --json

Parse the JSON output. For each overlap found, report:
- Who is working on the overlapping file/region
- What function or line range they're editing
- A direct link to their session
- Their session summary

Then check for existing PRs that may cover the same work:
- If the git remote contains github.com: run \`gh pr list --state open --limit 10\`
- If the git remote contains gitlab.com: run \`glab mr list --state opened\`
- Otherwise skip the PR check

If no overlaps and no related PRs, confirm the coast is clear.
`;
    writeFileSync(join(commandsDir, "overlap-check.md"), checkCommand);

    // Write overlap-context command
    const contextCommand = `Load what your team is currently working on for awareness throughout
this session. Run:

  overlap check --repo $(basename $(git rev-parse --toplevel)) --json

Parse the JSON output and present a brief team status:
- For each active session: who, repo, session summary, how long ago
  it started, and which files/functions they have touched
- Highlight any files that overlap with the current repository

Keep this context in mind. When you are about to edit a file that someone
else is actively working on, mention it before proceeding.

If no active sessions, confirm the team is clear.
`;
    writeFileSync(join(commandsDir, "overlap-context.md"), contextCommand);

    // Merge hooks into .claude/settings.json
    const settingsPath = join(claudeDir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        settings = {};
      }
    }

    // Ensure hooks structure exists
    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown[]>;

    // Check if our hook is already present
    if (!hooks.PreToolUse) {
      hooks.PreToolUse = [];
    }
    const preToolUse = hooks.PreToolUse as Array<Record<string, unknown>>;

    const hasOverlapHook = preToolUse.some((entry) => {
      const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      return innerHooks?.some((h) =>
        typeof h.command === "string" && h.command.includes("overlap-hook.sh")
      );
    });

    if (!hasOverlapHook) {
      preToolUse.push({
        matcher: "Edit|Write|MultiEdit",
        hooks: [
          {
            type: "command",
            command: ".claude/scripts/overlap-hook.sh",
            timeout: 10,
          },
        ],
      });
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

    console.log("  ✓ Claude Code coordination hooks installed");
  } catch (err) {
    // Non-fatal: hooks are optional enhancement
    console.log(`  Note: Could not set up Claude Code hooks: ${err instanceof Error ? err.message : "unknown error"}`);
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
      console.log("  Run: curl -fsSL https://overlap.dev/install.sh | sh");
    }
    console.log("\n  No teams configured. Run 'overlap join' to get started.\n");
    return;
  }

  console.log(`\n  Teams (${config.teams.length}):`);
  for (const team of config.teams) {
    const repos = cache.repo_lists[team.instance_url]?.repos ?? [];
    console.log(`    ${team.name.padEnd(20)} · ${repos.length} repo(s) · ${team.instance_url}`);
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
    console.log("  Run: curl -fsSL https://overlap.dev/install.sh | sh");
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
    const pid = getDaemonPid();
    if (pid) {
      console.log("  Stopping tracer...");
      process.kill(pid, "SIGTERM");
    }
    uninstallService();
    console.log("  ✓ Removed startup service");
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

  const tracer = new Tracer();
  await tracer.start();

  // Keep alive — the event loop stays open from watchers and timers
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

  // Stop daemon
  const pid = getDaemonPid();
  if (pid) {
    process.kill(pid, "SIGTERM");
    console.log("  ✓ Stopped tracer daemon");
  }

  // Remove service
  uninstallService();
  console.log("  ✓ Removed startup service");

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

// ── Main ─────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "join":      await cmdJoin(); break;
  case "check":     await cmdCheck(); break;
  case "status":    await cmdStatus(); break;
  case "leave":     await cmdLeave(); break;
  case "start":     await cmdStart(); break;
  case "stop":      await cmdStop(); break;
  case "restart":   await cmdRestart(); break;
  case "daemon":    await cmdDaemon(); break;
  case "debug":     await cmdDebug(); break;
  case "uninstall": await cmdUninstall(); break;
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
