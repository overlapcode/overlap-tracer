#!/usr/bin/env bun
import { loadConfig, saveConfig, addTeam, removeTeam, hasTeams, ensureOverlapDir, getOverlapDir } from "./config";
import { loadState } from "./state";
import { loadCache, setRepoList, saveCache } from "./cache";
import { verifyToken, fetchRepos } from "./auth";
import { Tracer, getDaemonPid, signalReload } from "./tracer";
import { installService, uninstallService, isServiceInstalled } from "./service";
import { existsSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

const VERSION = "1.0.0";

// ── Helpers ──────────────────────────────────────────────────────────────

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

  console.log(`\n  Dashboard: ${instanceUrl}/app\n`);
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const pid = getDaemonPid();
  const state = loadState();
  const cache = loadCache();

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
  console.log("\n  ✓ Tracer started.\n");
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

  console.log("\n  Overlap tracer has been uninstalled.\n");
}

function startDaemonBackground(): void {
  const execPath = process.argv[0];
  const child = spawn(execPath, ["daemon"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// ── Main ─────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "join":      await cmdJoin(); break;
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
