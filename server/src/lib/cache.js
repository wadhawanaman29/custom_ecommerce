// Small in-memory TTL cache for GET responses (catalog + CMS reads are the bulk of traffic).
//  - `clearOnWrite()` (app-level): any successful write (POST/PUT/PATCH/DELETE) empties the cache,
//    so data is never stale after admin edits.
//  - `cached()` (route-level, placed AFTER the permission middleware): caches 200 responses per
//    access tier, so a public visitor never receives a response built for an admin.
// For multiple server instances, swap the Map for Redis.
const config = require('../config');

const store = new Map();
const MAX_ENTRIES = 5000;

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { store.delete(key); return undefined; }
  return hit.value;
}

function set(key, value, ttl = config.cacheTtl) {
  if (ttl <= 0) return;
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(key, { value, expires: Date.now() + ttl * 1000 });
}

// Short-lived cache for COUNT(*) used by pagination headers. Counting millions of rows on every
// list request is expensive; totals may lag by a few seconds and are cleared on any write.
const counts = new Map();
async function cachedCount(key, fn, ttlMs = 30000) {
  const hit = counts.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  if (counts.size > 2000) counts.delete(counts.keys().next().value);
  counts.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

function clear() { store.clear(); counts.clear(); }

function clearOnWrite() {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.on('finish', () => { if (res.statusCode < 400) clear(); });
    }
    next();
  };
}

// anon = no credentials, staff = API key / admin / shop manager. Other users are not cached.
function tier(req) {
  if (!req.user) return 'anon';
  if (req.can && req.can('manage_woocommerce')) return 'staff';
  return null;
}

function stripCredentials(url) {
  return url.replace(/([?&])(consumer_key|consumer_secret|oauth_[a-z_]+)=[^&]*/g, '$1').replace(/[?&]+$/, '');
}

function cached(ttl) {
  return (req, res, next) => {
    const t = tier(req);
    if (config.cacheTtl <= 0 || !t || req.method !== 'GET') return next();
    const key = `${t}:${stripCredentials(req.originalUrl)}`;
    const hit = get(key);
    if (hit) {
      res.set(hit.headers);
      res.set('X-Cache', 'HIT');
      return res.status(200).json(hit.body);
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        const headers = {};
        for (const h of ['X-WP-Total', 'X-WP-TotalPages', 'Link']) {
          const v = res.get(h);
          if (v) headers[h] = v;
        }
        set(key, { body, headers }, ttl);
      }
      res.set('X-Cache', 'MISS');
      return json(body);
    };
    next();
  };
}

// Count with caching, keyed by model + where (BigInt-safe)
const countOf = (model, where) => cachedCount(`${model}:${JSON.stringify(where, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`, () => require('../db')[model].count({ where }));

module.exports = { get, set, clear, clearOnWrite, cached, cachedCount, countOf };
