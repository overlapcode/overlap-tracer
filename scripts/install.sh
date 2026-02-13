#!/bin/bash
# Overlap tracer installer
# Usage: curl -fsSL https://overlap.dev/install.sh | sh
set -e

REPO="overlapcode/overlap-tracer"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="overlap"

# Detect OS and architecture
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) PLATFORM="darwin" ;;
    Linux)  PLATFORM="linux" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *)
      echo "Error: Unsupported operating system: $OS"
      exit 1
      ;;
  esac

  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)
      echo "Error: Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac

  SUFFIX=""
  if [ "$PLATFORM" = "windows" ]; then
    SUFFIX=".exe"
  fi

  ASSET_NAME="overlap-${PLATFORM}-${ARCH}${SUFFIX}"
}

# Get latest release URL
get_download_url() {
  LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
  if [ -z "$LATEST" ]; then
    echo "Error: Could not determine latest release."
    exit 1
  fi
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST/$ASSET_NAME"
}

main() {
  echo ""
  echo "  Overlap tracer installer"
  echo ""

  detect_platform
  echo "  Platform: ${PLATFORM}-${ARCH}"

  get_download_url
  echo "  Version:  $LATEST"
  echo "  Binary:   $ASSET_NAME"
  echo ""

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  # Download
  echo "  Downloading..."
  curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/$BINARY_NAME$SUFFIX"
  chmod +x "$INSTALL_DIR/$BINARY_NAME$SUFFIX"

  echo "  ✓ Installed to $INSTALL_DIR/$BINARY_NAME$SUFFIX"

  # Check if install dir is in PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -q "^$INSTALL_DIR$"; then
    echo ""
    echo "  Add this to your shell config to use 'overlap' from anywhere:"
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
  fi

  echo ""
  echo "  Get started:"
  echo "    overlap join"
  echo ""
}

main
