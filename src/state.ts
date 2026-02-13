import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { State, TrackedFile, SessionParserState } from "./types";
import { ensureOverlapDir } from "./config";

const STATE_PATH = join(homedir(), ".overlap", "state.json");

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { tracked_files: {} };
  }
}

export function saveState(state: State): void {
  ensureOverlapDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function getTrackedFile(state: State, filePath: string): TrackedFile | undefined {
  return state.tracked_files[filePath];
}

export function setTrackedFile(state: State, filePath: string, tracked: TrackedFile): void {
  state.tracked_files[filePath] = tracked;
}

export function createTrackedFile(
  sessionId: string,
  cwd: string | undefined,
  matchedTeams: string[],
  matchedRepo: string,
): TrackedFile {
  return {
    byte_offset: 0,
    session_id: sessionId,
    matched_teams: matchedTeams,
    matched_repo: matchedRepo,
    turn_number: 0,
    files_touched: [],
    cwd,
  };
}

/**
 * Build a SessionParserState from a TrackedFile (for restoring after daemon restart).
 */
export function toSessionParserState(tracked: TrackedFile): SessionParserState {
  return {
    turnNumber: tracked.turn_number,
    filesTouched: new Set(tracked.files_touched),
  };
}

/**
 * Update a TrackedFile from the current SessionParserState.
 */
export function updateFromParserState(tracked: TrackedFile, state: SessionParserState): void {
  tracked.turn_number = state.turnNumber;
  tracked.files_touched = [...state.filesTouched];
}
