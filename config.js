'use strict';
// Loads settings from .env (no extra packages needed) and exposes them to the app.
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv(path.join(__dirname, '.env'));

const num = (key, fallback) => {
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
};

// USD per million tokens. Check https://claude.com/pricing if these change.
const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

const model = process.env.MODEL || 'claude-sonnet-5-5';
const price = PRICES[model] || {
  input: num('PRICE_INPUT_PER_MTOK', 2),
  output: num('PRICE_OUTPUT_PER_MTOK', 10),
  cacheWrite: num('PRICE_INPUT_PER_MTOK', 2) * 1.25,
  cacheRead: num('PRICE_INPUT_PER_MTOK', 2) * 0.1,
};

module.exports = {
  port: num('PORT', 8787),
  host: process.env.HOST || '0.0.0.0',
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  model,
  price,
  maxTokens: num('MAX_TOKENS', 4096),
  maxSteps: num('MAX_STEPS', 15),
  jobBudget: num('JOB_BUDGET_USD', 0.5),
  dailyBudget: num('DAILY_BUDGET_USD', 2),
  password: process.env.APP_PASSWORD || '',
  webSearch: (process.env.WEB_SEARCH || 'on') !== 'off',
  webSearchPrice: 0.01, // $10 per 1,000 searches
  timezone: process.env.TIMEZONE || 'Europe/London',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
};
