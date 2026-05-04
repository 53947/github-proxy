#!/bin/bash
# linksblue-daemon round-trip test — Prompt 05/03/2026-20
# Posts a synthetic Mode-B snapshot to the live ingest endpoint, then
# a follow-up snapshot, then optionally cleans up.

set -euo pipefail

INGEST_URL="https://github.linksblue.network/api/archive/ingest"
KEY="$(security find-generic-password -s LINKSBLUE_ARCHIVE_API_KEY -w)"
if [ -z "$KEY" ]; then
    echo "ERROR: LINKSBLUE_ARCHIVE_API_KEY not in Keychain." >&2
    exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SOURCE_ID="test-daemon-$STAMP"
TITLE="linksblue daemon round-trip test ($STAMP)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "==> source_id: $SOURCE_ID"
echo

echo "==> POST 1: create (from_index=0, 2 messages)"
RESP1="$(curl -s -X POST "$INGEST_URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "platform": "claude_code",
  "title": "$TITLE",
  "started_at": "$NOW",
  "last_updated": "$NOW",
  "source_id": "$SOURCE_ID",
  "from_index": 0,
  "new_messages": [
    {"role": "user", "content": "test message 1", "timestamp": "$NOW"},
    {"role": "assistant", "content": "test response 1", "timestamp": "$NOW"}
  ]
}
EOF
)")"
echo "$RESP1"
echo

if ! echo "$RESP1" | grep -q '"created"\|"appended"\|"no_change"'; then
    echo "ERROR: first POST did not return created/appended/no_change." >&2
    exit 1
fi

PATH_ON_REPO="$(echo "$RESP1" | grep -o '"path":"[^"]*"' | head -1 | cut -d'"' -f4 || echo '')"
echo "==> file path on TRIADBLUE/ai-archive: $PATH_ON_REPO"
echo

echo "==> POST 2: append (from_index=2, 1 new message)"
NOW2="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RESP2="$(curl -s -X POST "$INGEST_URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "platform": "claude_code",
  "title": "$TITLE",
  "started_at": "$NOW",
  "last_updated": "$NOW2",
  "source_id": "$SOURCE_ID",
  "from_index": 2,
  "new_messages": [
    {"role": "user", "content": "test message 2", "timestamp": "$NOW2"}
  ]
}
EOF
)")"
echo "$RESP2"
echo

if ! echo "$RESP2" | grep -q '"appended"\|"no_change"'; then
    echo "WARN: second POST did not return appended/no_change. Mode B may not be live as expected." >&2
fi

echo "==> Round-trip succeeded."
echo "==> Test file is at: $PATH_ON_REPO"
echo
echo "Delete test file from TRIADBLUE/ai-archive? [y/N]"
read -r CONFIRM
if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
    if [ -n "$PATH_ON_REPO" ]; then
        SHA="$(gh api "repos/TRIADBLUE/ai-archive/contents/$PATH_ON_REPO" --jq '.sha' 2>/dev/null || echo '')"
        if [ -n "$SHA" ]; then
            gh api "repos/TRIADBLUE/ai-archive/contents/$PATH_ON_REPO" -X DELETE \
                -f message="cleanup: linksblue-daemon test file ($STAMP)" \
                -f sha="$SHA" >/dev/null
            echo "==> Test file deleted."
        else
            echo "WARN: could not look up SHA for $PATH_ON_REPO; delete manually."
        fi
    fi
else
    echo "==> Leaving test file in place. Delete manually when convenient:"
    echo "    gh api 'repos/TRIADBLUE/ai-archive/contents/$PATH_ON_REPO' -X DELETE -f message='cleanup' -f sha='<sha>'"
fi
