import { watch, readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { readdirSync } from "fs";
import type { Config, IngestEvent, SessionParserState, State, TrackedFile } from "./types";
import type { AgentAdapter } from "./agents/types";
import { claudeCodeAdapter } from "./agents/claude-code";
import { extractCwdFromLine } from "./agents/claude-code";
import { matchRepo, stripFilePath } from "./matcher";
import { EventSender } from "./sender";
import { loadConfig } from "./config";
import { loadState, saveState, getTrackedFile, setTrackedFile, createTrackedFile, toSessionParserState, updateFromParserState } from "./state";
import { loadCache, saveCache, buildRepoListsMap, buildGitCacheMap, setRepoList, setGitRemote } from "./cache";
import { fetchRepos } from "./auth";
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
  private gitCache: Map<string, string>;
  private windowsReloadTimer: ReturnType<typeof setInterval> | null = null;
  private repoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private stateFlushTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

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
    // Update tracked files from session parser states
    for (const [filePath, sessionState] of this.sessionStates) {
      const tracked = getTrackedFile(this.state, filePath);
      if (tracked) {
        updateFromParserState(tracked, sessionState);
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
    try { unlinkSync(PID_PATH); } catch { /* ignore */ }
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

        await this.sender.flushAll(5000);
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
    for (const team of this.config.teams) {
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

    // If we've already read to the end, nothing new
    if (tracked && tracked.byte_offset >= fileSize) return;

    const startOffset = tracked?.byte_offset ?? 0;

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

      tracked = createTrackedFile(
        sessionId,
        cwd,
        matches.map((m) => m.teamUrl),
        matches[0].repoName,
      );
      setTrackedFile(this.state, filePath, tracked);
      this.sessionStates.set(filePath, {
        turnNumber: 0,
        filesTouched: new Set(),
      });
    }

    const sessionState = this.sessionStates.get(filePath)!;

    // Parse each line and send events
    let bytesProcessed = 0;
    for (const line of lines) {
      bytesProcessed += Buffer.byteLength(line, "utf-8") + 1; // +1 for \n

      if (!line.trim()) continue;

      const events = adapter.parseLine(line, sessionId, sessionState);

      for (const event of events) {
        // Fill in user_id, repo_name, strip file paths
        if (event.file_path) {
          event.file_path = stripFilePath(event.file_path, tracked!.cwd);
        }
        if (event.files_touched) {
          event.files_touched = event.files_touched.map((f) => stripFilePath(f, tracked!.cwd));
        }
        event.repo_name = tracked!.matched_repo;

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

    // Update byte offset
    tracked!.byte_offset = startOffset + Buffer.byteLength(newContent, "utf-8");
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

// ── Daemon PID helpers ───────────────────────────────────────────────────

export function getDaemonPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    // Check if process is alive
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function signalReload(pid: number): void {
  if (process.platform === "win32") {
    writeFileSync(RELOAD_FLAG_PATH, "");
  } else {
    process.kill(pid, "SIGHUP");
  }
}
