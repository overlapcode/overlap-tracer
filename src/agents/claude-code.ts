import { join, basename } from "path";
import { homedir, hostname } from "os";
import { execSync } from "child_process";
import type { AgentAdapter } from "./types";
import type { IngestEvent, SessionParserState } from "../types";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const AGENT_TYPE = "claude_code";

const TRACKED_TOOLS = ["Write", "Edit", "Read", "Bash", "Grep", "Glob", "MultiEdit", "NotebookEdit"];

export const claudeCodeAdapter: AgentAdapter = {
  agentType: AGENT_TYPE,
  watchDir: CLAUDE_PROJECTS_DIR,
  fileExtension: ".jsonl",
  parseLine: parseClaudeCodeLine,
  extractSessionId: (filePath: string) => basename(filePath, ".jsonl"),
};

/**
 * Extract the `cwd` from a Claude Code JSONL init line.
 * Returns null if the line is not an init line or has no cwd.
 */
export function extractCwdFromLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.type === "system" && parsed.subtype === "init" && parsed.cwd) {
      return parsed.cwd;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Parse a single Claude Code JSONL line into zero or more IngestEvents.
 */
export function parseClaudeCodeLine(
  line: string,
  sessionId: string,
  sessionState: SessionParserState,
): IngestEvent[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  // System init → session_start
  if (parsed.type === "system" && parsed.subtype === "init") {
    return [{
      event_type: "session_start",
      agent_type: AGENT_TYPE,
      session_id: (parsed.session_id as string) || sessionId,
      timestamp: (parsed.timestamp as string) || new Date().toISOString(),
      cwd: parsed.cwd as string | undefined,
      git_branch: getGitBranch(parsed.cwd as string | undefined),
      model: parsed.model as string | undefined,
      agent_version: parsed.version as string | undefined,
      hostname: hostname(),
      device_name: hostname(),
      is_remote: isRemoteSession(parsed),
      repo_name: "",
      user_id: "",
    }];
  }

  const message = parsed.message as Record<string, unknown> | undefined;

  // User message → prompt
  if (message?.role === "user") {
    const promptText = extractUserPromptText(message.content);
    if (promptText) {
      sessionState.turnNumber++;
      return [{
        event_type: "prompt",
        agent_type: AGENT_TYPE,
        session_id: (parsed.sessionId as string) || sessionId,
        timestamp: (parsed.timestamp as string) || new Date().toISOString(),
        prompt_text: promptText,
        turn_number: sessionState.turnNumber,
        repo_name: "",
        user_id: "",
      }];
    }
  }

  // Assistant message with tool_use → file_op
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    const events: IngestEvent[] = [];
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === "tool_use") {
        const event = extractFileOp(block, parsed, sessionId, sessionState);
        if (event) events.push(event);
      }
    }
    return events;
  }

  // Result → session_end
  if (parsed.type === "result") {
    const usage = parsed.usage as Record<string, unknown> | undefined;
    return [{
      event_type: "session_end",
      agent_type: AGENT_TYPE,
      session_id: (parsed.session_id as string) || sessionId,
      timestamp: (parsed.timestamp as string) || new Date().toISOString(),
      total_cost_usd: parsed.total_cost_usd as number | undefined,
      duration_ms: parsed.duration_ms as number | undefined,
      num_turns: parsed.num_turns as number | undefined,
      total_input_tokens: usage?.input_tokens as number | undefined,
      total_output_tokens: usage?.output_tokens as number | undefined,
      cache_creation_tokens: usage?.cache_creation_input_tokens as number | undefined,
      cache_read_tokens: usage?.cache_read_input_tokens as number | undefined,
      result_summary: parsed.result as string | undefined,
      files_touched: [...sessionState.filesTouched],
      repo_name: "",
      user_id: "",
    }];
  }

  return [];
}

function extractUserPromptText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlocks = content
      .filter((b: Record<string, unknown>) => b.type === "text" && typeof b.text === "string")
      .map((b: Record<string, unknown>) => b.text as string);
    return textBlocks.length > 0 ? textBlocks.join("\n") : null;
  }
  return null;
}

function extractFileOp(
  block: Record<string, unknown>,
  parent: Record<string, unknown>,
  sessionId: string,
  sessionState: SessionParserState,
): IngestEvent | null {
  const toolName = block.name as string;
  const input = (block.input || {}) as Record<string, unknown>;

  if (!TRACKED_TOOLS.includes(toolName)) {
    return null;
  }

  let filePath = (input.file_path || input.path || null) as string | null;
  let operation = "read";
  let bashCommand: string | null = null;

  switch (toolName) {
    case "Write": operation = "create"; break;
    case "Edit": operation = "modify"; break;
    case "MultiEdit": operation = "modify"; break;
    case "NotebookEdit":
      operation = "modify";
      filePath = (input.notebook_path as string) || filePath;
      break;
    case "Read": operation = "read"; break;
    case "Bash":
      operation = "execute";
      bashCommand = input.command as string;
      filePath = filePath || "(bash)";
      break;
    case "Grep": operation = "search"; filePath = filePath || "(grep)"; break;
    case "Glob": operation = "search"; filePath = filePath || "(glob)"; break;
  }

  if (filePath && filePath !== "(bash)" && filePath !== "(grep)" && filePath !== "(glob)") {
    sessionState.filesTouched.add(filePath);
  }

  return {
    event_type: "file_op",
    agent_type: AGENT_TYPE,
    session_id: (parent.sessionId as string) || sessionId,
    timestamp: (parent.timestamp as string) || new Date().toISOString(),
    tool_name: toolName,
    file_path: filePath ?? undefined,
    operation,
    bash_command: bashCommand ?? undefined,
    repo_name: "",
    user_id: "",
  };
}

function getGitBranch(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 3000 })
      .toString().trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function isRemoteSession(parsed: Record<string, unknown>): boolean {
  const env = parsed.env as Record<string, unknown> | undefined;
  return !!(env?.SSH_CLIENT || env?.CODESPACES || env?.REMOTE_CONTAINERS);
}
