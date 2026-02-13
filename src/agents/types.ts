import type { IngestEvent, SessionParserState } from "../types";

/**
 * An agent adapter provides the watcher path and JSONL parser for a specific coding agent.
 * To add support for a new agent (e.g., Codex, Gemini CLI), implement this interface.
 */
export type AgentAdapter = {
  /** Unique identifier sent as `agent_type` in every event (e.g., "claude_code", "codex") */
  agentType: string;

  /** Directory to watch for session files (e.g., ~/.claude/projects/) */
  watchDir: string;

  /** File extension filter (e.g., ".jsonl") */
  fileExtension: string;

  /** Parse a single line from a session file into zero or more IngestEvents */
  parseLine(line: string, sessionId: string, sessionState: SessionParserState): IngestEvent[];

  /** Extract session ID from a file path (e.g., filename without extension) */
  extractSessionId(filePath: string): string;
};
