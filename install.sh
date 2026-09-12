#!/usr/bin/env bash
# Install the IDE diff gate: VS Code extension + Command Code mod.
# Idempotent, no sudo, no build step.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
EXT_ROOT="${VSCODE_EXT_DIR:-$HOME/.vscode/extensions}"
EXT_DEST="$EXT_ROOT/wiszel.ide-diff-0.0.1"
MOD_DEST="$HOME/.commandcode/mods/ide-diff-gate.ts"

mkdir -p "$EXT_ROOT"
rm -rf "$EXT_DEST"
cp -r "$REPO/extension" "$EXT_DEST"

mkdir -p "$(dirname "$MOD_DEST")"
cp "$REPO/mod/ide-diff-gate.ts" "$MOD_DEST"

echo "extension → $EXT_DEST"
echo "mod       → $MOD_DEST"
echo
echo "next: reload the VS Code window, then run /reload inside cmd"
echo "      /ide-diff status   — verify the bridge is found"
echo
echo "Cursor/Windsurf: VSCODE_EXT_DIR=~/.cursor/extensions $0"
echo "uninstall:       rm -rf '$EXT_DEST' '$MOD_DEST'"
