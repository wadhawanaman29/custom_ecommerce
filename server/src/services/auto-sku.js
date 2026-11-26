// Auto SKU (replaces "Easy Auto SKU Generator for WooCommerce").
// On save, products/variations without a SKU get one: variations = parent SKU + attribute values
// (or variation ID); products = prefix + ID/slug. Always unique (suffix -2, -3… if taken).
const prisma = require('../db');
const options = require('../lib/options');

async function settings() {
  const o = await options.getOptions(['auto_sku_enabled', 'auto_sku_variations', 'auto_sku_variation_format', 'auto_sku_products', 'auto_sku_product_format', 'auto_sku_prefix', 'auto_sku_separator', 'auto_sku_uppercase']);
  return {
    enabled: o.auto_sku_enabled === 'yes',
    variations: o.auto_sku_variations !== 'no',
    variationFormat: o.auto_sku_variation_format || 'attributes',
    products: o.auto_sku_products === 'yes',
    productFormat: o.auto_sku_product_format || 'id',
    prefix: String(o.auto_sku_prefix || ''),
    sep: o.auto_sku_separator === undefined || o.auto_sku_separator === null ? '-' : String(o.auto_sku_separator),
    upper: o.auto_sku_uppercase !== 'no',
  };
}

const clean = (v) => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function unique(base, selfId) {
  let sku = base.slice(0, 100);
  for (let n = 2; await prisma.product.findFirst({ where: { sku, NOT: { id: selfId } }, select: { id: true } }); n++) sku = `${base.slice(0, 95)}-${n}`;
  return sku;
}

function build(p, parent, s) {
  const join = (parts) => parts.filter(Boolean).join(s.sep);
  let base;
  if (p.type === 'variation') {
    const root = (parent && parent.sku) || join([s.prefix, parent ? parent.id : p.parentId]);
    base = s.variationFormat === 'id' ? join([root, p.id]) : join([root, ...(p.variationAttributes || []).map((a) => clean(a.option)).filter(Boolean)]);
    if (base === root) base = join([root, p.id]);
  } else {
    base = join([s.prefix, s.productFormat === 'slug' ? clean(p.slug) : p.id]);
  }
  return s.upper ? base.toUpperCase() : base;
}

// Called after a product/variation is saved. Returns the new SKU (or null).
async function ensureSku(productId, s = null) {
  const cfg = s || await settings();
  if (!cfg.enabled) return null;
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, type: true, sku: true, slug: true, parentId: true, variationAttributes: true, parent: { select: { id: true, sku: true } } } });
  if (!p || p.sku) return null;
  if (p.type === 'variation' ? !cfg.variations : !cfg.products) return null;
  const sku = await unique(build(p, p.parent, cfg), p.id);
  await prisma.product.update({ where: { id: p.id }, data: { sku } });
  return sku;
}

// Bulk: fill every missing SKU (job)
async function generateMissing(ctx) {
  const cfg = await settings();
  if (!cfg.enabled) throw new Error('Enable Auto SKU first.');
  const types = [...(cfg.products ? ['simple', 'variable', 'grouped', 'external'] : []), ...(cfg.variations ? ['variation'] : [])];
  // Parents first so variations can use their new parent SKU
  const order = types.filter((t) => t !== 'variation').concat(types.includes('variation') ? ['variation'] : []);
  let done = 0;
  let made = 0;
  const total = await prisma.product.count({ where: { sku: null, status: { not: 'trash' }, type: { in: types } } });
  ctx.log(`${total} products/variations without a SKU`);
  for (const group of [order.filter((t) => t !== 'variation'), ['variation']]) {
    if (!group.length || !group.every((t) => types.includes(t))) continue;
    let lastId = 0;
    for (;;) {
      const rows = await prisma.product.findMany({ where: { sku: null, status: { not: 'trash' }, type: { in: group }, id: { gt: lastId } }, orderBy: { id: 'asc' }, take: 500, select: { id: true } });
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;
      for (const r of rows) { if (await ensureSku(r.id, cfg)) made++; }
      done += rows.length;
      ctx.progress(done, total);
    }
  }
  ctx.log(`Done: ${made} SKUs generated.`);
  return { generated: made };
}

module.exports = { ensureSku, generateMissing, settings };
