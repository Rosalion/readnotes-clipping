#!/usr/bin/env bash
# 启动本地 Markdown 保存服务（写入 Obsidian 05_情报/网页剪藏）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/scripts/.save-server.pid"
LOG_FILE="$ROOT/scripts/.save-server.log"
NODE="${NODE:-node}"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE")"
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "save-server 已在运行 (pid $OLD_PID)"
    curl -sf "http://127.0.0.1:37564/health" && echo ""
    exit 0
  fi
fi

nohup "$NODE" "$ROOT/scripts/save-server.mjs" >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
sleep 0.4
if curl -sf "http://127.0.0.1:37564/health"; then
  echo ""
  echo "save-server 已启动，日志: $LOG_FILE"
else
  echo "启动失败，查看 $LOG_FILE" >&2
  exit 1
fi
