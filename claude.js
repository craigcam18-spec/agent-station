'use strict';
// Shared helpers for calling the Claude API and adding up what it costs.
const config = require('./config');

async function callClaude({ system, messages, tools, toolChoice, maxTokens, signal }) {
  const body = {
    model: config.model,
    max_tokens: maxTokens || config.maxTokens,
    system,
    messages,
  };
  if (tools && tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  const res = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${data?.error?.message || res.statusText}`);
  return data;
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
