/**
 * Line-level enrichment for file operations.
 *
 * Resolves new_string to line ranges and detects enclosing function names
 * by reading the local file on the developer's machine.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import type { IngestEvent } from "./types";

// Patterns to detect function/class declarations (covers most languages)
const FUNCTION_PATTERNS = [
  // JavaScript/TypeScript: function foo, async function foo, const foo =, export function
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/,
  // Class methods: foo(, async foo(
  /^\s+(?:async\s+)?(\w+)\s*\(/,
  // Python: def foo
  /def\s+(\w+)\s*\(/,
  // Rust: fn foo, pub fn foo
  /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  // Go: func foo, func (r *T) foo
  /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/,
  // Java/Kotlin/C#: public void foo(, fun foo(
  /(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:\w+\s+)+(\w+)\s*\(/,
  // Ruby: def foo
  /def\s+(\w+)/,
  // PHP: function foo
  /function\s+(\w+)\s*\(/,
  // Class declarations
  /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
];

/**
 * Enrich a file_op event with line range and function name.
 * Reads the local file to resolve new_string position.
 * Silently returns if enrichment fails (fields stay undefined).
 */
export function enrichLineData(event: IngestEvent, cwd: string | undefined): void {
  if (!event.file_path || !cwd) return;

  const newString = event.__new_string;
  const toolName = event.tool_name;

  // For Write: whole file was created/replaced
  if (toolName === "Write") {
    event.start_line = 1;
    // end_line stays null (whole file)
    return;
  }

  // For Edit/MultiEdit: find new_string in the file
  if (!newString) return;

  try {
    const absPath = resolve(cwd, event.file_path);
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");

    // Find where new_string starts in the file
    const idx = content.indexOf(newString);
    if (idx === -1) return;

    // Count lines up to the match
    const beforeMatch = content.substring(0, idx);
    const startLine = beforeMatch.split("\n").length;
    const endLine = startLine + newString.split("\n").length - 1;

    event.start_line = startLine;
    event.end_line = endLine;

    // Walk upward from startLine to find enclosing function/class
    event.function_name = findEnclosingFunction(lines, startLine - 1);
  } catch {
    // File not readable, moved, or deleted — skip enrichment
  }
}

/**
 * Walk upward from a line index to find the nearest function/class declaration.
 */
export function findEnclosingFunction(lines: string[], fromIndex: number): string | undefined {
  for (let i = fromIndex; i >= 0; i--) {
    const line = lines[i];
    for (const pattern of FUNCTION_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return undefined;
}
