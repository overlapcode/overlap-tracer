/**
 * Team state polling and local cache management.
 *
 * Polls the Overlap instance for active sessions with file regions,
 * writes to ~/.overlap/team-state.json for the PreToolUse hook to read.
 */

import { writeFileSync, readFileSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { TeamConfig, TeamState, TeamStateSession } from "./types";

const OVERLAP_DIR = join(homedir(), ".overlap");
const TEAM_STATE_PATH = join(OVERLAP_DIR, "team-state.json");
const TEAM_STATE_TMP = join(OVERLAP_DIR, "team-state.tmp.json");

/**
 * Poll all configured teams for active session state and write to local cache.
 * @param onAuthFailure - Called when a team returns 401 (token rejected)
 */
export async function pollTeamState(
  teams: TeamConfig[],
  onAuthFailure?: (teamUrl: string) => void,
): Promise<void> {
  const allSessions: TeamStateSession[] = [];

  for (const team of teams) {
    try {
      const response = await fetch(`${team.instance_url}/api/v1/team-state`, {
        headers: {
          Authorization: `Bearer ${team.user_token}`,
          "Content-Type": "application/json",
        },
      });

      if (response.status === 401) {
        onAuthFailure?.(team.instance_url);
        continue;
      }
      if (!response.ok) continue;

      const result = (await response.json()) as {
        data?: { sessions: TeamStateSession[] };
      };

      if (result.data?.sessions) {
        // Tag each session with the instance URL for linking
        for (const session of result.data.sessions) {
          allSessions.push(session);
        }
      }
    } catch {
      // Network error, instance down — skip this team
    }
  }

  // Write snapshot (atomic: write tmp then rename)
  const state: TeamState = {
    updated_at: new Date().toISOString(),
    instance_url: teams[0]?.instance_url || "",
    sessions: allSessions,
  };

  try {
    writeFileSync(TEAM_STATE_TMP, JSON.stringify(state, null, 2));
    renameSync(TEAM_STATE_TMP, TEAM_STATE_PATH);
  } catch {
    // Write failed — stale cache is acceptable
  }
}

/**
 * Read the local team state cache. Returns null if missing or stale (>2 min).
 */
export function readTeamState(): TeamState | null {
  try {
    if (!existsSync(TEAM_STATE_PATH)) return null;

    const raw = readFileSync(TEAM_STATE_PATH, "utf-8");
    const state = JSON.parse(raw) as TeamState;

    // Check staleness (2 minutes)
    const age = Date.now() - new Date(state.updated_at).getTime();
    if (age > 120_000) return null;

    return state;
  } catch {
    return null;
  }
}

export { TEAM_STATE_PATH };
