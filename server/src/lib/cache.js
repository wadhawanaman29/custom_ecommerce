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

function clear() { store.clear(); }

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

module.exports = { get, set, clear, clearOnWrite, cached };
