import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Cache, GitRemoteEntry } from "./types";
import { ensureOverlapDir } from "./config";

const CACHE_PATH = join(homedir(), ".overlap", "cache.json");

export function loadCache(): Cache {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return { repo_lists: {}, git_remotes: {} };
  }
}

export function saveCache(cache: Cache): void {
  ensureOverlapDir();
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export function setRepoList(cache: Cache, instanceUrl: string, repos: string[]): void {
  cache.repo_lists[instanceUrl] = {
    repos,
    fetched_at: new Date().toISOString(),
  };
}

export function getRepoList(cache: Cache, instanceUrl: string): string[] {
  return cache.repo_lists[instanceUrl]?.repos ?? [];
}

export function removeRepoList(cache: Cache, instanceUrl: string): void {
  delete cache.repo_lists[instanceUrl];
}

export function getGitRemote(cache: Cache, cwd: string): GitRemoteEntry | undefined {
  const entry = cache.git_remotes[cwd];
  if (!entry) return undefined;
  // Backward compat: old cache has plain string values (just the repo name)
  if (typeof entry === "string") return { name: entry, remoteUrl: "" };
  return entry;
}

export function setGitRemote(cache: Cache, cwd: string, entry: GitRemoteEntry): void {
  cache.git_remotes[cwd] = entry;
}

/**
 * Build a Map<teamUrl, repoNames[]> from the cache for the matcher.
 */
export function buildRepoListsMap(cache: Cache): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [url, entry] of Object.entries(cache.repo_lists)) {
    map.set(url, entry.repos);
  }
  return map;
}

/**
 * Build a Map<cwd, GitRemoteEntry> from the cache for the matcher.
 * Handles backward compat with old caches that stored plain strings.
 */
export function buildGitCacheMap(cache: Cache): Map<string, GitRemoteEntry> {
  const map = new Map<string, GitRemoteEntry>();
  for (const [cwd, entry] of Object.entries(cache.git_remotes)) {
    if (typeof entry === "string") {
      map.set(cwd, { name: entry, remoteUrl: "" });
    } else {
      map.set(cwd, entry);
    }
  }
  return map;
}
