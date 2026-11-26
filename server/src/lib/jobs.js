// Small in-process background job runner (storewide sale apply/remove, bulk SKU generation…).
// One job per "kind" at a time; progress and logs are polled by the dashboard.
const crypto = require('crypto');

const jobs = [];
const running = new Map(); // kind → job

function start(kind, label, fn) {
  if (running.has(kind)) {
    const e = new Error(`A "${kind}" job is already running.`);
    e.status = 409;
    e.code = 'job_running';
    throw e;
  }
  const job = { id: crypto.randomBytes(6).toString('hex'), kind, label, status: 'running', progress: 0, total: 0, logs: [], result: null, error: null, startedAt: new Date(), finishedAt: null };
  jobs.unshift(job);
  if (jobs.length > 50) jobs.pop();
  running.set(kind, job);
  const ctx = {
    log: (line) => { job.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`); if (job.logs.length > 1000) job.logs.splice(0, 200); },
    progress: (done, total) => { job.progress = done; if (total !== undefined) job.total = total; },
  };
  Promise.resolve().then(() => fn(ctx))
    .then((result) => { job.status = 'done'; job.result = result || null; })
    .catch((e) => { job.status = 'failed'; job.error = e.message; ctx.log(`ERROR: ${e.message}`); })
    .finally(() => { job.finishedAt = new Date(); running.delete(kind); require('./cache').clear(); });
  return job;
}

const get = (id) => jobs.find((j) => j.id === id) || null;
const latest = (kind) => jobs.find((j) => j.kind === kind) || null;
const out = (j, since = 0) => j && ({
  id: j.id, kind: j.kind, label: j.label, status: j.status, progress: j.progress, total: j.total, result: j.result, error: j.error,
  started_at: j.startedAt, finished_at: j.finishedAt, log_count: j.logs.length, logs: j.logs.slice(since),
});

module.exports = { start, get, latest, out };
