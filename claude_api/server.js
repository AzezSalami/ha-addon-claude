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
const CLEAN_JSON = process.env.CLEAN_JSON !== 'false';
// off: nothing extra. summary: one line per request. full: also the complete request, reply and prompt text.
const LOG_MODE = ['summary', 'full'].includes(process.env.LOG_MODE) ? process.env.LOG_MODE : 'off';
const MAX_LOGGED_CHARS = 50000;
const MAX_TRANSCRIPT_CHARS = 60000;
const MAX_VIDEOS = 3;
// Only YouTube links are matched, and yt-dlp is given a URL rebuilt from the 11-character video id.
const YOUTUBE_RE = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/g;
const FETCH_INSTAGRAM = process.env.FETCH_INSTAGRAM === 'true';
const INSTAGRAM_COOKIES = process.env.INSTAGRAM_COOKIES_FILE || '/config/instagram_cookies.txt';
// Post and reel links only; yt-dlp is given a URL rebuilt from the link kind and shortcode.
const INSTAGRAM_RE = /instagram\.com\/(?:[\w.]+\/)?(reels?|p|tv)\/([\w-]+)/gi;
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
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks).toString('utf8');
      resolve(req.rawBody);
    });
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

// The caption is the text the author wrote under the post; Instagram has no subtitle track for what is said in the video.
async function fetchInstagramCaption(kind, code) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'ig-'));
  try {
    const args = ['--skip-download', '--no-playlist', '--print', 'description'];
    if (fs.existsSync(INSTAGRAM_COOKIES)) {
      // yt-dlp rewrites its cookie file, so it gets a throwaway copy.
      const copy = join(dir, 'cookies.txt');
      fs.copyFileSync(INSTAGRAM_COOKIES, copy);
      args.push('--cookies', copy);
    }
    args.push('--', `https://www.instagram.com/${kind}/${code}/`);
    const stdout = await new Promise((resolve, reject) => {
      execFile('yt-dlp', args, { timeout: 30000, cwd: dir, maxBuffer: 4 * 1024 * 1024 }, (err, out, stderr) => {
        if (!err) return resolve(out);
        let msg = String(stderr || err.message).trim().split('\n').pop();
        if (/login|log in|cookie|rate-limit|empty media|private/i.test(msg)) {
          msg += ' (Instagram usually needs a login: see "Instagram links" in the add-on documentation)';
        }
        reject(new Error(msg));
      });
    });
    const text = stdout.trim();
    if (!text || text === 'NA') throw new Error('the post has no caption');
    return text.slice(0, MAX_TRANSCRIPT_CHARS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Claude cannot watch video, so the captions of any YouTube links, and the post captions of any Instagram links,
// found in the prompt are appended to it.
async function withTranscripts(prompt) {
  const jobs = [];
  if (FETCH_CAPTIONS) {
    for (const m of prompt.matchAll(YOUTUBE_RE)) {
      jobs.push({ key: `yt:${m[1]}`, url: `https://www.youtube.com/watch?v=${m[1]}`, what: 'Transcript', run: () => fetchCaptions(m[1]) });
    }
  }
  if (FETCH_INSTAGRAM) {
    for (const m of prompt.matchAll(INSTAGRAM_RE)) {
      const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
      jobs.push({ key: `ig:${m[2]}`, url: `https://www.instagram.com/${kind}/${m[2]}/`, what: 'Caption', run: () => fetchInstagramCaption(kind, m[2]) });
    }
  }
  const unique = [...new Map(jobs.map((j) => [j.key, j])).values()].slice(0, MAX_VIDEOS);
  if (unique.length === 0) return prompt;
  const parts = [];
  for (const job of unique) {
    try {
      const text = await job.run();
      log(`${job.what.toLowerCase()} ok for ${job.key} (${text.length} chars)`);
      parts.push(`[${job.what} of ${job.url}]\n${text}`);
    } catch (e) {
      log(`${job.what.toLowerCase()} failed for ${job.key}: ${e.message}`);
      parts.push(`[${job.what} of ${job.url} could not be fetched: ${e.message}]`);
    }
  }
  return `${prompt}\n\n${parts.join('\n\n')}`;
}

// Added to requests that ask for JSON, so the reply needs less cleaning up afterwards.
const JSON_REQUEST_RE = /(respond|reply|return|output|answer|format)[^.\n]{0,60}json|json (object|format|only)|schema\.org/i;
const RECIPE_REQUEST_RE = /schema\.org\/recipe/i;
// Appended to the end of the prompt itself: Claude follows it there more reliably than in a system prompt.
const JSON_RULE =
  '[Output format] Reply with one single raw JSON value only: no markdown code fences, no text before or after the JSON, ' +
  'no explanations or notes.';
const RECIPE_RULE =
  'The JSON must be exactly one Recipe object, never an array. If the text contains several recipes or parts, merge them ' +
  'into that one Recipe and keep each part as its own named section (a HowToSection in recipeInstructions, and a heading ' +
  'line such as "Crust:" in recipeIngredient).';

// Closes strings, objects and arrays left open (for example by a cut-off reply) and drops a dangling comma.
function repairJson(body) {
  let out = '';
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of body) {
    out += ch;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) out += '"';
  return out.replace(/,\s*$/, '') + stack.reverse().join('');
}

// Finds the JSON part of a reply: a ```json fence (closed or not), or the whole reply. When the request did not ask for
// JSON, a fence surrounded by a lot of prose is left alone because it is probably an ordinary answer with an example.
function extractJson(text, jsonRequested) {
  const fence = text.match(/```(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```|$)/i);
  if (fence && !jsonRequested && text.length - fence[0].length > 300) return null;
  const body = (fence ? fence[1] : text).trim();
  return /^[[{]/.test(body) ? { body, fenced: Boolean(fence) } : null;
}

// Apps that parse replies as JSON break on code fences, a cut-off reply or a one-item array wrapped around the object.
// Anything that cannot be read as JSON is returned untouched.
function tidyJson(text, jsonRequested) {
  const found = extractJson(text, jsonRequested);
  if (!found) return text;
  let parsed;
  let repaired = false;
  try {
    parsed = JSON.parse(found.body);
  } catch {
    try {
      parsed = JSON.parse(repairJson(found.body).replace(/,(\s*[}\]])/g, '$1'));
      repaired = true;
    } catch {
      return text;
    }
  }
  if (repaired) log('JSON reply was incomplete; closed the open brackets');
  if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
    return JSON.stringify(parsed[0]);
  }
  if (Array.isArray(parsed) && parsed.length > 1) {
    log(`JSON reply is a list of ${parsed.length} items; apps that expect a single object will reject it`);
  }
  if (repaired) return JSON.stringify(parsed);
  return found.fenced || found.body !== text.trim() ? found.body : text;
}

