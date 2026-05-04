#!/bin/bash
# linksblue-daemon installer — Prompt 05/03/2026-20
# Run on each Mac that should capture conversations.
# Idempotent: safe to re-run.

set -euo pipefail

DAEMON_DIR="/Users/deanlewis/linksblue-network/daemon"
PLIST_SRC="$DAEMON_DIR/com.triadblue.linksblue-daemon.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.triadblue.linksblue-daemon.plist"
STATE_DIR="$HOME/.linksblue-daemon"

echo "==> linksblue-daemon installer"
echo "==> daemon dir: $DAEMON_DIR"
echo "==> plist destination: $PLIST_DST"
echo

# 1. Verify Node 18+
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node is not installed. Install Node 18 or newer first." >&2
    exit 1
fi
NODE_VER="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "ERROR: Node v$NODE_VER detected. Need 18.0.0 or newer." >&2
    exit 1
fi
NODE_PATH="$(command -v node)"
echo "==> node: v$NODE_VER at $NODE_PATH"

# 2. Verify Keychain entry exists
if ! security find-generic-password -s LINKSBLUE_ARCHIVE_API_KEY >/dev/null 2>&1; then
    echo "ERROR: Keychain entry 'LINKSBLUE_ARCHIVE_API_KEY' not found." >&2
    echo "  Add it with:" >&2
    echo "    security add-generic-password -s LINKSBLUE_ARCHIVE_API_KEY -a deanlewis -w 'YOUR_KEY'" >&2
    exit 1
fi
echo "==> Keychain entry LINKSBLUE_ARCHIVE_API_KEY found"

# 3. Verify watch paths (warn-but-allow if any missing)
WATCH_PATHS=(
    "$HOME/.claude/projects"
    "$HOME/Library/Application Support/Claude/local-agent-mode-sessions"
    "$HOME/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb"
)
for p in "${WATCH_PATHS[@]}"; do
    if [ -e "$p" ]; then
        echo "==> watch path OK: $p"
    else
        echo "==> watch path missing (will appear after first use): $p"
    fi
done

# 4. Make state directories
mkdir -p "$STATE_DIR" "$STATE_DIR/queue" "$STATE_DIR/parse-failures"
echo "==> state directories ready: $STATE_DIR"

# 5. Install npm dependencies
cd "$DAEMON_DIR"
echo "==> installing npm dependencies..."
npm install --omit=dev
echo

# 6. Render plist with the local node path
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__NODE_PATH__|$NODE_PATH|g" "$PLIST_SRC" > "$PLIST_DST"
plutil -lint "$PLIST_DST" >/dev/null
echo "==> plist installed at $PLIST_DST"

# 7. Load (and replace if already loaded)
if launchctl list | grep -q com.triadblue.linksblue-daemon; then
    echo "==> daemon already loaded; unloading first"
    launchctl unload "$PLIST_DST" 2>/dev/null || true
fi
launchctl load "$PLIST_DST"
echo "==> daemon loaded"

# 8. Verify it's running
sleep 2
if launchctl list | grep -q com.triadblue.linksblue-daemon; then
    echo "==> daemon is registered with launchd"
else
    echo "ERROR: daemon failed to register with launchd." >&2
    exit 1
fi

# 9. Tail log briefly so Dean sees first signs of life
echo
echo "==> tailing daemon log for 10 seconds..."
echo "----------------------------------------"
( tail -n 50 -F "$STATE_DIR/daemon.log" 2>/dev/null & ) ; TAIL_PID=$!
sleep 10
kill "$TAIL_PID" 2>/dev/null || true
echo "----------------------------------------"
echo
echo "==> SUCCESS: linksblue-daemon installed."
echo "    Verify with:  launchctl list | grep linksblue-daemon"
echo "    Tail logs:    tail -f $STATE_DIR/daemon.log"
echo "    Uninstall:    $DAEMON_DIR/uninstall.sh"
