import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const LABEL = "dev.overlap.tracer";

function getBinaryPath(): string {
  // In Bun-compiled binaries, process.argv[0] is "bun" — use execPath instead
  const execPath = process.execPath;
  if (execPath && existsSync(execPath)) return execPath;

  if (process.platform === "win32") {
    return join(homedir(), ".overlap", "bin", "overlap.exe");
  }
  return "/usr/local/bin/overlap";
}

// ── macOS: launchd ─────────────────────────────────────────────────────

function getMacPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function installMacService(): void {
  const binaryPath = getBinaryPath();
  const logsDir = join(homedir(), ".overlap", "logs");
  mkdirSync(logsDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${binaryPath}</string>
        <string>daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logsDir}/tracer.log</string>
    <key>StandardErrorPath</key>
    <string>${logsDir}/tracer.error.log</string>
</dict>
</plist>`;

  const plistPath = getMacPlistPath();
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(plistPath, plist);

  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" });
  } catch {
    // May already be loaded
  }
}

function uninstallMacService(): void {
  const plistPath = getMacPlistPath();
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
  } catch { /* not loaded */ }
  try {
    unlinkSync(plistPath);
  } catch { /* not found */ }
}

// ── Linux: systemd user service ────────────────────────────────────────

function getLinuxServicePath(): string {
  return join(homedir(), ".config", "systemd", "user", "overlap-tracer.service");
}

function installLinuxService(): void {
  const binaryPath = getBinaryPath();

  const unit = `[Unit]
Description=Overlap tracer
After=network.target

[Service]
ExecStart=${binaryPath} daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target`;

  const servicePath = getLinuxServicePath();
  const serviceDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(servicePath, unit);

  try {
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
    execSync("systemctl --user enable overlap-tracer", { stdio: "pipe" });
    execSync("systemctl --user start overlap-tracer", { stdio: "pipe" });
    // Enable linger so service runs after logout
    execSync(`loginctl enable-linger ${process.env.USER || ""}`, { stdio: "pipe" });
  } catch (err) {
    console.error("[service] systemd setup warning:", err);
  }
}

function uninstallLinuxService(): void {
  try {
    execSync("systemctl --user stop overlap-tracer", { stdio: "pipe" });
    execSync("systemctl --user disable overlap-tracer", { stdio: "pipe" });
  } catch { /* not running */ }
  try {
    unlinkSync(getLinuxServicePath());
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  } catch { /* not found */ }
}

// ── Windows: Task Scheduler ────────────────────────────────────────────

function installWindowsService(): void {
  const binaryPath = getBinaryPath();
  try {
    execSync(
      `schtasks /Create /TN "OverlapTracer" /TR "\\"${binaryPath}\\" daemon" /SC ONLOGON /RL LIMITED /F`,
      { stdio: "pipe" },
    );
  } catch (err) {
    console.error("[service] Task Scheduler setup warning:", err);
  }
}

function uninstallWindowsService(): void {
  try {
    execSync('schtasks /Delete /TN "OverlapTracer" /F', { stdio: "pipe" });
  } catch { /* not found */ }
}

// ── Public API ─────────────────────────────────────────────────────────

export function installService(): void {
  switch (process.platform) {
    case "darwin": installMacService(); break;
    case "linux": installLinuxService(); break;
    case "win32": installWindowsService(); break;
    default:
      console.warn(`[service] Unsupported platform: ${process.platform}. Skipping service registration.`);
  }
}

export function uninstallService(): void {
  switch (process.platform) {
    case "darwin": uninstallMacService(); break;
    case "linux": uninstallLinuxService(); break;
    case "win32": uninstallWindowsService(); break;
  }
}

export function isServiceInstalled(): boolean {
  switch (process.platform) {
    case "darwin": return existsSync(getMacPlistPath());
    case "linux": return existsSync(getLinuxServicePath());
    case "win32": {
      try {
        execSync('schtasks /Query /TN "OverlapTracer"', { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    }
    default: return false;
  }
}
