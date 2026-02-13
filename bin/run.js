#!/usr/bin/env node
/**
 * npm wrapper — runs the pre-compiled overlap binary.
 * The binary is downloaded during postinstall.
 */
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ext = process.platform === "win32" ? ".exe" : "";
const binaryPath = join(__dirname, `overlap${ext}`);

if (!existsSync(binaryPath)) {
  console.error("Error: Overlap binary not found.");
  console.error("Try reinstalling: npm install -g overlapdev");
  console.error("Or download directly: curl -fsSL https://overlap.dev/install.sh | sh");
  process.exit(1);
}

try {
  execFileSync(binaryPath, process.argv.slice(2), { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
