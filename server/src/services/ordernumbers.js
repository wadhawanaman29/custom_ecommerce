// Order numbers (replaces "WooCommerce Basic Ordernumbers").
// Disabled → order number = order ID (WooCommerce default).
// Enabled  → format with {counter} {YYYY} {YY} {MM} {DD}; the counter is a DB row incremented atomically
// (UPDATE … SET value = LAST_INSERT_ID(value + 1) on one connection), so concurrent checkouts never share a number.
const prisma = require('../db');
const options = require('../lib/options');

async function settings() {
  const o = await options.getOptions(['ordernumbers_enabled', 'ordernumbers_format', 'ordernumbers_counter_digits', 'ordernumbers_counter_start', 'ordernumbers_reset', 'gmt_offset']);
  return {
    enabled: o.ordernumbers_enabled === 'yes',
    format: String(o.ordernumbers_format || '{counter}'),
    digits: Math.max(0, Math.min(12, parseInt(o.ordernumbers_counter_digits, 10) || 0)),
    start: Math.max(0, parseInt(o.ordernumbers_counter_start, 10) || 1),
    reset: o.ordernumbers_reset || 'never',
    gmtOffset: parseFloat(o.gmt_offset) || 0,
  };
}

function localParts(date, gmtOffset) {
  const d = new Date(date.getTime() + gmtOffset * 3600000);
  const pad = (x) => String(x).padStart(2, '0');
  return { YYYY: String(d.getUTCFullYear()), YY: String(d.getUTCFullYear()).slice(2), MM: pad(d.getUTCMonth() + 1), DD: pad(d.getUTCDate()) };
}

// Counter name per reset period: order_number, order_number:2026, order_number:2026-11, …
function counterName(s, p) {
  if (s.reset === 'yearly') return `order_number:${p.YYYY}`;
  if (s.reset === 'monthly') return `order_number:${p.YYYY}-${p.MM}`;
  if (s.reset === 'daily') return `order_number:${p.YYYY}-${p.MM}-${p.DD}`;
  return 'order_number';
}

const render = (s, p, counter) => s.format
  .replace(/\{counter\}/g, s.digits ? String(counter).padStart(s.digits, '0') : String(counter))
  .replace(/\{YYYY\}/g, p.YYYY).replace(/\{YY\}/g, p.YY).replace(/\{MM\}/g, p.MM).replace(/\{DD\}/g, p.DD);

// First use of a counter: continue after the highest existing numeric order number (so migrated
// WordPress order numbers carry on), otherwise start at the configured value.
async function initialValue(db, s, name) {
  if (name === 'order_number') {
    const [row] = await db.$queryRawUnsafe("SELECT MAX(CAST(REGEXP_SUBSTR(number, '[0-9]+$') AS UNSIGNED)) AS m FROM `Order`");
    const max = row && row.m !== null ? Number(row.m) : 0;
    return Math.max(max, s.start - 1);
  }
  return s.start - 1;
}

async function nextCounter(db, s, name) {
  const exists = await db.counter.findUnique({ where: { name } });
  if (!exists) await db.$executeRawUnsafe('INSERT IGNORE INTO Counter (name, value) VALUES (?, ?)', name, await initialValue(db, s, name));
  await db.$executeRawUnsafe('UPDATE Counter SET value = LAST_INSERT_ID(value + 1) WHERE name = ?', name);
  const [r] = await db.$queryRawUnsafe('SELECT LAST_INSERT_ID() AS v');
  return Number(r.v);
}

// db: a transaction client (interactive $transaction) so the counter UPDATE/SELECT share a connection
async function assignNumber(db, order) {
  const s = await settings();
  if (!s.enabled) return String(order.id);
  const p = localParts(order.createdAt || new Date(), s.gmtOffset);
  return render(s, p, await nextCounter(db, s, counterName(s, p)));
}

// Admin: preview / set the counter for the current period
async function status() {
  const s = await settings();
  const p = localParts(new Date(), s.gmtOffset);
  const name = counterName(s, p);
  const row = await prisma.counter.findUnique({ where: { name } });
  const current = row ? row.value : await initialValue(prisma, s, name);
  return { ...s, counter_name: name, current, next_number: s.enabled ? render(s, p, current + 1) : '(order ID)' };
}
async function setCounter(value) {
  const s = await settings();
  const name = counterName(s, localParts(new Date(), s.gmtOffset));
  const v = Math.max(0, parseInt(value, 10) || 0);
  await prisma.counter.upsert({ where: { name }, create: { name, value: v }, update: { value: v } });
  return status();
}

module.exports = { assignNumber, status, setCounter };
