import { watch, readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { readdirSync } from "fs";
import type { Config, IngestEvent, SessionParserState, State, TrackedFile, GitRemoteEntry } from "./types";
import type { AgentAdapter } from "./agents/types";
import { claudeCodeAdapter } from "./agents/claude-code";
import { extractCwdFromLine } from "./agents/claude-code";
import { matchRepo, matchFileToRepo, stripFilePath } from "./matcher";
import { EventSender } from "./sender";
import { loadConfig } from "./config";
import { loadState, saveState, getTrackedFile, setTrackedFile, createTrackedFile, toSessionParserState, updateFromParserState } from "./state";
import { loadCache, saveCache, buildRepoListsMap, buildGitCacheMap, setRepoList, setGitRemote } from "./cache";
import { fetchRepos } from "./auth";
import { enrichLineData } from "./enrichment";
import { pollTeamState } from "./team-state";
import type { Cache } from "./types";

const PID_PATH = join(homedir(), ".overlap", "tracer.pid");
const RELOAD_FLAG_PATH = join(homedir(), ".overlap", "reload");

export class Tracer {
  private config: Config;
  private state: State;
  private cache: Cache;
  private adapters: AgentAdapter[];
  private watchers: ReturnType<typeof watch>[] = [];
  private sessionStates = new Map<string, SessionParserState>();
  private repoLists: Map<string, string[]>;
  private gitCache: Map<string, GitRemoteEntry>;
  private windowsReloadTimer: ReturnType<typeof setInterval> | null = null;
  private repoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private stateFlushTimer: ReturnType<typeof setInterval> | null = null;
  private teamStatePollTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  // In-memory read positions — only committed to byte_offset after events are flushed
  private readHeads = new Map<string, number>();

  sender: EventSender;

  constructor() {
    this.config = loadConfig();
    this.state = loadState();
    this.cache = loadCache();
    this.adapters = [claudeCodeAdapter];
    this.repoLists = buildRepoListsMap(this.cache);
    this.gitCache = buildGitCacheMap(this.cache);

    this.sender = new EventSender(this.config.tracer, (_teamUrl, count) => {
      if (count > 0) {
        // State is saved periodically, not per-batch
      }
    });

    this.sender.setOnAuthFailure((teamUrl) => {
      console.warn(`[tracer] Token rejected by ${teamUrl}. Run 'overlap join ${teamUrl}' with a new token.`);
    });

    // Restore session parser states from persisted state
    for (const [filePath, tracked] of Object.entries(this.state.tracked_files)) {
      this.sessionStates.set(filePath, toSessionParserState(tracked));
    }
  }

  async start(): Promise<void> {
    this.writePidFile();
    this.registerSignalHandlers();

    // Refresh repo lists from all teams
    await this.refreshAllRepoLists();

    // Scan existing files and start watching
    for (const adapter of this.adapters) {
      this.scanExistingFiles(adapter);
      this.watchAdapter(adapter);
    }

    // Start periodic repo sync
    this.repoSyncTimer = setInterval(
      () => this.refreshAllRepoLists(),
      this.config.tracer.repo_sync_interval_ms,
    );

    // Periodically flush state to disk
    this.stateFlushTimer = setInterval(() => this.saveState(), 10_000);

    // Start team-state polling for real-time coordination (every 30 seconds)
    const authFailureHandler = (teamUrl: string) => {
      this.sender.suspendTeam(teamUrl);
    };
    this.teamStatePollTimer = setInterval(
      () => {
        const activeTeams = this.config.teams.filter((t) => !this.sender.isTeamSuspended(t.instance_url));
        if (activeTeams.length > 0) {
          pollTeamState(activeTeams, authFailureHandler).catch(() => {});
        }
      },
      30_000,
    );
    // Initial poll
    pollTeamState(this.config.teams, authFailureHandler).catch(() => {});

    // Windows reload polling
    if (process.platform === "win32") {
      this.startWindowsReloadPolling();
    }

    console.log(`[tracer] Running (PID ${process.pid}), watching ${this.adapters.length} agent(s).`);
  }

  async reloadConfig(): Promise<void> {
    console.log("[tracer] Reloading config...");
    this.config = loadConfig();
    await this.refreshAllRepoLists();
    // Re-create sender with potentially new settings
    this.sender = new EventSender(this.config.tracer);
    console.log(`[tracer] Config reloaded. Tracking ${this.config.teams.length} team(s).`);
  }

  stopWatchers(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
  }

  saveState(): void {
    // Commit read heads to byte_offsets only if no events are pending
    // If events are pending (server down), keep byte_offset behind so
    // events are re-read on daemon restart
    const hasPending = this.sender.getPendingCount() > 0;

    for (const [filePath, sessionState] of this.sessionStates) {
      const tracked = getTrackedFile(this.state, filePath);
      if (tracked) {
        updateFromParserState(tracked, sessionState);
        // Only advance persisted byte_offset if all events have been flushed
        if (!hasPending) {
          const readHead = this.readHeads.get(filePath);
          if (readHead !== undefined) {
            tracked.byte_offset = readHead;
          }
        }
      }
    }
    saveState(this.state);

    // Also persist git cache updates
    for (const [cwd, repo] of this.gitCache) {
      setGitRemote(this.cache, cwd, repo);
    }
    saveCache(this.cache);
  }

  removePidFile(): void {
    try {
      // Only delete if the PID file contains our own PID — another daemon may have
      // overwritten it during a race (e.g. launchd KeepAlive + manual restart)
      const filePid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
      if (filePid === process.pid) {
        unlinkSync(PID_PATH);
      }
    } catch { /* ignore — file may not exist */ }
  }

  private writePidFile(): void {
    writeFileSync(PID_PATH, String(process.pid));
  }

  private registerSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      console.log(`[tracer] Received ${signal}, shutting down...`);

      try {
        this.stopWatchers();
        if (this.windowsReloadTimer) clearInterval(this.windowsReloadTimer);
        if (this.repoSyncTimer) clearInterval(this.repoSyncTimer);
        if (this.stateFlushTimer) clearInterval(this.stateFlushTimer);
        if (this.teamStatePollTimer) clearInterval(this.teamStatePollTimer);

        await this.sender.flushAll(5000);
        // After final flush, commit all read heads regardless of pending state
        for (const [filePath, readHead] of this.readHeads) {
          const tracked = getTrackedFile(this.state, filePath);
          if (tracked) tracked.byte_offset = readHead;
        }
        this.saveState();
        this.removePidFile();
        console.log("[tracer] Clean shutdown complete.");
      } catch (err) {
        console.error("[tracer] Error during shutdown:", err);
      }

      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    if (process.platform !== "win32") {
      process.on("SIGHUP", () => this.reloadConfig());
    }
  }

  private startWindowsReloadPolling(): void {
    this.windowsReloadTimer = setInterval(async () => {
      try {
        if (existsSync(RELOAD_FLAG_PATH)) {
          unlinkSync(RELOAD_FLAG_PATH);
          await this.reloadConfig();
          console.log("[tracer] Config reloaded (Windows flag file).");
        }
      } catch {
        // Flag file doesn't exist or can't be read
      }
    }, 2000);
  }

  private async refreshAllRepoLists(): Promise<void> {
    const oldRepoLists = this.repoLists;

    for (const team of this.config.teams) {
      if (this.sender.isTeamSuspended(team.instance_url)) continue;
      try {
        const repos = await fetchRepos(team.instance_url, team.user_token);
        setRepoList(this.cache, team.instance_url, repos);
      } catch (err) {
        console.error(`[tracer] Failed to fetch repos from ${team.name}: ${err}`);
        // Use cached list if available
      }
    }
    this.repoLists = buildRepoListsMap(this.cache);
    saveCache(this.cache);

    // Detect changes and act on them
    const { added, removed } = diffRepoLists(oldRepoLists, this.repoLists);

    if (removed.length > 0) {
      console.log(`[tracer] Repos removed: ${removed.join(', ')}`);
      this.cleanupRemovedRepos(removed);
    }

    if (added.length > 0) {
      console.log(`[tracer] Repos added: ${added.join(', ')}. Re-scanning for backfill...`);
      for (const adapter of this.adapters) {
        this.scanExistingFiles(adapter);
      }
    }
  }

  private cleanupRemovedRepos(removedRepos: string[]): void {
    const removedSet = new Set(removedRepos);

    for (const [filePath, tracked] of Object.entries(this.state.tracked_files)) {
      if (!removedSet.has(tracked.matched_repo)) continue;

      console.log(`[tracer] Untracking ${filePath} (repo "${tracked.matched_repo}" removed)`);
      delete this.state.tracked_files[filePath];
      this.readHeads.delete(filePath);
      this.sessionStates.delete(filePath);
    }
  }

  private scanExistingFiles(adapter: AgentAdapter): void {
    if (!existsSync(adapter.watchDir)) return;

    try {
      const folders = readdirSync(adapter.watchDir, { withFileTypes: true });
      for (const folder of folders) {
        if (!folder.isDirectory()) continue;
        const folderPath = join(adapter.watchDir, folder.name);
        try {
          const files = readdirSync(folderPath, { withFileTypes: true });
          for (const file of files) {
            if (file.isFile() && file.name.endsWith(adapter.fileExtension)) {
              const filePath = join(folderPath, file.name);
              this.processFile(filePath, adapter);
            }
          }
        } catch {
          // Can't read folder
        }
      }
    } catch {
      // Watch dir doesn't exist or can't be read
    }
  }

  private watchAdapter(adapter: AgentAdapter): void {
    if (!existsSync(adapter.watchDir)) {
      console.warn(`[tracer] Watch directory does not exist: ${adapter.watchDir}`);
      return;
    }

    const watcher = watch(adapter.watchDir, { recursive: true }, (eventType, filename) => {
      if (this.shuttingDown) return;
      if (!filename || !filename.endsWith(adapter.fileExtension)) return;

      const filePath = join(adapter.watchDir, filename);
      if (!existsSync(filePath)) return;

      this.processFile(filePath, adapter);
    });

    this.watchers.push(watcher);
  }

  private processFile(filePath: string, adapter: AgentAdapter): void {
    const sessionId = adapter.extractSessionId(filePath);
    let tracked = getTrackedFile(this.state, filePath);

    // Get file size to know how much to read
    let fileSize: number;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      return;
    }

    // Use readHead (in-memory) if available, otherwise fall back to persisted byte_offset
    const currentOffset = this.readHeads.get(filePath) ?? tracked?.byte_offset ?? 0;

    // If we've already read to the end, nothing new
    if (currentOffset >= fileSize) return;

    const startOffset = currentOffset;

    // Read new bytes
    let newContent: string;
    try {
      const fd = Bun.file(filePath);
      const buffer = readFileSync(filePath);
      newContent = buffer.subarray(startOffset).toString("utf-8");
    } catch {
      return;
    }

    if (!newContent) return;

    const lines = newContent.split("\n");

    // If this is a new file (no tracked entry), extract cwd from init line first
    if (!tracked) {
      let cwd: string | null = null;

      for (const line of lines) {
        if (!line.trim()) continue;
        cwd = extractCwdFromLine(line);
        if (cwd) break;
      }

      if (!cwd) {
        // No init line yet — skip, will retry on next watch event
        return;
      }

      // Match repo
      const matches = matchRepo(cwd, this.repoLists, this.gitCache);
      if (matches.length === 0) {
        // Not a tracked repo — skip entirely
        return;
      }

      // Build subdirectory → repo name mapping for parent-directory sessions
      const subDirRepos: Record<string, string> = {};
      const hasSubDirs = matches.some((m) => m.subDir);
      if (hasSubDirs) {
        for (const m of matches) {
          if (m.subDir) subDirRepos[m.subDir] = m.repoName;
        }
      }

      tracked = createTrackedFile(
        sessionId,
        cwd,
        [...new Set(matches.map((m) => m.teamUrl))],
        matches[0].repoName,
      );
      if (hasSubDirs) tracked.sub_dir_repos = subDirRepos;
      setTrackedFile(this.state, filePath, tracked);
      this.sessionStates.set(filePath, {
        turnNumber: 0,
        filesTouched: new Set(),
      });
    }

    const sessionState = this.sessionStates.get(filePath)!;
    const subDirMap = tracked!.sub_dir_repos
      ? new Map(Object.entries(tracked!.sub_dir_repos))
      : null;

    // Parse each line and send events
    let bytesProcessed = 0;
    for (const line of lines) {
      bytesProcessed += Buffer.byteLength(line, "utf-8") + 1; // +1 for \n

      if (!line.trim()) continue;

      const events = adapter.parseLine(line, sessionId, sessionState);

      for (const event of events) {
        // Line-level enrichment for file_op events (before stripping paths)
        if (event.event_type === "file_op" && event.new_string && event.file_path) {
          enrichLineData(event, tracked!.cwd);
        }

        // Determine which repo this event belongs to
        let eventRepoName = tracked!.matched_repo;

        if (subDirMap && event.file_path) {
          // Parent-directory mode: route file_ops to the correct repo
          const fileRepo = matchFileToRepo(event.file_path, tracked!.cwd!, subDirMap);
          if (fileRepo) {
            eventRepoName = fileRepo;
          } else if (event.event_type === "file_op") {
            // File doesn't belong to any registered repo — skip
            continue;
          }
        }

        // For parent-directory sessions, use composite session IDs per repo
        if (subDirMap && eventRepoName !== tracked!.matched_repo) {
          event.session_id = `${event.session_id}:${eventRepoName}`;
        }

        // Strip file paths relative to the repo subdirectory if applicable
        if (subDirMap && event.file_path) {
          // Find which subDir this file is under
          const cwdPrefix = tracked!.cwd!.endsWith("/") ? tracked!.cwd! : tracked!.cwd! + "/";
          for (const [subDir, repo] of subDirMap) {
            if (repo === eventRepoName && event.file_path.startsWith(cwdPrefix + subDir + "/")) {
              event.file_path = event.file_path.slice((cwdPrefix + subDir + "/").length);
              break;
            }
          }
        } else if (event.file_path) {
          event.file_path = stripFilePath(event.file_path, tracked!.cwd);
        }

        if (event.files_touched) {
          event.files_touched = event.files_touched.map((f) => stripFilePath(f, tracked!.cwd));
        }
        event.repo_name = eventRepoName;

        // Attach git remote URL to session_start events
        if (event.event_type === "session_start" && tracked!.cwd) {
          const gitEntry = this.gitCache.get(tracked!.cwd);
          if (gitEntry?.remoteUrl) {
            event.git_remote_url = gitEntry.remoteUrl;
          }
        }

        // Send to each matched team
        for (const teamUrl of tracked!.matched_teams) {
          const team = this.config.teams.find((t) => t.instance_url === teamUrl);
          if (team) {
            const teamEvent = { ...event, user_id: team.user_id };
            this.sender.add(teamUrl, team.user_token, teamEvent);
          }
        }
      }
    }

    // Advance read head in memory (NOT byte_offset — that's committed on flush)
    this.readHeads.set(filePath, startOffset + Buffer.byteLength(newContent, "utf-8"));
    updateFromParserState(tracked!, sessionState);
  }

  /**
   * Debug mode: process files and print events to stdout instead of sending.
   */
  async debug(): Promise<void> {
    console.log("[debug] Scanning for active sessions...\n");

    await this.refreshAllRepoLists();

    for (const adapter of this.adapters) {
      if (!existsSync(adapter.watchDir)) {
        console.log(`[debug] Watch directory not found: ${adapter.watchDir}`);
        continue;
      }

      const folders = readdirSync(adapter.watchDir, { withFileTypes: true });
      for (const folder of folders) {
        if (!folder.isDirectory()) continue;
        const folderPath = join(adapter.watchDir, folder.name);
        const files = readdirSync(folderPath, { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(adapter.fileExtension)) continue;
          const filePath = join(folderPath, file.name);
          const sessionId = adapter.extractSessionId(filePath);

          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n");

          let cwd: string | null = null;
          for (const line of lines) {
            if (!line.trim()) continue;
            cwd = extractCwdFromLine(line);
            if (cwd) break;
          }

          if (!cwd) continue;

          const matches = matchRepo(cwd, this.repoLists, this.gitCache);
          if (matches.length === 0) continue;

          console.log(`Session: ${sessionId}`);
          console.log(`  cwd:   ${cwd}`);
          console.log(`  repo:  ${matches[0].repoName}`);
          console.log(`  teams: ${matches.map((m) => m.teamUrl).join(", ")}`);

          const sessionState: SessionParserState = { turnNumber: 0, filesTouched: new Set() };
          let eventCount = 0;
          for (const line of lines) {
            if (!line.trim()) continue;
            const events = adapter.parseLine(line, sessionId, sessionState);
            for (const event of events) {
              if (event.file_path) {
                event.file_path = stripFilePath(event.file_path, cwd!);
              }
              eventCount++;
              console.log(`  [${event.event_type}] ${event.timestamp} ${event.tool_name || event.prompt_text?.slice(0, 60) || ""}`);
            }
          }
          console.log(`  Total events: ${eventCount}\n`);
        }
      }
    }
  }
}

