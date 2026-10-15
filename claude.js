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

// Forces Claude to answer through one tool and returns that tool's input.
async function callForTool(job, { system, messages, tool, signal, maxTokens }) {
  const reply = await callClaude({
    system,
    messages,
    tools: [tool],
    toolChoice: { type: 'tool', name: tool.name },
    maxTokens,
    signal,
  });
  addUsage(job, reply.usage);
  const use = (reply.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!use) throw new Error(`Claude did not return ${tool.name}.`);
  return use.input;
}

module.exports = { callClaude, addUsage, callForTool };
