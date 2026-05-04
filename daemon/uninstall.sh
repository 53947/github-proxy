#!/bin/bash
# linksblue-daemon uninstaller — Prompt 05/03/2026-20
# Removes the LaunchAgent. Leaves state/logs/queue intact for reinstall.

set -euo pipefail

PLIST_DST="$HOME/Library/LaunchAgents/com.triadblue.linksblue-daemon.plist"

echo "==> linksblue-daemon uninstaller"

if launchctl list | grep -q com.triadblue.linksblue-daemon; then
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    echo "==> daemon unloaded"
else
    echo "==> daemon not currently loaded"
fi

if [ -f "$PLIST_DST" ]; then
    rm "$PLIST_DST"
    echo "==> removed $PLIST_DST"
else
    echo "==> no plist at $PLIST_DST (already removed)"
fi

echo
echo "==> SUCCESS: linksblue-daemon uninstalled."
echo "    State preserved at: $HOME/.linksblue-daemon/"
echo "    To reinstall:       /Users/deanlewis/linksblue-network/daemon/install.sh"
