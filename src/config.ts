import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Config, TeamConfig, TracerSettings } from "./types";

const OVERLAP_DIR = join(homedir(), ".overlap");
const CONFIG_PATH = join(OVERLAP_DIR, "config.json");

const DEFAULT_TRACER_SETTINGS: TracerSettings = {
  batch_interval_ms: 2000,
  max_batch_size: 100,
  repo_sync_interval_ms: 300_000,
};

export function getOverlapDir(): string {
  return OVERLAP_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function ensureOverlapDir(): void {
  if (!existsSync(OVERLAP_DIR)) {
    mkdirSync(OVERLAP_DIR, { recursive: true });
  }
  const logsDir = join(OVERLAP_DIR, "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      teams: parsed.teams ?? [],
      tracer: { ...DEFAULT_TRACER_SETTINGS, ...parsed.tracer },
    };
  } catch {
    return { teams: [], tracer: { ...DEFAULT_TRACER_SETTINGS } };
  }
}

export function saveConfig(config: Config): void {
  ensureOverlapDir();
  // Cap max_batch_size at 500 (server limit)
  config.tracer.max_batch_size = Math.min(config.tracer.max_batch_size, 500);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function addTeam(team: TeamConfig): Config {
  // Normalize instance_url: strip trailing slash to prevent double-slash in URLs
  team.instance_url = team.instance_url.replace(/\/+$/, "");

  const config = loadConfig();
  // Replace existing team with same instance_url, or add new
  const idx = config.teams.findIndex((t) => t.instance_url === team.instance_url);
  if (idx >= 0) {
    config.teams[idx] = team;
  } else {
    config.teams.push(team);
  }
  saveConfig(config);
  return config;
}

export function removeTeam(instanceUrl: string): Config {
  const config = loadConfig();
  config.teams = config.teams.filter((t) => t.instance_url !== instanceUrl);
  saveConfig(config);
  return config;
}

export function hasTeams(): boolean {
  const config = loadConfig();
  return config.teams.length > 0;
}
