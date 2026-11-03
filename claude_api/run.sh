#!/bin/bash
set -euo pipefail

OPTIONS=/data/options.json

# Credentials and session history live in the add-on config folder so they survive updates.
export HOME=/config
mkdir -p "$HOME"

export API_TOKEN="$(jq -r '.api_token' "$OPTIONS")"
export DEFAULT_MODEL="$(jq -r '.default_model // ""' "$OPTIONS")"
export TIMEOUT_SECONDS="$(jq -r '.timeout_seconds' "$OPTIONS")"
export MAX_CONCURRENT="$(jq -r '.max_concurrent' "$OPTIONS")"
export FETCH_CAPTIONS="$(jq -r '.fetch_youtube_captions' "$OPTIONS")"
export CAPTION_LANGS="$(jq -r '.caption_languages // "en.*"' "$OPTIONS")"

OAUTH_TOKEN="$(jq -r '.oauth_token // ""' "$OPTIONS")"
if [ -n "$OAUTH_TOKEN" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN="$OAUTH_TOKEN"
fi

if [ -z "$API_TOKEN" ]; then
    echo "[claude_api] api_token is empty; set it in the add-on options." >&2
    exit 1
fi

if [ -z "$OAUTH_TOKEN" ] && [ ! -f "$HOME/.claude/.credentials.json" ]; then
    echo "[claude_api] No Claude login found. Set oauth_token (from 'claude setup-token')" >&2
    echo "[claude_api] or place .claude/.credentials.json in the add-on config folder." >&2
fi

exec node /app/server.js
