#!/bin/bash
# Refresh the OAuth token in .env from the macOS keychain.
# Claude Code keeps the keychain token fresh when you use it interactively.

ENV_FILE="$HOME/second-brain/nanoclaw/.env"

TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['claudeAiOauth']['accessToken'])" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "$(date): No OAuth token found in keychain" >&2
  exit 1
fi

CURRENT=$(grep "CLAUDE_CODE_OAUTH_TOKEN=" "$ENV_FILE" | head -1 | cut -d= -f2)

if [ "$TOKEN" = "$CURRENT" ]; then
  exit 0
fi

sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}|" "$ENV_FILE"
echo "$(date): OAuth token refreshed"

# Restart NanoClaw to pick up new token
launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null
echo "$(date): NanoClaw restarted"
