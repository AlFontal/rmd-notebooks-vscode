#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_FILE="${1:-integration.qmd}"
WORKSPACE_DIR="$ROOT_DIR/test/manual-workspace"
TARGET_PATH="$WORKSPACE_DIR/$TARGET_FILE"
TMP_ROOT="/private/tmp/rmd-notebooks-vscode-visual-host"
USER_DATA_DIR="$TMP_ROOT/user-data"
EXTENSIONS_DIR="$TMP_ROOT/extensions"
LOG_FILE="$TMP_ROOT/vscode.log"
VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code"

if [[ ! -f "$TARGET_PATH" ]]; then
  echo "Target file not found: $TARGET_PATH" >&2
  exit 1
fi

mkdir -p "$USER_DATA_DIR" "$EXTENSIONS_DIR"

echo "Compiling the extension..."
npm run compile

LAUNCH_ARGS=(
  --new-window
  --disable-updates
  --skip-welcome
  --user-data-dir "$USER_DATA_DIR"
  --extensions-dir "$EXTENSIONS_DIR"
  --extensionDevelopmentPath "$ROOT_DIR"
  "$WORKSPACE_DIR"
  "$TARGET_PATH"
)

echo "Opening the Extension Development Host..."
if [[ -x "$VSCODE_EXECUTABLE" ]]; then
  nohup "$VSCODE_EXECUTABLE" --verbose "${LAUNCH_ARGS[@]}" >"$LOG_FILE" 2>&1 &
  VSCODE_PID=$!
  sleep 2
  if ! kill -0 "$VSCODE_PID" 2>/dev/null; then
    echo "VS Code exited before opening. Log output:" >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  osascript -e 'tell application id "com.microsoft.VSCode" to activate' >/dev/null 2>&1 || true
  echo "Started VS Code (PID $VSCODE_PID). Log: $LOG_FILE"
elif command -v code >/dev/null 2>&1; then
  code "${LAUNCH_ARGS[@]}"
else
  echo "Visual Studio Code was not found. Install it in /Applications or add the 'code' shell command to PATH." >&2
  exit 1
fi
