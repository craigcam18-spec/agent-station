'use strict';
// fetch with retries for network blips and busy servers (429 / 5xx).
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const WAITS = (process.env.NET_RETRY_WAITS || '2000,6000,15000').split(',').map(Number);

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('Stopped by you.'));
    });
  });

// Turns Node's vague "fetch failed" into something with the real reason in it.
function describe(err) {
  const c = err.cause;
  const why = c?.code || c?.message;
  return why ? `${err.message} (${why})` : err.message;
}

// Fetches and reads a JSON reply, retrying if the connection drops (even mid-download)
// or the server is busy. Returns { ok, status, data }.
async function fetchJson(url, opts = {}, { label = 'request', timeoutMs = 180000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await fetch(url, { ...opts, signal });
      if (!RETRY_STATUS.has(res.status) || attempt >= WAITS.length) {
        const text = await res.text(); // a dropped download throws here and gets retried
        let data = {};
        try {
          data = JSON.parse(text);
        } catch {
          if (res.ok) throw new Error('reply was cut off');
        }
        return { ok: res.ok, status: res.status, statusText: res.statusText, data };
      }
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      if (opts.signal?.aborted) throw err; // stopped by the user: don't retry
      if (attempt >= WAITS.length) {
        const e = new Error(
          timeout.aborted
            ? `${label} timed out after ${timeoutMs / 1000}s (tried ${attempt + 1} times)`
            : `${label} failed: ${describe(err)} (tried ${attempt + 1} times)`
        );
        e.network = true;
        throw e;
      }
    }
    await sleep(WAITS[attempt], opts.signal);
  }
}

module.exports = { fetchJson };
