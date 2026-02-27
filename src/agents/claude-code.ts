import { join, basename } from "path";
import { homedir, hostname } from "os";
import { execSync } from "child_process";
import { readFileSync } from "fs";
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
 * Extract the `cwd` from a Claude Code JSONL line.
 * Claude Code puts `cwd` on most line types (user, assistant, progress).
 * Returns null if the line has no cwd field.
 */
export function extractCwdFromLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.cwd && typeof parsed.cwd === "string") {
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

  // Capture gitBranch/cwd/model from any line (they often appear on later lines, not the first)
  if (parsed.gitBranch && typeof parsed.gitBranch === "string" && !sessionState._gitBranch) {
    sessionState._gitBranch = parsed.gitBranch;
  }
  if (parsed.cwd && typeof parsed.cwd === "string" && !sessionState._cwd) {
    sessionState._cwd = parsed.cwd;
  }
  // Model appears on assistant message lines at message.model
  const msgForModel = parsed.message as Record<string, unknown> | undefined;
  if (msgForModel?.model && typeof msgForModel.model === "string" && !sessionState._model) {
    sessionState._model = msgForModel.model;
  }

  // First line with cwd + sessionId → session_start (Claude Code has no system/init line)
  if (parsed.cwd && sessionState.turnNumber === 0 && !sessionState._sessionStartEmitted) {
    sessionState._sessionStartEmitted = true;
    const branch = sessionState._gitBranch || (parsed.gitBranch as string) || getGitBranch(parsed.cwd as string | undefined);
    if (branch) {
      sessionState._gitBranch = branch;
      sessionState._branchUpdateEmitted = true; // Already have branch, no re-emit needed
    }
    if (sessionState._model) {
      sessionState._modelUpdateEmitted = true; // Already have model, no re-emit needed
    }
    const startEvent: IngestEvent = {
      event_type: "session_start",
      agent_type: AGENT_TYPE,
      session_id: (parsed.sessionId as string) || (parsed.session_id as string) || sessionId,
      timestamp: (parsed.timestamp as string) || new Date().toISOString(),
      cwd: parsed.cwd as string | undefined,
      git_branch: branch,
      model: sessionState._model || (parsed.model as string | undefined),
      agent_version: parsed.version as string | undefined,
      hostname: hostname(),
      device_name: hostname(),
      is_remote: isRemoteSession(parsed),
      repo_name: "",
      user_id: "",
    };

    // If this line is also a user message, emit both session_start + prompt
    const message = parsed.message as Record<string, unknown> | undefined;
    if (message?.role === "user") {
      const promptText = extractUserPromptText(message.content);
      if (promptText) {
        sessionState.turnNumber++;
        return [startEvent, {
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

    return [startEvent];
  }

  // If session_start was emitted without branch or model, re-emit once we discover them
  const backfillEvents: IngestEvent[] = [];
  const needsBranchBackfill = sessionState._sessionStartEmitted && !sessionState._branchUpdateEmitted && sessionState._gitBranch;
  const needsModelBackfill = sessionState._sessionStartEmitted && !sessionState._modelUpdateEmitted && sessionState._model;
  if (needsBranchBackfill || needsModelBackfill) {
    if (needsBranchBackfill) sessionState._branchUpdateEmitted = true;
    if (needsModelBackfill) sessionState._modelUpdateEmitted = true;
    backfillEvents.push({
      event_type: "session_start",
      agent_type: AGENT_TYPE,
      session_id: (parsed.sessionId as string) || (parsed.session_id as string) || sessionId,
      timestamp: (parsed.timestamp as string) || new Date().toISOString(),
      cwd: sessionState._cwd,
      git_branch: sessionState._gitBranch,
      model: sessionState._model,
      repo_name: "",
      user_id: "",
    });
  }

  const message = parsed.message as Record<string, unknown> | undefined;

  // User message → prompt
  if (message?.role === "user") {
    const promptText = extractUserPromptText(message.content);
    if (promptText) {
      sessionState.turnNumber++;
      return [...backfillEvents, {
        event_type: "prompt" as const,
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

  // Assistant message → agent_response (text/thinking) + file_op (tool_use)
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    const events: IngestEvent[] = [...backfillEvents];
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({
          event_type: "agent_response",
          agent_type: AGENT_TYPE,
          session_id: (parsed.sessionId as string) || sessionId,
          timestamp: (parsed.timestamp as string) || new Date().toISOString(),
          response_text: block.text,
          response_type: "text",
          turn_number: sessionState.turnNumber,
          repo_name: "",
          user_id: "",
        });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        events.push({
          event_type: "agent_response",
          agent_type: AGENT_TYPE,
          session_id: (parsed.sessionId as string) || sessionId,
          timestamp: (parsed.timestamp as string) || new Date().toISOString(),
          response_text: block.thinking,
          response_type: "thinking",
          turn_number: sessionState.turnNumber,
          repo_name: "",
          user_id: "",
        });
      } else if (block.type === "tool_use") {
        const event = extractFileOp(block, parsed, sessionId, sessionState);
        if (event) events.push(event);
      }
    }
    return events;
  }

  // Result → session_end
  if (parsed.type === "result") {
    const usage = parsed.usage as Record<string, unknown> | undefined;
    return [...backfillEvents, {
      event_type: "session_end" as const,
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

  return backfillEvents;
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

  // Capture old_string/new_string for Edit/MultiEdit
  const oldString = (toolName === "Edit" || toolName === "MultiEdit")
    ? (input.old_string as string) || undefined
    : undefined;
  const newString = (toolName === "Edit" || toolName === "MultiEdit")
    ? (input.new_string as string) || undefined
    : undefined;

  // Compute line numbers from the file. By the time the tracer processes
  // the JSONL line, the edit has already been applied, so the file contains
  // new_string (not old_string). Search for new_string first, fall back to old_string.
  let startLine: number | undefined;
  let endLine: number | undefined;
  if (filePath && filePath !== "(bash)" && (newString || oldString)) {
    const lines = findLineRange(filePath, newString ?? oldString!);
    if (lines) {
      startLine = lines.start;
      endLine = lines.end;
    }
  }

  return {
    event_type: "file_op",
    agent_type: AGENT_TYPE,
    session_id: (parent.sessionId as string) || sessionId,
    timestamp: (parent.timestamp as string) || new Date().toISOString(),
    tool_name: toolName,
    file_path: filePath ?? undefined,
    operation,
    start_line: startLine,
    end_line: endLine,
    bash_command: bashCommand ?? undefined,
    old_string: oldString,
    new_string: newString,
    repo_name: "",
    user_id: "",
  };
}

/**
 * Find the line range of `needle` in a file. Returns 1-indexed start/end lines,
 * or null if the file can't be read or the string isn't found.
 */
function findLineRange(filePath: string, needle: string): { start: number; end: number } | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const idx = content.indexOf(needle);
    if (idx === -1) return null;
    const startLine = content.slice(0, idx).split("\n").length;
    const needleLines = needle.split("\n").length;
    return { start: startLine, end: startLine + needleLines - 1 };
  } catch {
    return null;
  }
}

function getGitBranch(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 3000, stdio: ["pipe", "pipe", "pipe"] })
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
