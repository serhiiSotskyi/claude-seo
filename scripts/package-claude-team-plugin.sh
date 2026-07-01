#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
BUILD_DIR="$DIST_DIR/claude-seo-team-plugin"
ZIP_PATH="$DIST_DIR/claude-seo-team-plugin.zip"
SYNC_DIR="$ROOT_DIR/plugins/claude-seo-team"

rm -rf "$BUILD_DIR" "$ZIP_PATH"
mkdir -p "$BUILD_DIR/.claude-plugin"
mkdir -p "$BUILD_DIR/extensions/dataforseo/skills"
mkdir -p "$BUILD_DIR/extensions/dataforseo/agents"

cp "$ROOT_DIR/packaging/claude-team-plugin/plugin.json" \
  "$BUILD_DIR/.claude-plugin/plugin.json"
cp -R "$ROOT_DIR/seo" "$BUILD_DIR/seo"
cp -R "$ROOT_DIR/skills" "$BUILD_DIR/skills"
cp -R "$ROOT_DIR/agents" "$BUILD_DIR/agents"
cp -R "$ROOT_DIR/scripts" "$BUILD_DIR/scripts"
cp -R "$ROOT_DIR/schema" "$BUILD_DIR/schema"
cp -R "$ROOT_DIR/extensions/dataforseo/skills/seo-dataforseo" \
  "$BUILD_DIR/extensions/dataforseo/skills/seo-dataforseo"
cp "$ROOT_DIR/extensions/dataforseo/agents/seo-dataforseo.md" \
  "$BUILD_DIR/extensions/dataforseo/agents/seo-dataforseo.md"

find "$BUILD_DIR" -type d -name "__pycache__" -prune -exec rm -rf {} +
find "$BUILD_DIR" -type f \( -name "*.pyc" -o -name ".DS_Store" \) -delete
rm -f "$BUILD_DIR/scripts/package-claude-team-plugin.sh"

rm -rf "$SYNC_DIR"
mkdir -p "$(dirname "$SYNC_DIR")"
cp -R "$BUILD_DIR" "$SYNC_DIR"

(
  cd "$DIST_DIR"
  zip -qr "$ZIP_PATH" "claude-seo-team-plugin"
)

echo "$ZIP_PATH"
