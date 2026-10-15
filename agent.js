'use strict';
// The agent loop: ask Claude, run any tools it asks for, send the results back, repeat until done.
const config = require('./config');
const store = require('./store');
const { tools } = require('./tools');

const running = new Map(); // job id -> { stopped, abort }

function systemPrompt() {
  const today = new Date().toLocaleDateString('en-GB', {
    timeZone: config.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return [
    "You are an agent working inside Agent Station, Craig's personal agent workspace.",
    `Today is ${today}. Craig is in the UK (${config.timezone}).`,
    'Complete the task using your tools when they help. Work step by step, check what you find, and stop as soon as the task is done.',
    'Use notes to keep anything worth reusing in later tasks, and check existing notes when a task builds on earlier work.',
    'Finish with a clear, concise answer. Include source links for facts you found on the web.',
  ].join('\n');
}

function toolList() {
  const list = Object.values(tools).map((t) => t.definition);
  if (config.webSearch) list.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  return list;
}

async function callClaude(messages, signal) {
  const res = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemPrompt(),
      tools: toolList(),
      messages,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${data?.error?.message || res.statusText}`);
  return data;
}

function addUsage(job, usage = {}) {
  const p = config.price;
  const input = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  job.inputTokens += input + cacheWrite + cacheRead;
  job.outputTokens += output;
  job.searches += searches;
  job.costUsd +=
    (input * p.input + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead + output * p.output) / 1e6 +
    searches * config.webSearchPrice;
}

function addStep(job, step) {
  job.steps.push({ at: new Date().toISOString(), ...step });
  store.save();
}

const clip = (s, n = 1500) => (s.length > n ? s.slice(0, n) + '…' : s);

async function runJob(job) {
  const ctl = { stopped: false, abort: new AbortController() };
  running.set(job.id, ctl);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  store.save();

  const messages = [{ role: 'user', content: job.task }];

  try {
    if (!config.apiKey) throw new Error('No ANTHROPIC_API_KEY set in .env');

    for (let step = 1; ; step++) {
      if (ctl.stopped) throw new Error('Stopped by you.');
      if (step > config.maxSteps) throw new Error(`Reached the step limit (${config.maxSteps}).`);
      if (job.costUsd >= config.jobBudget)
        throw new Error(`Reached this job's budget ($${config.jobBudget.toFixed(2)}).`);
      if (store.spentToday() >= config.dailyBudget)
        throw new Error(`Reached today's budget ($${config.dailyBudget.toFixed(2)}).`);

      const reply = await callClaude(messages, ctl.abort.signal);
      addUsage(job, reply.usage);
      const content = reply.content || [];
      messages.push({ role: 'assistant', content });

      const toolUses = content.filter((b) => b.type === 'tool_use');
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      // Log what happened in this turn, in order. Text only counts as "thinking"
      // when the agent is about to keep working; otherwise it's the final answer.
      const keepsGoing = toolUses.length > 0 || reply.stop_reason === 'pause_turn';
      for (const b of content) {
        if (b.type === 'server_tool_use' && b.name === 'web_search')
          addStep(job, { kind: 'search', label: 'Web search', detail: b.input?.query || '' });
        if (b.type === 'text' && keepsGoing && b.text.trim())
          addStep(job, { kind: 'thought', label: 'Thinking', detail: clip(b.text.trim()) });
      }

      // A long server-side search can pause the turn; send it straight back to continue.
      if (reply.stop_reason === 'pause_turn') continue;

      if (!toolUses.length) {
        job.result = text || '(No answer was returned.)';
        if (reply.stop_reason === 'max_tokens') job.result += '\n\n[Answer cut off at the length limit.]';
        job.status = 'done';
        break;
      }

      const results = [];
      for (const use of toolUses) {
        if (ctl.stopped) throw new Error('Stopped by you.');
        const tool = tools[use.name];
        const input = use.input || {};
        const shown =
          input.url || input.name || (Object.keys(input).length ? JSON.stringify(input) : use.name === 'read_note' ? 'All notes' : '');
        addStep(job, { kind: 'tool', label: tool?.label || use.name, detail: shown });
        let output;
        let isError = false;
        try {
          if (!tool) throw new Error(`Unknown tool "${use.name}".`);
          output = String(await tool.run(use.input || {}));
        } catch (err) {
          output = `Error: ${err.message}`;
          isError = true;
        }
        addStep(job, { kind: isError ? 'error' : 'result', label: isError ? 'Tool error' : 'Result', detail: clip(output, 600) });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: output, is_error: isError });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    job.status = ctl.stopped ? 'stopped' : 'failed';
    job.error = ctl.stopped ? 'Stopped by you.' : err.message;
  } finally {
    job.finishedAt = new Date().toISOString();
    running.delete(job.id);
    store.save();
  }
}

function stopJob(id) {
  const ctl = running.get(id);
  if (!ctl) return false;
  ctl.stopped = true;
  ctl.abort.abort();
  return true;
}

module.exports = { runJob, stopJob, isRunning: (id) => running.has(id) };
