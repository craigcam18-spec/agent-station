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
const { imagePath, imagePrice } = require('./images');

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
  kind: j.kind || 'agent',
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
        studio: {
          imageModel: config.imageModel,
          imageSize: config.imageSize,
          imagePrice: imagePrice(),
          runBudget: config.designBudget,
          maxDesigns: config.maxDesignsPerRun,
          maxRevisions: config.maxRevisions,
          minScore: config.judgeMinScore,
          minOriginality: config.judgeMinOriginality,
        },
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

    // ---- Studio ----
    if (req.method === 'POST' && p === '/api/designs/run') {
      const { count, theme } = await readBody(req);
      const n = Math.max(1, Math.min(config.maxDesignsPerRun, parseInt(count, 10) || 3));
      const t = String(theme || '').trim().slice(0, 500);
      const job = store.create(`Design ${n} print${n > 1 ? 's' : ''}${t ? `: ${t}` : ' from the trends note'}`, {
        kind: 'design',
        params: { count: n, theme: t },
      });
      enqueue(job);
      return send(res, 201, summary(job));
    }

    if (req.method === 'GET' && p === '/api/designs') {
      return send(
        res,
        200,
        store.listDesigns().slice(0, 120).map((d) => {
          const last = d.attempts[d.attempts.length - 1];
          const shown = [...d.attempts].reverse().findIndex((a) => !a.error);
          return {
            id: d.id,
            title: d.title,
            status: d.status,
            createdAt: d.createdAt,
            costUsd: d.costUsd,
            attempts: d.attempts.length,
            image: shown === -1 ? null : d.attempts.length - 1 - shown,
            verdict: last?.verdict || null,
          };
        })
      );
    }

    m = p.match(/^\/api\/designs\/([a-f0-9]+)$/);
    if (req.method === 'GET' && m) {
      const d = store.getDesign(m[1]);
      return d ? send(res, 200, d) : send(res, 404, { error: 'No such design' });
    }

    m = p.match(/^\/api\/designs\/([a-f0-9]+)\/image\/(\d+)\/(thumb|preview|full)$/);
    if (req.method === 'GET' && m) {
      const file = imagePath(m[1], Number(m[2]), m[3]);
      if (!store.getDesign(m[1]) || !file || !fs.existsSync(file)) return send(res, 404, { error: 'No such image' });
      const type = { thumb: 'image/webp', preview: 'image/jpeg', full: 'image/png' }[m[3]];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }

    m = p.match(/^\/api\/designs\/([a-f0-9]+)\/reject$/);
    if (req.method === 'POST' && m) {
      const d = store.getDesign(m[1]);
      if (!d) return send(res, 404, { error: 'No such design' });
      if (d.status === 'passed') {
        d.status = 'rejected';
        d.reason = 'Binned by you.';
        store.saveDesigns();
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