function logBlock(label, text) {
  const s = String(text);
  const body = s.length > MAX_LOGGED_CHARS ? `${s.slice(0, MAX_LOGGED_CHARS)}\n... (${s.length - MAX_LOGGED_CHARS} more characters not shown)` : s;
  log(`${label}:\n${body}`);
}

// Logs one line per request (summary) or the whole exchange (full). Authorization headers are never logged.
function attachRequestLog(req, res) {
  if (LOG_MODE === 'off') return;
  const started = Date.now();
  const sent = [];
  if (LOG_MODE === 'full') {
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk, ...rest) => {
      if (chunk) sent.push(Buffer.from(chunk));
      return write(chunk, ...rest);
    };
    res.end = (chunk, ...rest) => {
      if (chunk && typeof chunk !== 'function') sent.push(Buffer.from(chunk));
      return end(chunk, ...rest);
    };
  }
  res.on('finish', () => {
    const from = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    log(`${req.method} ${req.url} -> ${res.statusCode} in ${Date.now() - started}ms (from ${from}, request ${(req.rawBody || '').length} chars)`);
    if (LOG_MODE === 'full') {
      if (req.rawBody) logBlock('  request body', req.rawBody);
      logBlock('  response body', Buffer.concat(sent).toString('utf8'));
    }
  });
}

async function runClaude(opts) {
  let prompt = await withTranscripts(opts.prompt);
  const asksForJson = CLEAN_JSON && JSON_REQUEST_RE.test(`${opts.system || ''}\n${opts.prompt}`);
  if (asksForJson) {
    prompt += `\n\n${JSON_RULE}${RECIPE_REQUEST_RE.test(opts.prompt) ? ` ${RECIPE_RULE}` : ''}`;
  }
  if (LOG_MODE === 'full') logBlock('  prompt sent to claude' + (opts.system ? ` (system: ${opts.system.length} chars)` : ''), prompt);
  const out = await spawnClaude({ ...opts, prompt });
  if (LOG_MODE === 'full') logBlock('  raw reply from claude', out.result);
  if (CLEAN_JSON && typeof out.result === 'string') {
    const tidy = tidyJson(out.result, asksForJson);
    if (tidy !== out.result) {
      log('JSON reply tidied (removed code fence or unwrapped single-item array)');
      out.result = tidy;
    }
  }
  return out;
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
    attachRequestLog(req, res);
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
