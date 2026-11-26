// Storewide Sale (replaces the "Storewide Sale" plugin).
// apply(): sets sale prices (and schedule) on every matching product/variation, in batches.
//          The product's own previous sale (price + dates) is backed up in meta "_storewide_sale".
// remove(): restores the backups exactly. Re-applying with new settings recomputes from the backup.
const prisma = require('../db');
const options = require('../lib/options');
const { parseWpDate, round } = require('../lib/format');
const { isOnSale } = require('../serializers/product');
const { syncVariableParent } = require('./product');

const KEY = '_storewide_sale';
const BATCH = 500;

async function settings() {
  const o = await options.getOptions([
    'storewide_sale_discount_type', 'storewide_sale_amount', 'storewide_sale_scope', 'storewide_sale_categories', 'storewide_sale_exclude_products',
    'storewide_sale_skip_on_sale', 'storewide_sale_start', 'storewide_sale_end', 'storewide_sale_rounding', 'gmt_offset',
  ]);
  const ids = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => parseInt(x, 10)).filter(Boolean);
  const gmt = parseFloat(o.gmt_offset) || 0;
  return {
    type: o.storewide_sale_discount_type === 'fixed' ? 'fixed' : 'percent',
    amount: Number(o.storewide_sale_amount) || 0,
    scope: o.storewide_sale_scope || 'all',
    categories: ids(o.storewide_sale_categories),
    excludeProducts: ids(o.storewide_sale_exclude_products),
    skipOnSale: o.storewide_sale_skip_on_sale !== 'no',
    start: o.storewide_sale_start ? parseWpDate(o.storewide_sale_start, false, gmt) : null,
    end: o.storewide_sale_end ? parseWpDate(o.storewide_sale_end, false, gmt) : null,
    rounding: o.storewide_sale_rounding || 'none',
  };
}

function salePriceFor(regular, s) {
  let p = s.type === 'percent' ? regular * (1 - s.amount / 100) : regular - s.amount;
  if (s.rounding === 'whole') p = Math.round(p);
  else if (s.rounding === '99') p = Math.max(0, Math.floor(p)) + 0.99;
  else if (s.rounding === '95') p = Math.max(0, Math.floor(p)) + 0.95;
  p = round(p, 2);
  return p > 0 && p < regular ? p : null;
}

// Products/variations in scope (variations use their parent's categories)
function scopeWhere(s) {
  const where = { status: { not: 'trash' }, type: { in: ['simple', 'external', 'variation'] }, regularPrice: { not: null } };
  const AND = [];
  if (s.excludeProducts.length) AND.push({ id: { notIn: s.excludeProducts } }, { OR: [{ parentId: null }, { parentId: { notIn: s.excludeProducts } }] });
  if (s.scope !== 'all' && s.categories.length) {
    const inCats = { categories: { some: { id: { in: s.categories } } } };
    const match = { OR: [{ type: { in: ['simple', 'external'] }, ...inCats }, { type: 'variation', parent: inCats }] };
    AND.push(s.scope === 'categories' ? match : { NOT: match });
  }
  if (AND.length) where.AND = AND;
  return where;
}

const backupOf = (p) => (Array.isArray(p.meta) ? p.meta.find((m) => m.key === KEY) : null);

