'use strict';
// End-to-end test against a fake Claude API, so it costs nothing and needs no key.
// Run with: npm test
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const MOCK_PORT = 18901;
const APP_PORT = 18902;
const PASSWORD = 'test-password-123';

// ---- Fake Claude API ----
let calls = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls++;
    const reqJson = JSON.parse(body);
    const task = reqJson.messages[0].content;
    const last = reqJson.messages[reqJson.messages.length - 1];
    const reply = (content, stop_reason, usage = { input_tokens: 1000, output_tokens: 200 }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content, stop_reason, usage }));
    };

    if (task.startsWith('SLOW')) return setTimeout(() => reply([{ type: 'text', text: 'late' }], 'end_turn'), 5000);
    if (task.startsWith('EXPENSIVE')) {
      return reply(
        [{ type: 'tool_use', id: 'tu_x', name: 'read_note', input: {} }],
        'tool_use',
        { input_tokens: 400000, output_tokens: 10000 }
      );
    }
    if (task.startsWith('BADTOOL')) {
      if (last.role === 'user' && Array.isArray(last.content)) {
        return reply([{ type: 'text', text: 'Tool failed: ' + last.content[0].content }], 'end_turn');
      }
      return reply([{ type: 'tool_use', id: 'tu_b', name: 'fetch_url', input: { url: 'http://169.254.169.254/' } }], 'tool_use');
    }
    // Default: save a note, then answer.
    if (last.role === 'user' && Array.isArray(last.content)) {
      assert.strictEqual(last.content[0].tool_use_id, 'tu_1');
      return reply([{ type: 'text', text: 'Done. Saved your trends. See https://example.com' }], 'end_turn');
    }
    return reply(
      [
        { type: 'text', text: 'I will save that.' },
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'etsy trends' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
        { type: 'tool_use', id: 'tu_1', name: 'save_note', input: { name: 'Trends', content: '1. Botanical prints' } },
      ],
      'tool_use',
      { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 1 } }
    );
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}, key = PASSWORD) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-station-key': key },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitFor(id, done = (j) => !['queued', 'running'].includes(j.status), ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { body } = await api('/api/jobs/' + id);
    if (done(body)) return body;
    await sleep(150);
  }
  throw new Error('Timed out waiting for job ' + id);
}

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-test-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      APP_PASSWORD: PASSWORD,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      JOB_BUDGET_USD: '0.50',
      DAILY_BUDGET_USD: '5',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => app.stdout.once('data', resolve));

  let failed = false;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (e) {
      failed = true;
      console.log('  FAIL ' + name + '\n       ' + e.message);
    }
  };

  await check('rejects wrong password', async () => {
    const r = await api('/api/status', {}, 'nope');
    assert.strictEqual(r.status, 401);
  });

  await check('dashboard page loads', async () => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/`);
    assert.strictEqual(r.status, 200);
    assert.match(await r.text(), /AGENT <span>STATION/);
  });

  await check('runs a task with a tool, logs steps and cost', async () => {
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ task: 'Find trends and save them' }) });
    assert.strictEqual(r.status, 201);
    const job = await waitFor(r.body.id);
    assert.strictEqual(job.status, 'done', job.error);
    assert.match(job.result, /Saved your trends/);
    assert.deepStrictEqual(job.steps.map((s) => s.kind), ['thought', 'search', 'tool', 'result']);
    assert.strictEqual(job.searches, 1);
    // 2 calls x (1000 in * $2 + 200 out * $10) / 1M + 1 search * $0.01 = 0.008 + 0.01
    assert.ok(Math.abs(job.costUsd - 0.018) < 1e-9, 'cost was ' + job.costUsd);
  });

  await check('note was saved and is readable', async () => {
    const list = await api('/api/notes');
    assert.strictEqual(list.body[0].name, 'trends');
    const note = await api('/api/notes/trends');
    assert.strictEqual(note.body.content, '1. Botanical prints');
  });

  await check('blocks private addresses and reports the tool error', async () => {
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ task: 'BADTOOL' }) });
    const job = await waitFor(r.body.id);
    assert.strictEqual(job.status, 'done');
    assert.match(job.result, /blocked/);
    assert.ok(job.steps.some((s) => s.kind === 'error'));
  });

  await check('stops at the per-job budget', async () => {
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ task: 'EXPENSIVE' }) });
    const job = await waitFor(r.body.id);
    assert.strictEqual(job.status, 'failed');
    assert.match(job.error, /budget/);
  });

  await check('stop button interrupts a running job and a queued one', async () => {
    const a = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ task: 'SLOW one' }) });
    const b = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ task: 'SLOW two' }) });
    await waitFor(a.body.id, (j) => j.status === 'running');
    await api(`/api/jobs/${b.body.id}/stop`, { method: 'POST' });
    await api(`/api/jobs/${a.body.id}/stop`, { method: 'POST' });
    const ja = await waitFor(a.body.id);
    const jb = await waitFor(b.body.id);
    assert.strictEqual(ja.status, 'stopped');
    assert.strictEqual(jb.status, 'stopped');
  });

  await check('status reports spend and tools', async () => {
    const s = await api('/api/status');
    assert.ok(s.body.spentToday > 0);
    assert.ok(s.body.tools.includes('Web search'));
  });

  await check('rejects an empty task', async () => {
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ task: '  ' }) });
    assert.strictEqual(r.status, 400);
  });

  app.kill('SIGTERM');
  mock.close();
  await sleep(300);
  await check('ledger saved to disk on shutdown', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.strictEqual(saved.length, 5);
    assert.ok(saved.every((j) => !['queued', 'running'].includes(j.status)));
  });
  console.log(failed ? '\nSome tests failed.' : '\nAll tests passed.');
  process.exit(failed ? 1 : 0);
})();
