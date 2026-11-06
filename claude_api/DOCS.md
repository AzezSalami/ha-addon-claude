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

Supported: `POST /v1/chat/completions` (including `stream: true`, see below) and `GET /v1/models`.
Tool calling and image input are not supported.

### Streaming

`stream: true` works on `/v1/chat/completions` and `/v1/messages`: the reply is sent as server-sent events while Claude
writes it, not all at once at the end. The first words arrive after the Claude CLI has started, usually a few seconds.

- Closing the connection stops the Claude process.
- A request that asks for JSON (for example Tandoor's recipe import) is not streamed live, because the reply has to be
  cleaned up as a whole first. With `stream: true` such a client still gets a valid event stream, but it arrives in one go.
- A request containing a YouTube or Instagram link starts streaming after the transcript or caption has been fetched.
- `/v1/ask` does not stream.

## Voice assistants

For a Home Assistant voice pipeline, put `/voice` in front of the API path. Other apps keep using the normal URLs, so
Tandoor and similar clients are not affected.

- OpenAI-style clients: base URL `http://<ha-host>:8099/voice/v1`
- Anthropic-style clients: base URL `http://<ha-host>:8099/voice`

Requests under `/voice` differ in two ways. This applies to `/v1/chat/completions` and `/v1/messages`, not `/v1/ask`.

- **Spoken replies:** Claude is told to answer in one or two short sentences of plain speech, with no markdown, lists or
  emoji. This replaces Claude Code's own system prompt. Set `voice_instructions` to use your own wording instead. Any
  system prompt sent by the client is added after it.
- **Conversation memory:** the add-on continues the same conversation while requests keep coming, and only sends Claude
  the newest message. The conversation ends after `voice_memory_minutes` without a request (default 10; `0` turns memory
  off, and the add-on then uses only the history the client sends). Memory is kept until the add-on restarts.

All voice requests share one conversation unless the client sends a `user` field (OpenAI) or `metadata.user_id`
(Anthropic). In a home with several voice devices, this means they usually share the same memory.

## YouTube links

Claude cannot watch video, so when a prompt contains a YouTube link (`youtube.com/watch`, `youtu.be`, Shorts or live URLs)
the add-on fetches the video's captions with `yt-dlp` and appends the transcript to the prompt. This works on every
endpoint. Up to 3 videos per request, and each transcript is cut at 60,000 characters.

- Options: `fetch_youtube_captions` (on by default) and `caption_languages` (a `yt-dlp` pattern, default `en.*`; for
  example `de.*,en.*`).
- Manual and auto-generated captions are both used. A video with no captions at all gets a note saying so, and Claude is
  not given a transcript.
- This part covers YouTube only; see "Instagram links" below for Instagram. YouTube sometimes blocks `yt-dlp` from server addresses, and the tool needs updating
  from time to time: rebuilding the add-on installs the latest version.
- Claude only sees what is said, not what is shown on screen.

## Instagram links

When a prompt contains an Instagram post or reel link (`instagram.com/reel/...`, `/reels/...`, `/p/...` or `/tv/...`)
and `fetch_instagram_captions` is on (the default), the add-on reads the post's **caption** with `yt-dlp` and appends it
to the prompt. This is the text the author wrote under the post. Instagram has no subtitles, so anything that is only
spoken in the video is not available: a post whose caption says "recipe in the video" gives Claude nothing to work with.

Instagram usually refuses requests that are not logged in, so many fetches fail without cookies. The failure is reported
to Claude and shown in the add-on log, and Claude is not given a made-up caption. To log in:

1. Use a throwaway Instagram account, not your main one: scraping is against Instagram's terms and can get an account
   restricted.
2. Log in to that account in a desktop browser and export its cookies in Netscape format with a cookies.txt extension.
3. Save the file as `instagram_cookies.txt` in the add-on config folder (`/addon_configs/<id>_claude_api/`, reachable
   from the File editor or Samba add-ons). The add-on uses it automatically if it exists, and never modifies it.

The cookie file is a copy of a logged-in session: keep it private, and delete it to stop using it.

## JSON replies

Apps like Tandoor's AI import expect the reply to be one JSON object. With `clean_json_replies` on (the default):

- A request that asks for JSON (for example "return ... as JSON" or "schema.org") gets an instruction added at the end of
  the prompt telling Claude to reply with raw JSON only, with no code fence and no explanations. If the request mentions
  `schema.org/recipe`, the instruction also asks for exactly one Recipe object: when a video or page contains several
  recipes they are merged into one, with each part as its own section.
- The reply is then tidied before it is returned: the code fence (closed or not) and any text around it are removed
  (for requests that asked for JSON), a list holding a single object is unwrapped to that object, and a reply that was
  cut off mid-way is repaired by closing its open brackets and dropping a dangling comma. The add-on log says when a
  repair happened, and warns when the reply is a list of several items.

Replies that cannot be read as JSON are never changed. A repaired reply may be missing whatever was cut off.

## Logging requests

The `log_requests` option controls what is written to the add-on log (Settings → Add-ons → Claude API → Log):

- `off` (default): only errors and one `... ok in Nms` line per successful request.
- `summary`: one line per request with the method, path, status, duration, client address and request size.
- `full`: the summary line plus the complete request body, the complete response body, the final prompt sent to Claude
  (including any YouTube transcripts that were added) and Claude's raw reply before JSON tidying. Each block is cut at
  50,000 characters.

`Authorization` and `x-api-key` headers are never logged, but recipes, prompts and replies are, so use `full` only
while troubleshooting and set it back to `off` afterwards. `/health` checks are not logged.

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
