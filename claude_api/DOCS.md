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

## OpenAI-compatible API

For apps that speak the OpenAI protocol (Open WebUI, LiteLLM and similar):

- Base URL: `http://<ha-host>:8099/v1`
- API key: your `api_token`
- Model: any name. Names starting with `claude`, `sonnet`, `opus`, `haiku` or `fable` are passed to the CLI; anything else uses `default_model`.

Clients that use Anthropic's native format (LiteLLM does this for models named `claude-*`) are supported too:
`POST /v1/messages`, with the token in either `x-api-key` or `Authorization: Bearer`. For those, use the base URL
without `/v1` (`http://<ha-host>:8099`), because the client appends `/v1/messages` itself. A doubled path such as
`/v1//v1/messages` is tolerated.

Supported: `POST /v1/chat/completions` (including `stream: true`, which returns the full reply as one chunk) and `GET /v1/models`.
Tool calling and image input are not supported.

## YouTube links

Claude cannot watch video, so when a prompt contains a YouTube link (`youtube.com/watch`, `youtu.be`, Shorts or live URLs)
the add-on fetches the video's captions with `yt-dlp` and appends the transcript to the prompt. This works on every
endpoint. Up to 3 videos per request, and each transcript is cut at 60,000 characters.

- Options: `fetch_youtube_captions` (on by default) and `caption_languages` (a `yt-dlp` pattern, default `en.*`; for
  example `de.*,en.*`).
- Manual and auto-generated captions are both used. A video with no captions at all gets a note saying so, and Claude is
  not given a transcript.
- Only YouTube is supported. YouTube sometimes blocks `yt-dlp` from server addresses, and the tool needs updating
  from time to time: rebuilding the add-on installs the latest version.
- Claude only sees what is said, not what is shown on screen.

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
