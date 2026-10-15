'use strict';
// The job ledger: every task, its steps, tokens and cost, saved to data/jobs.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const FILE = path.join(config.dataDir, 'jobs.json');

let jobs = [];
try {
  jobs = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  jobs = [];
}
// Anything still "running" from before a restart can't be resumed.
for (const job of jobs) {
  if (job.status === 'running' || job.status === 'queued') {
    job.status = 'interrupted';
    job.error = 'The server restarted while this job was in progress.';
  }
}

function flush() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 1));
  fs.renameSync(tmp, FILE);
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
}

function localDay(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: config.timezone });
}

function create(task, extra = {}) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    kind: extra.kind || 'agent',
    params: extra.params || null,
    task,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    model: config.model,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    searches: 0,
    steps: [],
    result: null,
    error: null,
  };
  jobs.unshift(job);
  save();
  return job;
}

const get = (id) => jobs.find((j) => j.id === id);
const list = () => jobs;

function spentToday() {
  const today = localDay(new Date().toISOString());
  return jobs
    .filter((j) => localDay(j.createdAt) === today)
    .reduce((sum, j) => sum + j.costUsd, 0);
}

// ---- Designs made by the Studio (data/designs.json; images live in data/designs/) ----
const DESIGNS_FILE = path.join(config.dataDir, 'designs.json');
let designs = [];
try {
  designs = JSON.parse(fs.readFileSync(DESIGNS_FILE, 'utf8'));
} catch {
  designs = [];
}
for (const d of designs) {
  if (d.status === 'generating' || d.status === 'judging' || d.status === 'revising') {
    d.status = 'rejected';
    d.reason = 'The server restarted before this design was finished.';
  }
}

function flushDesigns() {
  const tmp = DESIGNS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(designs, null, 1));
  fs.renameSync(tmp, DESIGNS_FILE);
}
let designTimer = null;
function saveDesigns() {
  clearTimeout(designTimer);
  designTimer = setTimeout(flushDesigns, 250);
}

function createDesign(fields) {
  const design = {
    id: crypto.randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString(),
    status: 'generating',
    attempts: [],
    costUsd: 0,
    reason: null,
    ...fields,
  };
  designs.unshift(design);
  saveDesigns();
  return design;
}
const getDesign = (id) => designs.find((d) => d.id === id);
const listDesigns = () => designs;

function flushAll() {
  flush();
  flushDesigns();
}

module.exports = {
  create,
  get,
  list,
  save,
  flush: flushAll,
  spentToday,
  createDesign,
  getDesign,
  listDesigns,
  saveDesigns,
};
