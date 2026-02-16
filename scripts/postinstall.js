#!/usr/bin/env node
/**
 * Postinstall script for the overlapdev npm package.
 * Downloads the correct pre-compiled binary for the user's platform.
 */
import { existsSync, mkdirSync, chmodSync, createWriteStream, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = "overlapcode/overlap-tracer";
const PKG = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
const BIN_DIR = join(__dirname, "..", "bin");
const BINARY_PATH = join(BIN_DIR, process.platform === "win32" ? "overlap.exe" : "overlap");

function getPlatformTarget() {
  const platform = process.platform;
  const arch = process.arch;

  const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap = { x64: "x64", arm64: "arm64" };

  const p = platformMap[platform];
  const a = archMap[arch];

  if (!p || !a) {
    console.error(`Unsupported platform: ${platform}-${arch}`);
    process.exit(1);
  }

  const ext = platform === "win32" ? ".exe" : "";
  return `overlap-${p}-${a}${ext}`;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      resolve(res);
    }).on("error", reject);
  });
}

function getVersion() {
  return `v${PKG.version}`;
}

async function download(url, dest) {
  const res = await httpsGet(url);
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    res.pipe(file);
    file.on("finish", () => { file.close(); resolve(); });
    file.on("error", reject);
  });
}

async function main() {
  // Skip if binary already exists (e.g., CI or manual install)
  if (existsSync(BINARY_PATH)) {
    return;
  }

  const target = getPlatformTarget();
  console.log(`[overlap] Downloading binary for ${process.platform}-${process.arch}...`);

  const version = getVersion();

  const url = `https://github.com/${REPO}/releases/download/${version}/${target}`;

  mkdirSync(BIN_DIR, { recursive: true });

  try {
    await download(url, BINARY_PATH);
    if (process.platform !== "win32") {
      chmodSync(BINARY_PATH, 0o755);
    }
    console.log(`[overlap] ✓ Installed ${target} (${version})`);
  } catch (err) {
    console.warn(`[overlap] Binary download failed: ${err.message}`);
    console.warn(`[overlap] Download manually from: https://github.com/${REPO}/releases/tag/${version}`);
  }
}

main();
