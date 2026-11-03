'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { join } = require('path');
const { spawn, execFile } = require('child_process');

const PORT = 8099;
const FETCH_CAPTIONS = process.env.FETCH_CAPTIONS === 'true';
const CAPTION_LANGS = process.env.CAPTION_LANGS || 'en.*';
const MAX_TRANSCRIPT_CHARS = 60000;
const MAX_VIDEOS = 3;
// Only YouTube links are matched, and yt-dlp is given a URL rebuilt from the 11-character video id.
const YOUTUBE_RE = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/g;
const API_TOKEN = process.env.API_TOKEN;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';
const TIMEOUT_MS = Number(process.env.TIMEOUT_SECONDS || 120) * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const MAX_BODY = 1024 * 1024;

let running = 0;
const queue = [];

function log(msg) {
  console.log(`[claude_api] ${msg}`);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function authorized(req) {
  // OpenAI clients send "Authorization: Bearer", Anthropic clients send "x-api-key".
  const header = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const given = Buffer.from(String(header).replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(API_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function vttToText(vtt) {
  const lines = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.replace(/<[^>]+>/g, '').trim();
    if (!line || line === 'WEBVTT' || /^(Kind|Language|NOTE)\b/.test(line) || line.includes('-->')) continue;
    // Auto-generated captions repeat each line across overlapping cues.
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join(' ');
}

async function fetchCaptions(id) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'yt-'));
  try {
    const args = [
      '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', CAPTION_LANGS,
      '--sub-format', 'vtt', '--no-playlist', '-o', join(dir, '%(id)s'), '--',
      `https://www.youtube.com/watch?v=${id}`,
    ];
    await new Promise((resolve, reject) => {
      execFile('yt-dlp', args, { timeout: 30000, cwd: dir }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
        else resolve();
      });
    });
    const file = fs.readdirSync(dir).filter((f) => f.endsWith('.vtt')).sort()[0];
    if (!file) throw new Error('no captions available');
    return vttToText(fs.readFileSync(join(dir, file), 'utf8')).slice(0, MAX_TRANSCRIPT_CHARS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Claude cannot watch video, so the captions of any YouTube links in the prompt are appended to it.
async function withTranscripts(prompt) {
  if (!FETCH_CAPTIONS) return prompt;
  const ids = [...new Set([...prompt.matchAll(YOUTUBE_RE)].map((m) => m[1]))].slice(0, MAX_VIDEOS);
  if (ids.length === 0) return prompt;
  const parts = [];
  for (const id of ids) {
    const url = `https://www.youtube.com/watch?v=${id}`;
    try {
      const text = await fetchCaptions(id);
      log(`captions ok for ${id} (${text.length} chars)`);
      parts.push(`[Transcript of ${url}]\n${text}`);
    } catch (e) {
      log(`captions failed for ${id}: ${e.message}`);
      parts.push(`[Captions for ${url} could not be fetched: ${e.message}]`);
    }
  }
  return `${prompt}\n\n${parts.join('\n\n')}`;
}

async function runClaude(opts) {
  return spawnClaude({ ...opts, prompt: await withTranscripts(opts.prompt) });
}

function spawnClaude({ prompt, system, model, sessionId }) {
  return new Promise((resolve, reject) => {
    // Built-in tools are disabled: this endpoint is a plain text API, not an agent with shell access.
    const args = ['-p', '--output-format', 'json', '--tools', ''];
    const useModel = model || DEFAULT_MODEL;
    if (useModel) args.push('--model', useModel);
    if (system) args.push('--append-system-prompt', system);
    if (sessionId) args.push('--resume', sessionId);

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: '/tmp' });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('claude timed out'), { status: 504 }));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return reject(Object.assign(new Error(`claude exited ${code}: ${(err || out).slice(0, 500)}`), { status: 502 }));
      }
      if (parsed.is_error) {
        return reject(Object.assign(new Error(String(parsed.result || 'claude error').slice(0, 500)), { status: 502 }));
      }
      resolve({ result: parsed.result, session_id: parsed.session_id, usage: parsed.usage, cost_usd: parsed.total_cost_usd });
    });

    child.stdin.end(prompt);
  });
}

