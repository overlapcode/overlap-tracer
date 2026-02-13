import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseClaudeCodeLine, extractCwdFromLine } from "../src/agents/claude-code";
import type { SessionParserState } from "../src/types";

function makeState(): SessionParserState {
  return { turnNumber: 0, filesTouched: new Set() };
}

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

describe("extractCwdFromLine", () => {
  it("extracts cwd from a system init line", () => {
    const line = '{"type":"system","subtype":"init","cwd":"/Users/michael/work/crop2cash","model":"claude-sonnet-4-20250514"}';
    expect(extractCwdFromLine(line)).toBe("/Users/michael/work/crop2cash");
  });

  it("returns null for non-init lines", () => {
    const line = '{"message":{"role":"user","content":"hello"}}';
    expect(extractCwdFromLine(line)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractCwdFromLine("not json")).toBeNull();
  });

  it("returns null for init line without cwd", () => {
    const line = '{"type":"system","subtype":"init","model":"claude-sonnet-4-20250514"}';
    expect(extractCwdFromLine(line)).toBeNull();
  });

  it("extracts cwd from hyphenated project path", () => {
    const line = '{"type":"system","subtype":"init","cwd":"/Users/michael/WebstormProjects/overlap-project"}';
    expect(extractCwdFromLine(line)).toBe("/Users/michael/WebstormProjects/overlap-project");
  });
});

