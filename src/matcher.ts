import { basename, join } from "path";
import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";

export type RepoMatch = {
  teamUrl: string;
  repoName: string;
  /** If set, this repo was found as a subdirectory of the session cwd */
  subDir?: string;
};

/**
 * Match a session's cwd to registered repos across all teams.
 *
 * Strategy:
 *   1. Basename of cwd matches a registered repo name
 *   2. Git remote origin name matches a registered repo name
 *   3. Subdirectories of cwd are registered repos (parent directory mode)
 *
 * @param cwd - The real working directory from the JSONL init line
 * @param repoLists - Map of team_url → repo name arrays
 * @param gitCache - Mutable cache of cwd → repo name from git remote lookups
 * @returns Array of matches (can match multiple teams/repos)
 */
export function matchRepo(
  cwd: string,
  repoLists: Map<string, string[]>,
  gitCache: Map<string, string>,
): RepoMatch[] {
  const dirName = basename(cwd);

  const matches: RepoMatch[] = [];

  // Step 1: Check each team's repo list by basename
  for (const [teamUrl, repos] of repoLists) {
    if (repos.includes(dirName)) {
      matches.push({ teamUrl, repoName: dirName });
    }
  }

  // Step 2: If no match by basename, try git remote
  if (matches.length === 0) {
    let gitRepoName = gitCache.get(cwd);
    if (gitRepoName === undefined) {
      gitRepoName = getGitRepoName(cwd) ?? "";
      if (gitRepoName) {
        gitCache.set(cwd, gitRepoName);
      }
    }
    if (gitRepoName) {
      for (const [teamUrl, repos] of repoLists) {
        if (repos.includes(gitRepoName)) {
          matches.push({ teamUrl, repoName: gitRepoName });
        }
      }
    }
  }

  // Step 3: If still no match, check subdirectories (parent directory of multiple repos)
  if (matches.length === 0) {
    const subMatches = matchSubdirectories(cwd, repoLists, gitCache);
    matches.push(...subMatches);
  }

  return matches;
}

/**
 * Check if any direct subdirectories of cwd are registered repos.
 * Matches by subdirectory basename or git remote.
 */
function matchSubdirectories(
  cwd: string,
  repoLists: Map<string, string[]>,
  gitCache: Map<string, string>,
): RepoMatch[] {
  const matches: RepoMatch[] = [];

  // Collect all registered repo names across all teams
  const allRepos = new Set<string>();
  for (const repos of repoLists.values()) {
    for (const repo of repos) allRepos.add(repo);
  }
  if (allRepos.size === 0) return matches;

  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const subPath = join(cwd, entry.name);
      const subName = entry.name;

      // Check basename match
      if (allRepos.has(subName)) {
        for (const [teamUrl, repos] of repoLists) {
          if (repos.includes(subName)) {
            matches.push({ teamUrl, repoName: subName, subDir: subName });
          }
        }
        continue;
      }

      // Check git remote match
      let gitName = gitCache.get(subPath);
      if (gitName === undefined) {
        gitName = getGitRepoName(subPath) ?? "";
        if (gitName) gitCache.set(subPath, gitName);
      }
      if (gitName && allRepos.has(gitName)) {
        for (const [teamUrl, repos] of repoLists) {
          if (repos.includes(gitName)) {
            matches.push({ teamUrl, repoName: gitName, subDir: subName });
          }
        }
      }
    }
  } catch {
    // Can't read directory
  }

  return matches;
}

/**
 * Given a file path and a parent cwd with subdirectory repos, determine which repo
 * the file belongs to. Returns the repo name or null if no match.
 */
export function matchFileToRepo(
  filePath: string,
  cwd: string,
  subDirRepos: Map<string, string>,
): string | null {
  if (!filePath.startsWith("/")) return null;

  const cwdPrefix = cwd.endsWith("/") ? cwd : cwd + "/";
  if (!filePath.startsWith(cwdPrefix)) return null;

  const relative = filePath.slice(cwdPrefix.length);
  const firstSlash = relative.indexOf("/");
  const topDir = firstSlash > 0 ? relative.slice(0, firstSlash) : relative;

  return subDirRepos.get(topDir) ?? null;
}

function getGitRepoName(cwd: string): string | null {
  try {
    const remote = execSync("git remote get-url origin", { cwd, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] })
      .toString().trim();
    // https://github.com/org/repo.git → "repo"
    // git@github.com:org/repo.git → "repo"
    const match = remote.match(/[/:]([^/:]+?)(?:\.git)?$/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * Strip absolute path to relative by removing the cwd prefix.
 * /Users/michael/work/crop2cash/src/index.ts → src/index.ts
 *
 * Sentinel values like "(bash)", "(grep)", "(glob)" are passed through unchanged.
 */
export function stripFilePath(filePath: string, cwd: string | undefined): string {
  if (!cwd || !filePath.startsWith("/")) return filePath;
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}
