# Claude API

A small HTTP API in front of the official `claude` CLI, authenticated with your own Claude Pro login.
Requests count against your Pro usage limits. For personal, household use only; do not expose it publicly or share it.

## Setup

1. On any machine with Claude Code installed and logged in to your Pro account, run `claude setup-token`
   and copy the token it prints.
2. In the add-on options, set:
   - `oauth_token`: the token from step 1.
   - `api_token`: any long random string. Clients must send it as `Authorization: Bearer <api_token>`.
3. Start the add-on.

Alternative to step 1: copy `~/.claude/.credentials.json` into the add-on config folder as `.claude/.credentials.json`.

## API

`POST http://<ha-host>:8099/v1/ask`

```json
{ "prompt": "Say hello", "system": "optional", "model": "optional", "session_id": "optional" }
```

Response:

```json
{ "result": "Hello!", "session_id": "...", "usage": {}, "cost_usd": 0 }
```

Pass the returned `session_id` back to continue a conversation. `GET /health` needs no token.

## Home Assistant example

```yaml
rest_command:
  claude_ask:
    url: "http://localhost:8099/v1/ask"
    method: post
    headers:
      Authorization: "Bearer YOUR_API_TOKEN"
      Content-Type: "application/json"
    payload: '{"prompt": {{ prompt | tojson }}}'
    timeout: 120
```

Call it with `response_variable` to read `content.result` in an automation or script.

## Notes

- The CLI's built-in tools (shell, file access) are disabled; this is text in, text out.
- Each request starts a CLI process, so expect a few seconds of latency.
- `max_concurrent` limits parallel requests; extra ones wait in a queue.