describe("parseClaudeCodeLine", () => {
  describe("session_start", () => {
    it("parses system init into session_start event", () => {
      const line = '{"type":"system","subtype":"init","session_id":"sess_123","cwd":"/Users/michael/work/crop2cash","model":"claude-sonnet-4-20250514","version":"1.0.20","timestamp":"2026-02-10T10:00:00.000Z"}';
      const events = parseClaudeCodeLine(line, "fallback_id", makeState());

      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("session_start");
      expect(events[0].agent_type).toBe("claude_code");
      expect(events[0].session_id).toBe("sess_123");
      expect(events[0].cwd).toBe("/Users/michael/work/crop2cash");
      expect(events[0].model).toBe("claude-sonnet-4-20250514");
      expect(events[0].agent_version).toBe("1.0.20");
      expect(events[0].repo_name).toBe(""); // Filled by tracer
      expect(events[0].user_id).toBe(""); // Filled by tracer
    });

    it("uses fallback session_id if not in init line", () => {
      const line = '{"type":"system","subtype":"init","cwd":"/test","timestamp":"2026-02-10T10:00:00.000Z"}';
      const events = parseClaudeCodeLine(line, "fallback_id", makeState());
      expect(events[0].session_id).toBe("fallback_id");
    });
  });

  describe("prompt", () => {
    it("parses user message (string content) into prompt event", () => {
      const line = '{"message":{"role":"user","content":"fix the bug"},"sessionId":"sess_123","timestamp":"2026-02-10T10:00:05.000Z"}';
      const state = makeState();
      const events = parseClaudeCodeLine(line, "sess_123", state);

      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("prompt");
      expect(events[0].agent_type).toBe("claude_code");
      expect(events[0].prompt_text).toBe("fix the bug");
      expect(events[0].turn_number).toBe(1);
      expect(state.turnNumber).toBe(1);
    });

    it("parses user message (array content) into prompt event", () => {
      const line = '{"message":{"role":"user","content":[{"type":"text","text":"run the tests"}]},"sessionId":"sess_123","timestamp":"2026-02-10T10:00:05.000Z"}';
      const events = parseClaudeCodeLine(line, "sess_123", makeState());

      expect(events).toHaveLength(1);
      expect(events[0].prompt_text).toBe("run the tests");
    });

    it("increments turn number across prompts", () => {
      const state = makeState();
      parseClaudeCodeLine('{"message":{"role":"user","content":"first"},"timestamp":"2026-02-10T10:00:05.000Z"}', "s", state);
      const events = parseClaudeCodeLine('{"message":{"role":"user","content":"second"},"timestamp":"2026-02-10T10:00:06.000Z"}', "s", state);

      expect(events[0].turn_number).toBe(2);
      expect(state.turnNumber).toBe(2);
    });
  });

  describe("file_op", () => {
    it("parses tool_use blocks into file_op events", () => {
      const line = '{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Edit","input":{"file_path":"/Users/michael/work/crop2cash/src/auth.ts"}}]},"sessionId":"sess_123","timestamp":"2026-02-10T10:00:10.000Z"}';
      const state = makeState();
      const events = parseClaudeCodeLine(line, "sess_123", state);

      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("file_op");
      expect(events[0].tool_name).toBe("Edit");
      expect(events[0].operation).toBe("modify");
      expect(events[0].file_path).toBe("/Users/michael/work/crop2cash/src/auth.ts");
      expect(state.filesTouched.has("/Users/michael/work/crop2cash/src/auth.ts")).toBe(true);
    });

    it("parses multiple tool_use blocks from one line", () => {
      const line = '{"message":{"role":"assistant","content":[{"type":"text","text":"Let me check."},{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/a.ts"}},{"type":"tool_use","id":"tu_2","name":"Write","input":{"file_path":"/b.ts"}}]},"timestamp":"2026-02-10T10:00:10.000Z"}';
      const events = parseClaudeCodeLine(line, "sess_123", makeState());

      expect(events).toHaveLength(2);
      expect(events[0].tool_name).toBe("Read");
      expect(events[0].operation).toBe("read");
      expect(events[1].tool_name).toBe("Write");
      expect(events[1].operation).toBe("create");
    });

    it("parses Bash tool with command", () => {
      const line = '{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"npm test"}}]},"timestamp":"2026-02-10T10:00:10.000Z"}';
      const events = parseClaudeCodeLine(line, "sess_123", makeState());

      expect(events).toHaveLength(1);
      expect(events[0].tool_name).toBe("Bash");
      expect(events[0].operation).toBe("execute");
      expect(events[0].bash_command).toBe("npm test");
      expect(events[0].file_path).toBe("(bash)");
    });

    it("parses Grep/Glob with sentinel file paths", () => {
      const line = '{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Grep","input":{"pattern":"TODO"}}]},"timestamp":"2026-02-10T10:00:10.000Z"}';
      const events = parseClaudeCodeLine(line, "sess_123", makeState());
      expect(events[0].file_path).toBe("(grep)");
    });

    it("ignores unknown tool names", () => {
      const line = '{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"UnknownTool","input":{}}]},"timestamp":"2026-02-10T10:00:10.000Z"}';
      const events = parseClaudeCodeLine(line, "sess_123", makeState());
      expect(events).toHaveLength(0);
    });
  });

  describe("session_end", () => {
    it("parses result into session_end event", () => {
      const state = makeState();
      state.filesTouched.add("src/auth.ts");

      const line = '{"type":"result","session_id":"sess_123","timestamp":"2026-02-10T10:01:00.000Z","total_cost_usd":0.042,"duration_ms":55000,"num_turns":1,"result":"Fixed the bug.","usage":{"input_tokens":15000,"output_tokens":2500,"cache_creation_input_tokens":5000,"cache_read_input_tokens":3000}}';
      const events = parseClaudeCodeLine(line, "sess_123", state);

      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("session_end");
      expect(events[0].agent_type).toBe("claude_code");
      expect(events[0].total_cost_usd).toBe(0.042);
      expect(events[0].duration_ms).toBe(55000);
      expect(events[0].num_turns).toBe(1);
      expect(events[0].total_input_tokens).toBe(15000);
      expect(events[0].total_output_tokens).toBe(2500);
      expect(events[0].cache_creation_tokens).toBe(5000);
      expect(events[0].cache_read_tokens).toBe(3000);
      expect(events[0].result_summary).toBe("Fixed the bug.");
      expect(events[0].files_touched).toEqual(["src/auth.ts"]);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for malformed JSON", () => {
      expect(parseClaudeCodeLine("not json", "s", makeState())).toEqual([]);
    });

    it("returns empty array for unknown message types", () => {
      expect(parseClaudeCodeLine('{"type":"unknown"}', "s", makeState())).toEqual([]);
    });

    it("returns empty array for empty content", () => {
      expect(parseClaudeCodeLine('{"message":{"role":"user","content":null}}', "s", makeState())).toEqual([]);
    });
  });

  describe("full fixture parsing", () => {
    it("parses simple-session.jsonl correctly", () => {
      const content = readFileSync(join(FIXTURES_DIR, "simple-session.jsonl"), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      const state = makeState();
      const allEvents = lines.flatMap((line) => parseClaudeCodeLine(line, "sess_abc123", state));

      // init + prompt + 2 file_ops (Read, Edit) + result
      expect(allEvents.length).toBe(5);
      expect(allEvents[0].event_type).toBe("session_start");
      expect(allEvents[1].event_type).toBe("prompt");
      expect(allEvents[2].event_type).toBe("file_op");
      expect(allEvents[3].event_type).toBe("file_op");
      expect(allEvents[4].event_type).toBe("session_end");

      // All have agent_type
      for (const event of allEvents) {
        expect(event.agent_type).toBe("claude_code");
      }
    });

    it("parses multi-turn session with correct turn numbers", () => {
      const content = readFileSync(join(FIXTURES_DIR, "multi-turn-session.jsonl"), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      const state = makeState();
      const allEvents = lines.flatMap((line) => parseClaudeCodeLine(line, "sess_multi", state));

      const prompts = allEvents.filter((e) => e.event_type === "prompt");
      expect(prompts).toHaveLength(3);
      expect(prompts[0].turn_number).toBe(1);
      expect(prompts[1].turn_number).toBe(2);
      expect(prompts[2].turn_number).toBe(3);
    });
  });
});
