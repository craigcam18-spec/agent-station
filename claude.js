'use strict';
// Shared helpers for calling the Claude API and adding up what it costs.
const config = require('./config');
const { fetchJson } = require('./net');

async function callClaude({ system, messages, tools, toolChoice, maxTokens, signal }) {
  const body = {
    model: config.model,
    max_tokens: maxTokens || config.maxTokens,
    system,
    messages,
  };
  if (tools && tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  const res = await fetchJson(
    `${config.baseUrl}/v1/messages`,
    {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    },
    { label: 'Claude API' }
  );
  if (!res.ok) {
    const err = new Error(`Claude API error ${res.status}: ${res.data?.error?.message || res.statusText}`);
    err.fatal = [400, 401, 403, 404].includes(res.status); // a setup problem: retrying other designs won't help
    throw err;
  }
  return res.data;
}

// Adds a reply's token usage (and any web searches) to a job's running totals.
function addUsage(job, usage = {}) {
  const p = config.price;
  const input = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  const cost =
    (input * p.input + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead + output * p.output) / 1e6 +
    searches * config.webSearchPrice;
  job.inputTokens += input + cacheWrite + cacheRead;
  job.outputTokens += output;
  job.searches += searches;
  job.claudeUsd = (job.claudeUsd || 0) + cost;
  job.costUsd += cost;
}

// Asks Claude to answer through one tool and returns that tool's input.
// Newer models don't accept a forced tool_choice, so we ask in the prompt and
// nudge once if the reply comes back as plain text instead.
async function callForTool(job, { system, messages, tool, signal, maxTokens }) {
  const sys = `${system}\n\nAlways give your answer by calling the ${tool.name} tool. Do not answer in plain text.`;
  let convo = [...messages];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await callClaude({ system: sys, messages: convo, tools: [tool], maxTokens, signal });
    addUsage(job, reply.usage);
    const content = reply.content || [];
    const use = content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (use) return use.input;
    convo = [
      ...convo,
      { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no answer)' }] },
      { role: 'user', content: `Please give that answer now by calling the ${tool.name} tool.` },
    ];
  }
  throw new Error(`Claude did not return ${tool.name}.`);
}

module.exports = { callClaude, addUsage, callForTool };
