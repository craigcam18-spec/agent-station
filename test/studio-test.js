'use strict';
// End-to-end test of the Studio (designer → image → judge → revise) against fake Claude and Google APIs.
// Run with: npm test
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const sharp = require('sharp');

const MOCK_PORT = 18921;
const APP_PORT = 18922;
const PASSWORD = 'test-password-123';
const seen = { judgeImages: [], googleAuth: [], revisions: 0 };

(async () => {
  const png = await sharp({
    create: { width: 1536, height: 2048, channels: 3, background: { r: 120, g: 60, b: 90 } },
  })
    .png()
    .toBuffer();

  // One fake server plays Claude, Google's image API and the VM metadata server.
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url.startsWith('/computeMetadata/v1/')) {
        assert.strictEqual(req.headers['metadata-flavor'], 'Google');
        if (req.url.endsWith('/token')) return json(200, { access_token: 'tok-123', expires_in: 3600 });
        if (req.url.endsWith('/project-id')) {
          res.writeHead(200);
          return res.end('gold-trading-bot-507515');
        }
      }

      if (req.url.includes(':generateContent')) {
        seen.googleAuth.push(req.headers.authorization);
        assert.match(req.url, /projects\/gold-trading-bot-507515\/locations\/global\/publishers\/google\/models\/gemini-3\.1-flash-image/);
        const r = JSON.parse(body);
        assert.deepStrictEqual(r.generationConfig.imageConfig, { aspectRatio: '3:4', imageSize: '2K' });
        const prompt = r.contents[0].parts[0].text;
        if (prompt.includes('AUTHFAIL')) return json(403, { error: { message: 'Request had insufficient authentication scopes.' } });
        if (prompt.includes('REFUSE')) return json(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] });
        return json(200, {
          candidates: [{ content: { parts: [{ text: 'Here you go' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }],
        });
      }

      if (req.url === '/v1/messages') {
        const r = JSON.parse(body);
        const tool = r.tool_choice?.name;
        const usage = { input_tokens: 2000, output_tokens: 300 };
        const reply = (input) =>
          json(200, { content: [{ type: 'tool_use', id: 'tu', name: tool, input }], stop_reason: 'tool_use', usage });
        const text = JSON.stringify(r.messages);

        if (tool === 'submit_briefs') {
          const count = Number(text.match(/exactly (\d+)/)[1]);
          const theme = (text.match(/Theme to design for: ([^\\"]+)/) || [])[1] || 'trends';
          const titles = ['Good Print', 'Fixable Print', 'Risky Print', 'Refused Print'];
          return reply({
            briefs: titles.slice(0, count).map((t) => ({ title: t, theme, prompt: `${t} about ${theme}`, why: 'Sells well.' })),
          });
        }
        if (tool === 'submit_verdict') {
          // Good passes; Fixable needs one revision; Risky is a clear IP problem.
          const images = r.messages[0].content.filter((b) => b.type === 'image');
          seen.judgeImages.push(images.length);
          const v = { print_quality: 8, sellability: 8, originality: 7, ip_risk: 'none', text_problems: false, defects: [], verdict: 'pass', feedback: 'Lovely.' };
          if (text.includes('Fixable Print')) {
            seen.fixable = (seen.fixable || 0) + 1;
            if (seen.fixable === 1) Object.assign(v, { print_quality: 5, verdict: 'revise', defects: ['Muddy corner'], feedback: 'Clean up the corner.' });
          }
          if (text.includes('Risky Print')) Object.assign(v, { ip_risk: 'clear', verdict: 'reject', feedback: 'Looks like a famous mouse.' });
          return reply(v);
        }
        if (tool === 'submit_prompt') {
          seen.revisions++;
          return reply({ prompt: 'REVISED: cleaner composition', change_summary: 'Simplified.' });
        }
      }
      json(404, { error: { message: 'mock: unknown ' + req.url } });
    });
  });

  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      GOOGLE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      GCP_METADATA_URL: `http://127.0.0.1:${MOCK_PORT}`,
      APP_PASSWORD: PASSWORD,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      DAILY_BUDGET_USD: '10',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => app.stdout.once('data', resolve));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function api(p, opts = {}, key = PASSWORD) {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, { ...opts, headers: { 'content-type': 'application/json', 'x-station-key': key } });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  async function waitFor(id, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const { body } = await api('/api/jobs/' + id);
      if (!['queued', 'running'].includes(body.status)) return body;
      await sleep(150);
    }
    throw new Error('timed out');
  }

  let failed = false;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (e) {
      failed = true;
      console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       '));
    }
  };

  await check('refuses a run with no theme and no trends note', async () => {
    const r = await api('/api/designs/run', { method: 'POST', body: JSON.stringify({ count: 2 }) });
    const job = await waitFor(r.body.id);
    assert.strictEqual(job.status, 'failed');
    assert.match(job.error, /trends/);
  });

  let runJob;
  await check('runs designer → image → judge → revise for 3 designs', async () => {
    const r = await api('/api/designs/run', { method: 'POST', body: JSON.stringify({ count: 3, theme: 'dark botanicals' }) });
    runJob = await waitFor(r.body.id);
    assert.strictEqual(runJob.status, 'done', runJob.error);
    assert.match(runJob.result, /2 of 3 designs passed/);
    // 4 images: Good(1) + Fixable(2) + Risky(1)
    assert.ok(Math.abs(runJob.imageUsd - 4 * 0.101) < 1e-9, 'imageUsd ' + runJob.imageUsd);
    assert.ok(runJob.claudeUsd > 0);
    assert.ok(Math.abs(runJob.costUsd - (runJob.imageUsd + runJob.claudeUsd)) < 1e-9);
    assert.strictEqual(seen.revisions, 1);
    assert.ok(seen.judgeImages.every((n) => n === 2), 'judge should get full view + crop');
    assert.ok(seen.googleAuth.every((a) => a === 'Bearer tok-123'));
  });

  let designs;
  await check('designs have the right outcomes', async () => {
    designs = (await api('/api/designs')).body;
    const by = Object.fromEntries(designs.map((d) => [d.title, d]));
    assert.strictEqual(by['Good Print'].status, 'passed');
    assert.strictEqual(by['Good Print'].attempts, 1);
    assert.strictEqual(by['Fixable Print'].status, 'passed');
    assert.strictEqual(by['Fixable Print'].attempts, 2);
    assert.strictEqual(by['Fixable Print'].image, 1);
    assert.strictEqual(by['Risky Print'].status, 'rejected');
    const full = (await api('/api/designs/' + by['Fixable Print'].id)).body;
    assert.strictEqual(full.attempts[0].outcome, 'revise');
    assert.match(full.attempts[1].prompt, /^REVISED/);
    assert.strictEqual(full.attempts[1].width, 1536);
  });

  await check('serves thumbnails, previews and full images (password needed)', async () => {
    const d = designs.find((x) => x.title === 'Good Print');
    const thumb = await api(`/api/designs/${d.id}/image/0/thumb`);
    assert.strictEqual(thumb.status, 200);
    assert.strictEqual(thumb.type, 'image/webp');
    const meta = await sharp(thumb.body).metadata();
    assert.ok(meta.height <= 600 && meta.width <= 600);
    const full = await api(`/api/designs/${d.id}/image/0/full`);
    assert.strictEqual((await sharp(full.body).metadata()).width, 1536);
    assert.strictEqual((await api(`/api/designs/${d.id}/image/0/thumb`, {}, 'wrong')).status, 401);
    assert.strictEqual((await api(`/api/designs/${d.id}/image/9/thumb`)).status, 404);
  });

  await check('bin button moves a passed design to rejected', async () => {
    const d = designs.find((x) => x.title === 'Good Print');
    await api(`/api/designs/${d.id}/reject`, { method: 'POST' });
    const after = (await api('/api/designs/' + d.id)).body;
    assert.strictEqual(after.status, 'rejected');
    assert.match(after.reason, /Binned/);
  });

  await check('a refused image gets a rewritten prompt instead of crashing', async () => {
    seen.revisions = 0;
    const r = await api('/api/designs/run', { method: 'POST', body: JSON.stringify({ count: 1, theme: 'REFUSE this' }) });
    const job = await waitFor(r.body.id);
    assert.strictEqual(job.status, 'done', job.error);
    assert.strictEqual(seen.revisions, 1);
    assert.ok(job.steps.some((s) => s.label === 'Image refused'));
  });

  await check('explains a Google permissions problem clearly', async () => {
    const r = await api('/api/designs/run', { method: 'POST', body: JSON.stringify({ count: 1, theme: 'AUTHFAIL' }) });
    const job = await waitFor(r.body.id);
    assert.strictEqual(job.status, 'failed');
    assert.match(job.error, /access scopes/);
  });

  await check('status reports studio settings', async () => {
    const s = (await api('/api/status')).body.studio;
    assert.strictEqual(s.imageModel, 'gemini-3.1-flash-image');
    assert.strictEqual(s.imagePrice, 0.101);
  });

  app.kill('SIGTERM');
  mock.close();
  await sleep(300);
  await check('designs saved to disk', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'designs.json'), 'utf8'));
    assert.ok(saved.length >= 4);
  });
  console.log(failed ? '\nSome studio tests failed.' : '\nAll studio tests passed.');
  process.exit(failed ? 1 : 0);
})();
