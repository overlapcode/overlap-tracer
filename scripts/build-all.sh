#!/bin/bash
set -e

echo "Building Overlap tracer for all platforms..."

OUTDIR="dist/bin"
mkdir -p "$OUTDIR"

TARGETS=(
  "bun-darwin-arm64:overlap-darwin-arm64"
  "bun-darwin-x64:overlap-darwin-x64"
  "bun-linux-x64:overlap-linux-x64"
  "bun-linux-arm64:overlap-linux-arm64"
  "bun-windows-x64:overlap-windows-x64.exe"
)

for entry in "${TARGETS[@]}"; do
  TARGET="${entry%%:*}"
  OUTFILE="${entry##*:}"
  echo "  Building $OUTFILE ($TARGET)..."
  bun build src/index.ts --compile --target="$TARGET" --outfile "$OUTDIR/$OUTFILE"
done

echo ""
echo "Done! Binaries in $OUTDIR/:"
ls -lh "$OUTDIR/"