function schedule(job) {
  return new Promise((resolve, reject) => {
    const start = () => {
      running++;
      job().then(resolve, reject).finally(() => {
        running--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (running < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : '')).join('\n');
  }
  return '';
}

// OpenAI clients send arbitrary model names; only pass through ones the CLI understands.
function cliModel(name) {
  return typeof name === 'string' && /^(claude|sonnet|opus|haiku|fable)/i.test(name) ? name : '';
}

function openaiError(res, status, message) {
  send(res, status, { error: { message, type: 'invalid_request_error' } });
}

async function chatCompletions(req, res, body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openaiError(res, 400, 'messages (array) is required');
  }
  const systems = [];
  const turns = [];
  for (const m of body.messages) {
    const text = contentText(m.content);
    if (m.role === 'system' || m.role === 'developer') systems.push(text);
    else turns.push({ role: m.role === 'assistant' ? 'Assistant' : 'User', text });
  }
  const wantsJson = body.response_format && body.response_format.type !== 'text';
  if (wantsJson) systems.push('Respond with only valid JSON, no markdown fences and no commentary.');

  // A single user turn is sent as-is; longer histories are flattened into a transcript.
  const prompt =
    turns.length === 1 && turns[0].role === 'User'
      ? turns[0].text
      : turns.map((t) => `${t.role}: ${t.text}`).join('\n\n') + '\n\nAssistant:';

  const out = await schedule(() =>
    runClaude({ prompt, system: systems.join('\n\n'), model: cliModel(body.model) })
  );

  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || 'claude';
  const usage = {
    prompt_tokens: (out.usage && out.usage.input_tokens) || 0,
    completion_tokens: (out.usage && out.usage.output_tokens) || 0,
    total_tokens: ((out.usage && out.usage.input_tokens) || 0) + ((out.usage && out.usage.output_tokens) || 0),
  };

  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: out.result }, null));
    res.write(chunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
    return;
  }

  send(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: out.result }, finish_reason: 'stop' }],
    usage,
  });
}

function anthropicError(res, status, message) {
  send(res, status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', message } });
}

// Anthropic Messages API, for clients (such as LiteLLM with a claude-* model) that use the native format.
async function anthropicMessages(req, res, body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return anthropicError(res, 400, 'messages (array) is required');
  }
  const turns = body.messages.map((m) => ({ role: m.role === 'assistant' ? 'Assistant' : 'User', text: contentText(m.content) }));
  const prompt =
    turns.length === 1 && turns[0].role === 'User'
      ? turns[0].text
      : turns.map((t) => `${t.role}: ${t.text}`).join('\n\n') + '\n\nAssistant:';

  const out = await schedule(() =>
    runClaude({ prompt, system: contentText(body.system), model: cliModel(body.model) })
  );

  const id = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const model = body.model || 'claude';
  const inputTokens = (out.usage && out.usage.input_tokens) || 0;
  const outputTokens = (out.usage && out.usage.output_tokens) || 0;

  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', {
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
    });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: out.result } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } });
    ev('message_stop', {});
    res.end();
    return;
  }

  send(res, 200, {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: out.result }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Clients often glue base URL and path together badly (".../v1//v1/messages"), so normalize first.
    const path = req.url.split('?')[0].replace(/\/+/g, '/').replace(/^(\/v1)+/, '/v1');

    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    if (!authorized(req)) {
      return path === '/v1/messages' ? anthropicError(res, 401, 'unauthorized') : send(res, 401, { error: 'unauthorized' });
    }

    if (req.method === 'POST' && path === '/v1/messages') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return anthropicError(res, e.status || 400, e.status ? e.message : 'invalid JSON');
      }
      try {
        const started = Date.now();
        await anthropicMessages(req, res, body);
        log(`messages ok in ${Date.now() - started}ms`);
      } catch (e) {
        log(`error: ${e.message}`);
        if (!res.headersSent) anthropicError(res, e.status || 500, e.message);
        else res.end();
      }
      return;
    }

    if (req.method === 'GET' && path === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: 'claude', object: 'model', owned_by: 'anthropic' }] });
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return openaiError(res, e.status || 400, e.status ? e.message : 'invalid JSON');
      }
      try {
        const started = Date.now();
        await chatCompletions(req, res, body);
        log(`chat ok in ${Date.now() - started}ms`);
      } catch (e) {
        log(`error: ${e.message}`);
        if (!res.headersSent) openaiError(res, e.status || 500, e.message);
        else res.end();
      }
      return;
    }

    if (req.method === 'POST' && path === '/v1/ask') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return send(res, e.status || 400, { error: e.status ? e.message : 'invalid JSON' });
      }
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return send(res, 400, { error: 'prompt (string) is required' });
      }
      const started = Date.now();
      const out = await schedule(() =>
        runClaude({ prompt: body.prompt, system: body.system, model: body.model, sessionId: body.session_id })
      );
      log(`ask ok in ${Date.now() - started}ms`);
      return send(res, 200, out);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    log(`error: ${e.message}`);
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT}`));
