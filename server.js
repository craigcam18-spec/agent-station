'use strict';
// Agent Station web server: serves the dashboard and a small JSON API.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const agent = require('./agent');
const { tools, listNotes, readNote } = require('./tools');

if (!config.password || config.password.length < 8) {
  console.error('Set APP_PASSWORD in .env (at least 8 characters) before starting.');
  process.exit(1);
}

// ---- Job queue: one job at a time keeps the small VM happy ----
const queue = [];
let busy = false;
function enqueue(job) {
  queue.push(job);
  pump();
}
async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (job.status === 'queued') await agent.runJob(job);
  } finally {
    busy = false;
    pump();
  }
}

// ---- Helpers ----
const passwordHash = crypto.createHash('sha256').update(config.password).digest();
function authorised(req) {
  const given = crypto.createHash('sha256').update(String(req.headers['x-station-key'] || '')).digest();
  return crypto.timingSafeEqual(given, passwordHash);
}

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': type + '; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 50_000) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const summary = (j) => ({
  id: j.id,
  task: j.task.length > 140 ? j.task.slice(0, 140) + '…' : j.task,
  status: j.status,
  createdAt: j.createdAt,
  finishedAt: j.finishedAt,
  costUsd: j.costUsd,
  steps: j.steps.length,
});

const INDEX = path.join(__dirname, 'public', 'index.html');

// ---- Routes ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html');
    }
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    if (!authorised(req)) {
      await new Promise((r) => setTimeout(r, 600)); // slow down password guessing
      return send(res, 401, { error: 'Wrong password' });
    }

    if (req.method === 'GET' && p === '/api/status') {
      return send(res, 200, {
        model: config.model,
        spentToday: store.spentToday(),
        dailyBudget: config.dailyBudget,
        jobBudget: config.jobBudget,
        maxSteps: config.maxSteps,
        tools: [...Object.values(tools).map((t) => t.label), ...(config.webSearch ? ['Web search'] : [])],
        busy,
        queued: queue.length,
        hasApiKey: Boolean(config.apiKey),
      });
    }

    if (req.method === 'GET' && p === '/api/jobs') {
      return send(res, 200, store.list().slice(0, 100).map(summary));
    }

    if (req.method === 'POST' && p === '/api/jobs') {
      const { task } = await readBody(req);
      const text = String(task || '').trim();
      if (!text) return send(res, 400, { error: 'Type a task first.' });
      if (text.length > 8000) return send(res, 400, { error: 'Task is too long (8,000 characters max).' });
      const job = store.create(text);
      enqueue(job);
      return send(res, 201, summary(job));
    }

    let m = p.match(/^\/api\/jobs\/([a-f0-9]+)$/);
    if (req.method === 'GET' && m) {
      const job = store.get(m[1]);
      return job ? send(res, 200, job) : send(res, 404, { error: 'No such job' });
    }

    m = p.match(/^\/api\/jobs\/([a-f0-9]+)\/stop$/);
    if (req.method === 'POST' && m) {
      const job = store.get(m[1]);
      if (!job) return send(res, 404, { error: 'No such job' });
      if (job.status === 'queued') {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        job.status = 'stopped';
        job.error = 'Stopped by you before it started.';
        job.finishedAt = new Date().toISOString();
        store.save();
      } else {
        agent.stopJob(job.id);
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/notes') return send(res, 200, listNotes());

    m = p.match(/^\/api\/notes\/([a-z0-9_-]+)$/);
    if (req.method === 'GET' && m) {
      const text = readNote(m[1]);
      return text === null ? send(res, 404, { error: 'No such note' }) : send(res, 200, { name: m[1], content: text });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Agent Station running on http://${config.host}:${config.port} (model: ${config.model})`);
});

function shutdown() {
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