async function apply(ctx) {
  const s = await settings();
  if (!(s.amount > 0) || (s.type === 'percent' && s.amount >= 100)) throw new Error('Set a discount greater than 0 (and below 100%).');
  if (s.end && s.start && s.end <= s.start) throw new Error('The end date must be after the start date.');
  const where = scopeWhere(s);
  const total = await prisma.product.count({ where });
  ctx.log(`Applying ${s.type === 'percent' ? `${s.amount}%` : s.amount} off to up to ${total} products/variations…`);
  let lastId = 0;
  let done = 0;
  let changed = 0;
  let skipped = 0;
  const now = new Date();
  for (;;) {
    const rows = await prisma.product.findMany({ where: { ...where, id: { gt: lastId } }, orderBy: { id: 'asc' }, take: BATCH, select: { id: true, parentId: true, regularPrice: true, salePrice: true, dateOnSaleFrom: true, dateOnSaleTo: true, meta: true } });
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    const updates = [];
    const parents = new Set();
    for (const p of rows) {
      const backup = backupOf(p);
      // A product with its own (non-storewide) active/scheduled sale is left alone when "skip" is on
      if (!backup && s.skipOnSale && p.salePrice !== null) { skipped++; continue; }
      const sale = salePriceFor(Number(p.regularPrice), s);
      if (sale === null) { skipped++; continue; }
      const meta = (Array.isArray(p.meta) ? p.meta.filter((m) => m.key !== KEY) : []);
      meta.push({ id: 9100, key: KEY, value: backup ? backup.value : { salePrice: p.salePrice === null ? null : Number(p.salePrice), dateOnSaleFrom: p.dateOnSaleFrom, dateOnSaleTo: p.dateOnSaleTo } });
      const next = { salePrice: sale, dateOnSaleFrom: s.start, dateOnSaleTo: s.end };
      const onSale = isOnSale({ ...p, ...next }, now);
      updates.push(prisma.product.update({ where: { id: p.id }, data: { ...next, price: onSale ? sale : p.regularPrice, meta } }));
      if (p.parentId) parents.add(p.parentId);
      changed++;
    }
    if (updates.length) await prisma.$transaction(updates);
    for (const id of parents) await syncVariableParent(id);
    done += rows.length;
    ctx.progress(done, total);
  }
  const status = { state: 'active', applied_at: new Date(), changed, skipped, settings: { ...s, start: s.start, end: s.end } };
  await options.setOption('storewide_sale_status', status);
  ctx.log(`Done: ${changed} on sale, ${skipped} skipped.`);
  return status;
}

async function remove(ctx) {
  // Products carrying a backup (JSON_CONTAINS partial match on the meta array)
  const where = { meta: { array_contains: [{ key: KEY }] } };
  const total = await prisma.product.count({ where });
  ctx.log(`Restoring ${total} products/variations…`);
  let lastId = 0;
  let done = 0;
  const now = new Date();
  for (;;) {
    const rows = await prisma.product.findMany({ where: { ...where, id: { gt: lastId } }, orderBy: { id: 'asc' }, take: BATCH, select: { id: true, parentId: true, regularPrice: true, meta: true } });
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    const updates = [];
    const parents = new Set();
    for (const p of rows) {
      const b = (backupOf(p) || {}).value || {};
      const restored = {
        salePrice: b.salePrice === null || b.salePrice === undefined ? null : Number(b.salePrice),
        dateOnSaleFrom: b.dateOnSaleFrom ? new Date(b.dateOnSaleFrom) : null,
        dateOnSaleTo: b.dateOnSaleTo ? new Date(b.dateOnSaleTo) : null,
      };
      const onSale = restored.salePrice !== null && isOnSale({ ...p, ...restored }, now);
      updates.push(prisma.product.update({ where: { id: p.id }, data: { ...restored, price: onSale ? restored.salePrice : p.regularPrice, meta: p.meta.filter((m) => m.key !== KEY) } }));
      if (p.parentId) parents.add(p.parentId);
    }
    await prisma.$transaction(updates);
    for (const id of parents) await syncVariableParent(id);
    done += rows.length;
    ctx.progress(done, total);
  }
  const status = { state: 'none', removed_at: new Date(), restored: done };
  await options.setOption('storewide_sale_status', status);
  ctx.log(`Done: ${done} restored.`);
  return status;
}

async function status() {
  const st = await options.getOption('storewide_sale_status', null);
  const active = await prisma.product.count({ where: { meta: { array_contains: [{ key: KEY }] } } });
  return { ...(st || { state: 'none' }), products_on_storewide_sale: active };
}

module.exports = { apply, remove, status, settings, KEY };
