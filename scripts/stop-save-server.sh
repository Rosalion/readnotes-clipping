#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/scripts/.save-server.pid"
if [[ ! -f "$PID_FILE" ]]; then
  echo "save-server 未运行"
  exit 0
fi
PID="$(cat "$PID_FILE")"
kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "已停止 save-server (pid $PID)"
