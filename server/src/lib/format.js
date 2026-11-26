// Formatting helpers that reproduce WooCommerce REST output conventions.
const config = require('../config');

// Decimal | number | null → string with fixed decimals ("12.50"), like wc_format_decimal($v, $dp)
function money(v, dp = 2) {
  if (v === null || v === undefined || v === '') return (0).toFixed(dp);
  return Number(v).toFixed(dp);
}

// Product prices are returned as entered (no padding), "" when empty.
function price(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(6)));
}

const toNum = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

// Round half away from zero, to dp places
function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.sign(n) * Math.round(Math.abs(n) * f + Number.EPSILON) / f;
}

// "2024-05-03T10:20:30" in site time, plus the _gmt variant (WordPress REST format, no timezone suffix)
function wpDate(d, gmtOffsetHours = 0) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  const local = new Date(date.getTime() + gmtOffsetHours * 3600 * 1000);
  return local.toISOString().slice(0, 19);
}
const wpDateGmt = (d) => wpDate(d, 0);

// Parses a WP REST date. *_gmt values are UTC; local values are shifted by the site offset.
function parseWpDate(value, isGmt, gmtOffsetHours = 0) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  const hasTz = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
  const d = new Date(hasTz ? s : `${s}Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (!hasTz && !isGmt) return new Date(d.getTime() - gmtOffsetHours * 3600 * 1000);
  return d;
}

const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'yes';

function mediaUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `${config.siteUrl}/wp-content/uploads/${path.replace(/^\/+/, '')}`;
}

// meta_data in WC format: [{ id, key, value }]
function metaOut(meta) {
  if (!Array.isArray(meta)) return [];
  return meta.map((m, i) => ({ id: m.id ?? i + 1, key: m.key, value: m.value }));
}

// Merge incoming meta_data into stored list (update by id or key, delete when value is null)
function metaMerge(existing, incoming) {
  const list = Array.isArray(existing) ? existing.map((m) => ({ ...m })) : [];
  if (!Array.isArray(incoming)) return list;
  let nextId = list.reduce((mx, m) => Math.max(mx, m.id || 0), 0) + 1;
  for (const m of incoming) {
    if (!m || !m.key) continue;
    const idx = list.findIndex((x) => (m.id && x.id === m.id) || x.key === m.key);
    if (m.value === null) {
      if (idx >= 0) list.splice(idx, 1);
    } else if (idx >= 0) {
      list[idx].value = m.value;
    } else {
      list.push({ id: nextId++, key: m.key, value: m.value });
    }
  }
  return list;
}

module.exports = { money, price, toNum, round, wpDate, wpDateGmt, parseWpDate, bool, mediaUrl, metaOut, metaMerge };
