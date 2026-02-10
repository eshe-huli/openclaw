#!/bin/bash
# Post-build patch: fix Bun-compiled import.meta.require for Node/jiti compatibility
# Run after `bun build` to ensure the dist works with OpenClaw's jiti loader.
set -e

DIST_DIR="$(dirname "$0")/dist"

if [ ! -d "$DIST_DIR" ]; then
  echo "No dist/ directory found — skipping patch."
  exit 0
fi

for f in "$DIST_DIR"/*.js; do
  if grep -q 'import\.meta\.require' "$f" 2>/dev/null; then
    echo "Patching Bun import.meta.require in $(basename "$f")..."
    sed -i '' 's|var __require = .*import\.meta.*|var __require = typeof require !== "undefined" ? require : function(m) { throw new Error("require not available: " + m); };|' "$f"
  fi
done

echo "Post-build patch complete."