// ── Repo list diffing ────────────────────────────────────────────────────

export function diffRepoLists(
  oldLists: Map<string, string[]>,
  newLists: Map<string, string[]>,
): { added: string[]; removed: string[] } {
  const oldAll = new Set<string>();
  for (const repos of oldLists.values()) {
    for (const r of repos) oldAll.add(r);
  }

  const newAll = new Set<string>();
  for (const repos of newLists.values()) {
    for (const r of repos) newAll.add(r);
  }

  const added: string[] = [];
  for (const r of newAll) {
    if (!oldAll.has(r)) added.push(r);
  }

  const removed: string[] = [];
  for (const r of oldAll) {
    if (!newAll.has(r)) removed.push(r);
  }

  return { added, removed };
}

// ── Daemon PID helpers ───────────────────────────────────────────────────

export function getDaemonPid(): number | null {
  // Try PID file first (fast path)
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    // Check if process is alive
    process.kill(pid, 0);
    return pid;
  } catch { /* PID file missing or stale */ }

  // Fallback: find daemon via pgrep (handles missing PID file from race conditions)
  try {
    const output = execSync("pgrep -f 'overlap daemon'", { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    const pids = output.split("\n").map((p) => parseInt(p, 10)).filter((p) => !isNaN(p) && p !== process.pid);
    if (pids.length > 0) {
      return pids[0];
    }
  } catch { /* pgrep returns non-zero if no matches */ }

  return null;
}

export function signalReload(pid: number): void {
  if (process.platform === "win32") {
    writeFileSync(RELOAD_FLAG_PATH, "");
  } else {
    process.kill(pid, "SIGHUP");
  }
}
