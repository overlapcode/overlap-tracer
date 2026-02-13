// ── Event Types (shared with Overlap server) ────────────────────────────

export type IngestEventType = "session_start" | "session_end" | "file_op" | "prompt";

export type IngestEvent = {
  // Required on ALL events
  session_id: string;
  timestamp: string;
  event_type: IngestEventType;
  user_id: string;
  repo_name: string;
  agent_type: string;

  // session_start
  cwd?: string;
  git_branch?: string;
  model?: string;
  agent_version?: string;
  hostname?: string;
  device_name?: string;
  is_remote?: boolean;

  // file_op
  tool_name?: string;
  file_path?: string;
  operation?: string;
  bash_command?: string;

  // prompt
  prompt_text?: string;
  turn_number?: number;

  // session_end
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  result_summary?: string;
  files_touched?: string[];
};

// ── Config ───────────────────────────────────────────────────────────────

export type TeamConfig = {
  name: string;
  instance_url: string;
  user_token: string;
  user_id: string;
};

export type TracerSettings = {
  batch_interval_ms: number;
  max_batch_size: number;
  repo_sync_interval_ms: number;
};

export type Config = {
  teams: TeamConfig[];
  tracer: TracerSettings;
};

// ── State ────────────────────────────────────────────────────────────────

export type TrackedFile = {
  byte_offset: number;
  session_id: string;
  matched_teams: string[];
  matched_repo: string;
  turn_number: number;
  files_touched: string[];
  cwd: string | undefined;
};

export type State = {
  tracked_files: Record<string, TrackedFile>;
};

// ── Cache ────────────────────────────────────────────────────────────────

export type RepoListEntry = {
  repos: string[];
  fetched_at: string;
};

export type Cache = {
  repo_lists: Record<string, RepoListEntry>;
  git_remotes: Record<string, string>;
};

// ── Auth ─────────────────────────────────────────────────────────────────

export type VerifyResponse = {
  user_id: string;
  display_name: string;
  team_name: string;
  role: "admin" | "member";
};

// ── Session Parser State ─────────────────────────────────────────────────

export type SessionParserState = {
  turnNumber: number;
  filesTouched: Set<string>;
};
