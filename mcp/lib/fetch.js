const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20000;
const HOUR = 3600 * 1000;
const TTL = { moneypuck: 6 * HOUR, nhl: 1 * HOUR };

function defaultCacheDir() {
  return process.env.NHL_MCP_CACHE_DIR || path.join(__dirname, '..', '.cache');
}

// Creates fetchText/fetchJson with an on-disk cache.
// opts: { cacheDir, now(), fetchImpl, memo }
function createFetcher(opts = {}) {
  const cacheDir = opts.cacheDir || defaultCacheDir();
  const now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const memo = new Map();

  function cachePath(url) {
    return path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  }

  function readEntry(url) {
    try { return JSON.parse(fs.readFileSync(cachePath(url), 'utf8')); } catch (e) { return null; }
  }

  function writeEntry(url, entry) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath(url), JSON.stringify(entry));
    } catch (e) { /* cache is best-effort */ }
  }

  // ttl: ms, or Infinity (past seasons never expire), or 0 (no caching).
  async function fetchText(url, { ttl = TTL.nhl } = {}) {
    const t = now();
    const entry = readEntry(url);
    if (entry && ttl > 0 && t - entry.fetchedAt < ttl) {
      return { body: entry.body, fetchedAt: entry.fetchedAt, stale: false, cached: true };
    }
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: ctl.signal });
      } finally { clearTimeout(timer); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      const fresh = { fetchedAt: t, url, body };
      writeEntry(url, fresh);
      return { body, fetchedAt: t, stale: false, cached: false };
    } catch (err) {
      if (entry) return { body: entry.body, fetchedAt: entry.fetchedAt, stale: true, cached: true };
      const status = /HTTP (\d+)/.exec(err.message);
      const e = new Error(`Fetch failed for ${url}: ${status ? 'status ' + status[1] : err.message}`);
      e.url = url;
      throw e;
    }
  }

  async function fetchJson(url, o) {
    const r = await fetchText(url, o);
    return { ...r, data: JSON.parse(r.body) };
  }

  return { fetchText, fetchJson, cachePath };
}

module.exports = { createFetcher, TTL, UA };
