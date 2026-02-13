import { basename } from "path";
import { execSync } from "child_process";

/**
 * Match a session's cwd to registered repos across all teams.
 *
 * @param cwd - The real working directory from the JSONL init line
 * @param repoLists - Map of team_url → repo name arrays
 * @param gitCache - Mutable cache of cwd → repo name from git remote lookups
 * @returns Array of matches (can match multiple teams for the same repo)
 */
export function matchRepo(
  cwd: string,
  repoLists: Map<string, string[]>,
  gitCache: Map<string, string>,
): { teamUrl: string; repoName: string }[] {
  const dirName = basename(cwd);

  const matches: { teamUrl: string; repoName: string }[] = [];

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

  return matches;
}

function getGitRepoName(cwd: string): string | null {
  try {
    const remote = execSync("git remote get-url origin", { cwd, timeout: 5000 })
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
