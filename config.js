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

  // ---- Studio: design + judge ----
  // Google image model on Vertex AI, billed to the Google Cloud project.
  imageModel: process.env.IMAGE_MODEL || 'gemini-3.1-flash-image',
  imageSize: process.env.IMAGE_SIZE || '2K', // 1K, 2K or 4K
  imageAspect: process.env.IMAGE_ASPECT || '3:4', // 3:4 fits 12x16 and 18x24 prints
  gcpProject: process.env.GCP_PROJECT || '', // blank = read from the VM
  googleApiBase: (process.env.GOOGLE_API_BASE || 'https://aiplatform.googleapis.com').replace(/\/$/, ''),
  gcpMetadataUrl: (process.env.GCP_METADATA_URL || 'http://metadata.google.internal').replace(/\/$/, ''),
  designBudget: num('DESIGN_RUN_BUDGET_USD', 2),
  maxDesignsPerRun: num('MAX_DESIGNS_PER_RUN', 6),
  maxRevisions: num('MAX_REVISIONS', 1),
  judgeMinScore: num('JUDGE_MIN_SCORE', 7),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
};
