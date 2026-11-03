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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

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
