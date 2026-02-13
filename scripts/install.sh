#!/bin/bash
# Overlap tracer installer
# Usage: curl -fsSL https://overlap.dev/install.sh | sh
#
# This is the canonical source. The same script is hosted at:
# - https://overlap.dev/install.sh (overlap-site/public/install.sh)
# - https://github.com/overlapcode/overlap-tracer/blob/main/scripts/install.sh
set -e

REPO="overlapcode/overlap-tracer"
BINARY_NAME="overlap"

# Colors (only if terminal supports it)
if [ -t 1 ]; then
  BOLD="\033[1m"
  DIM="\033[2m"
  GREEN="\033[32m"
  RED="\033[31m"
  RESET="\033[0m"
else
  BOLD="" DIM="" GREEN="" RED="" RESET=""
fi

info()  { echo -e "  ${BOLD}$1${RESET}"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
fail()  { echo -e "  ${RED}✗${RESET} $1"; exit 1; }

# ── Detect platform ──────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) PLATFORM="darwin" ;;
    Linux)  PLATFORM="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
      fail "Windows detected. Download the binary manually from GitHub Releases:
    https://github.com/$REPO/releases/latest"
      ;;
    *) fail "Unsupported OS: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) fail "Unsupported architecture: $ARCH" ;;
  esac

  ASSET_NAME="overlap-${PLATFORM}-${ARCH}"
}

# ── Find install directory ───────────────────────────────────────────────

find_install_dir() {
  if [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
    INSTALL_DIR="$HOME/.local/bin"
  elif [ -w "/usr/local/bin" ]; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
  fi
}

# ── Get latest release ───────────────────────────────────────────────────

get_latest_version() {
  LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep '"tag_name"' \
    | sed -E 's/.*"([^"]+)".*/\1/')

  if [ -z "$LATEST" ]; then
    fail "Could not determine latest release. Check https://github.com/$REPO/releases"
  fi

  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST/$ASSET_NAME"
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
  echo ""
  info "Overlap tracer installer"
  echo ""

  detect_platform
  find_install_dir
  get_latest_version

  echo -e "  Platform:  ${DIM}${PLATFORM}-${ARCH}${RESET}"
  echo -e "  Version:   ${DIM}${LATEST}${RESET}"
  echo -e "  Install:   ${DIM}${INSTALL_DIR}/${BINARY_NAME}${RESET}"
  echo ""

  # Download
  echo -e "  Downloading ${ASSET_NAME}..."
  HTTP_CODE=$(curl -fsSL -w "%{http_code}" "$DOWNLOAD_URL" -o "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || true)

  if [ ! -f "$INSTALL_DIR/$BINARY_NAME" ] || [ "$HTTP_CODE" = "404" ]; then
    rm -f "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null
    fail "Download failed (HTTP $HTTP_CODE). Binary may not exist for ${PLATFORM}-${ARCH}.
    Check: https://github.com/$REPO/releases/tag/$LATEST"
  fi

  chmod +x "$INSTALL_DIR/$BINARY_NAME"
  ok "Installed to $INSTALL_DIR/$BINARY_NAME"

  # Check PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo -e "  ${BOLD}Add to your PATH:${RESET}"
    SHELL_NAME=$(basename "$SHELL" 2>/dev/null || echo "bash")
    case "$SHELL_NAME" in
      zsh)  echo "    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
      fish) echo "    fish_add_path $INSTALL_DIR" ;;
      *)    echo "    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
    esac
  fi

  echo ""
  info "Get started:"
  echo "    overlap join"
  echo ""
}

main
