#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_FILE="${1:-integration.qmd}"
WORKSPACE_DIR="$ROOT_DIR/test/manual-workspace"
TARGET_PATH="$WORKSPACE_DIR/$TARGET_FILE"
TMP_ROOT="${TMPDIR:-/tmp}/rmd-notebooks-vscode-visual-host"
USER_DATA_DIR="$TMP_ROOT/user-data"
EXTENSIONS_DIR="$TMP_ROOT/extensions"

if [[ ! -f "$TARGET_PATH" ]]; then
  echo "Target file not found: $TARGET_PATH" >&2
  exit 1
fi

mkdir -p "$USER_DATA_DIR" "$EXTENSIONS_DIR"

npm run compile >/dev/null

open -n -a "Visual Studio Code" --args \
  --new-window \
  --disable-updates \
  --skip-welcome \
  --user-data-dir "$USER_DATA_DIR" \
  --extensions-dir "$EXTENSIONS_DIR" \
  --extensionDevelopmentPath "$ROOT_DIR" \
  "$WORKSPACE_DIR" \
  "$TARGET_PATH"
