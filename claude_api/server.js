'use strict';

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8099;
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
  const header = req.headers['authorization'] || '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
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

function runClaude({ prompt, system, model, sessionId }) {
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: 'claude', object: 'model', owned_by: 'anthropic' }] });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
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

    if (req.method === 'POST' && req.url === '/v1/ask') {
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
