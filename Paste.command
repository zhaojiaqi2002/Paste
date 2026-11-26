#!/bin/bash
# Double-click in Finder to open Paste. The daemon is detached and keeps
# recording; this window can be closed.
set -u
cd "$(dirname "$0")" || exit 1

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"; do
    [ -x "$candidate" ] && NODE_BIN="$candidate" && break
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "Paste 需要 Node.js 20 或更新版本：https://nodejs.org"
  read -r -n 1 -p "按任意键关闭…"
  exit 1
fi

"$NODE_BIN" bin/launch.js
exit 0
