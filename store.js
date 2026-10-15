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

function create(task) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
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

module.exports = { create, get, list, save, flush, spentToday };
