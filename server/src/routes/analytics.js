// /wp-json/custom/v1/admin/analytics/* — WooCommerce Analytics equivalents.
// Definitions follow WooCommerce Analytics:
//   gross sales = net order total (excl. tax & shipping) + coupons
//   returns     = refunds dated in the period
//   net sales   = gross − returns − coupons
//   total sales = net sales + taxes + shipping
// Orders with an "excluded" status (default: pending, failed, cancelled) are ignored, like WC.
const express = require('express');
const prisma = require('../db');
const { ah, badRequest } = require('../lib/http');
const options = require('../lib/options');
const { can } = require('../middleware/auth');

const router = express.Router();
router.use(can('view_woocommerce_reports'));

const DEFAULT_EXCLUDED = ['pending', 'failed', 'cancelled'];
const ALWAYS_EXCLUDED = ['trash', 'checkout-draft'];
const n = (v) => (v === null || v === undefined ? 0 : Number(v));
const r2 = (v) => Math.round(n(v) * 100) / 100;

async function context(req) {
  const s = await options.store();
  const offsetMin = Math.round((s.gmtOffset || 0) * 60);
  let excluded = await options.getOption('woocommerce_excluded_report_order_statuses', DEFAULT_EXCLUDED);
  if (!Array.isArray(excluded)) excluded = DEFAULT_EXCLUDED;
  const statuses = [...new Set([...excluded.map((x) => String(x).replace(/^wc-/, '')), ...ALWAYS_EXCLUDED])];
  const parse = (v, name) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) throw badRequest('rest_invalid_param', `Invalid parameter(s): ${name} (YYYY-MM-DD)`);
    return v;
  };
  const after = parse(req.query.after, 'after');
  const before = parse(req.query.before, 'before');
  // Local site dates → UTC instants (before is inclusive → end of that day)
  const start = new Date(new Date(`${after}T00:00:00Z`).getTime() - offsetMin * 60000);
  const end = new Date(new Date(`${before}T00:00:00Z`).getTime() + 86400000 - offsetMin * 60000);
  if (end <= start) throw badRequest('rest_invalid_param', '"before" must be on or after "after".');
  return { s, offsetMin, statuses, after, before, start, end };
}
const inList = (arr) => arr.map(() => '?').join(',');

// Daily aggregates for orders, refunds and items in [start, end)
async function daily(ctx) {
  const { offsetMin, statuses, start, end } = ctx;
  const ex = inList(statuses);
  const [orders, refunds, items] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT DATE(DATE_ADD(o.createdAt, INTERVAL ? MINUTE)) AS d, COUNT(*) AS orders_count,
        SUM(o.total - o.totalTax - o.shippingTotal) AS net_total, SUM(o.discountTotal) AS coupons,
        SUM(o.totalTax) AS taxes, SUM(o.shippingTotal) AS shipping,
        SUM(CASE WHEN o.discountTotal > 0 THEN 1 ELSE 0 END) AS discounted_orders
      FROM \`Order\` o
      WHERE o.createdAt >= ? AND o.createdAt < ? AND o.status NOT IN (${ex})
      GROUP BY d`, offsetMin, start, end, ...statuses),
    prisma.$queryRawUnsafe(`
      SELECT DATE(DATE_ADD(r.createdAt, INTERVAL ? MINUTE)) AS d, SUM(r.amount) AS refunds
      FROM OrderRefund r JOIN \`Order\` o ON o.id = r.orderId
      WHERE r.createdAt >= ? AND r.createdAt < ? AND o.status NOT IN (${ex})
      GROUP BY d`, offsetMin, start, end, ...statuses),
    prisma.$queryRawUnsafe(`
      SELECT DATE(DATE_ADD(o.createdAt, INTERVAL ? MINUTE)) AS d, SUM(oi.quantity) AS items
      FROM OrderItem oi JOIN \`Order\` o ON o.id = oi.orderId
      WHERE oi.type = 'line_item' AND o.createdAt >= ? AND o.createdAt < ? AND o.status NOT IN (${ex})
      GROUP BY d`, offsetMin, start, end, ...statuses),
  ]);
  const key = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const map = new Map();
  const get = (d) => {
    const k = key(d);
    if (!map.has(k)) map.set(k, { orders_count: 0, net_total: 0, coupons: 0, taxes: 0, shipping: 0, refunds: 0, items: 0, discounted_orders: 0 });
    return map.get(k);
  };
  for (const o of orders) Object.assign(get(o.d), { orders_count: n(o.orders_count), net_total: n(o.net_total), coupons: n(o.coupons), taxes: n(o.taxes), shipping: n(o.shipping), discounted_orders: n(o.discounted_orders) });
  for (const r of refunds) get(r.d).refunds = n(r.refunds);
  for (const i of items) get(i.d).items = n(i.items);
  return map;
}

function finish(x) {
  const gross = x.net_total + x.coupons;
  const net = gross - x.refunds - x.coupons;
  return {
    orders_count: x.orders_count,
    num_items_sold: x.items,
    gross_sales: r2(gross),
    refunds: r2(x.refunds),
    coupons: r2(x.coupons),
    net_revenue: r2(net),
    taxes: r2(x.taxes),
    shipping: r2(x.shipping),
    total_sales: r2(net + x.taxes + x.shipping),
    avg_order_value: x.orders_count ? r2(x.net_total / x.orders_count) : 0,
    avg_items_per_order: x.orders_count ? Math.round((x.items / x.orders_count) * 100) / 100 : 0,
    discounted_orders: x.discounted_orders,
  };
}
const sum = (list) => list.reduce((a, b) => {
  for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k];
  return a;
}, { orders_count: 0, net_total: 0, coupons: 0, taxes: 0, shipping: 0, refunds: 0, items: 0, discounted_orders: 0 });

// Bucket start for an interval (dates are YYYY-MM-DD strings, local)
function bucket(dateStr, interval) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (interval === 'week') {
    const dow = (d.getUTCDay() + 6) % 7; // Monday start
    d.setUTCDate(d.getUTCDate() - dow);
  } else if (interval === 'month') d.setUTCDate(1);
  else if (interval === 'quarter') { d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3); d.setUTCDate(1); } else if (interval === 'year') { d.setUTCMonth(0); d.setUTCDate(1); }
  return d.toISOString().slice(0, 10);
}

// Revenue / orders stats: totals + intervals (every interval present, zero-filled)
router.get('/revenue', ah(async (req, res) => {
  const ctx = await context(req);
  const interval = ['day', 'week', 'month', 'quarter', 'year'].includes(req.query.interval) ? req.query.interval : 'day';
  const map = await daily(ctx);
  const buckets = new Map();
  for (let t = new Date(`${ctx.after}T00:00:00Z`); t <= new Date(`${ctx.before}T00:00:00Z`); t = new Date(t.getTime() + 86400000)) {
    const day = t.toISOString().slice(0, 10);
    const b = bucket(day, interval);
    if (!buckets.has(b)) buckets.set(b, { start: day, end: day, rows: [] });
    const entry = buckets.get(b);
    entry.end = day;
    if (map.has(day)) entry.rows.push(map.get(day));
  }
  const intervals = [...buckets.values()].map((b) => ({ date_start: b.start, date_end: b.end, subtotals: finish(sum(b.rows)) }));
  res.json({ currency: ctx.s.currency, interval, totals: finish(sum([...map.values()])), intervals });
}));

// Orders report: paginated list with customer type + products
router.get('/orders', ah(async (req, res) => {
  const ctx = await context(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 25));
  const order = req.query.order === 'asc' ? 'asc' : 'desc';
  const sortMap = { date: { createdAt: order }, order_number: { id: order }, net_total: { total: order }, status: { status: order } };
  const where = { createdAt: { gte: ctx.start, lt: ctx.end }, status: { notIn: ctx.statuses } };
  if (req.query.status && req.query.status !== 'all') where.status = String(req.query.status);
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, orderBy: sortMap[req.query.orderby] || { createdAt: 'desc' }, skip: (page - 1) * perPage, take: perPage, include: { items: { where: { type: { in: ['line_item', 'coupon'] } } } } }),
  ]);
  // New vs returning: is this the customer's first counted order?
  const custIds = [...new Set(rows.map((o) => o.customerId).filter(Boolean))];
  const emails = [...new Set(rows.filter((o) => !o.customerId).map((o) => (o.billing && o.billing.email) || '').filter(Boolean))];
  const firstById = new Map();
  if (custIds.length) {
    const firsts = await prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: custIds }, status: { notIn: ctx.statuses } }, _min: { id: true } });
    for (const f of firsts) firstById.set(f.customerId, f._min.id);
  }
  const firstByEmail = new Map();
  for (const e of emails) {
    const f = await prisma.order.findFirst({ where: { customerId: null, status: { notIn: ctx.statuses }, billing: { path: '$.email', equals: e } }, orderBy: { id: 'asc' }, select: { id: true } });
    if (f) firstByEmail.set(e, f.id);
  }
  res.set('X-WP-Total', String(total));
  res.set('X-WP-TotalPages', String(Math.ceil(total / perPage)));
  res.json(rows.map((o) => {
    const lines = o.items.filter((i) => i.type === 'line_item');
    const email = (o.billing && o.billing.email) || '';
    const first = o.customerId ? firstById.get(o.customerId) : firstByEmail.get(email);
    return {
      order_id: o.id,
      order_number: o.number || String(o.id),
      date_created: o.createdAt,
      status: o.status,
      customer_id: o.customerId || 0,
      customer_name: [o.billing && o.billing.first_name, o.billing && o.billing.last_name].filter(Boolean).join(' ') || email || 'Guest',
      customer_type: first === o.id ? 'new' : 'returning',
      products: lines.map((l) => ({ id: l.productId, name: l.name, quantity: l.quantity })),
      num_items_sold: lines.reduce((a, l) => a + l.quantity, 0),
      coupons: o.items.filter((i) => i.type === 'coupon').map((c) => c.code),
      net_total: r2(n(o.total) - n(o.totalTax) - n(o.shippingTotal)),
    };
  }));
}));

// Line-item rows (orderId, productId, variationId, quantity, total) in the range
async function lineItems(ctx) {
  return prisma.$queryRawUnsafe(`
    SELECT oi.orderId AS orderId, oi.productId AS productId, oi.variationId AS variationId, oi.quantity AS quantity, oi.total AS total, oi.name AS name
    FROM OrderItem oi JOIN \`Order\` o ON o.id = oi.orderId
    WHERE oi.type = 'line_item' AND o.createdAt >= ? AND o.createdAt < ? AND o.status NOT IN (${inList(ctx.statuses)})`, ctx.start, ctx.end, ...ctx.statuses);
}

// Products (or variations with ?type=variations)
router.get('/products', ah(async (req, res) => {
  const ctx = await context(req);
  const variations = req.query.type === 'variations';
  const rows = await lineItems(ctx);
  const agg = new Map();
  for (const r of rows) {
    const id = Number(variations ? r.variationId : r.productId);
    if (!id) continue;
    if (!agg.has(id)) agg.set(id, { id, items_sold: 0, net_revenue: 0, orders: new Set(), name: r.name });
    const a = agg.get(id);
    a.items_sold += Number(r.quantity);
    a.net_revenue += n(r.total);
    a.orders.add(Number(r.orderId));
  }
  const products = await prisma.product.findMany({
    where: { id: { in: [...agg.keys()] } },
    select: { id: true, name: true, sku: true, stockStatus: true, stockQuantity: true, manageStock: true, parentId: true, variationAttributes: true, categories: { select: { id: true, name: true } }, parent: { select: { name: true, categories: { select: { id: true, name: true } } } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const out = [...agg.values()].map((a) => {
    const p = byId.get(a.id);
    return {
      product_id: variations ? (p && p.parentId) || 0 : a.id,
      variation_id: variations ? a.id : 0,
      name: p ? (variations && p.parent ? `${p.parent.name} – ${(p.variationAttributes || []).map((x) => x.option || 'Any').join(', ')}` : p.name) : `${a.name} (deleted)`,
      sku: p ? p.sku || '' : '',
      items_sold: a.items_sold,
      net_revenue: r2(a.net_revenue),
      orders_count: a.orders.size,
      categories: p ? (p.parentId && p.parent ? p.parent.categories : p.categories).map((c) => c.name) : [],
      stock_status: p ? p.stockStatus : '',
      stock_quantity: p && p.manageStock ? p.stockQuantity : null,
    };
  });
  res.json({
    totals: {
      items_sold: out.reduce((x, o) => x + o.items_sold, 0),
      net_revenue: r2(out.reduce((x, o) => x + o.net_revenue, 0)),
      orders_count: new Set(rows.filter((r) => (variations ? r.variationId : r.productId)).map((r) => Number(r.orderId))).size,
      products_count: out.length,
    },
    rows: out,
  });
}));

router.get('/categories', ah(async (req, res) => {
  const ctx = await context(req);
  const rows = await lineItems(ctx);
  const pids = [...new Set(rows.map((r) => Number(r.productId)).filter(Boolean))];
  const products = await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, categories: { select: { id: true, name: true } } } });
  const catsOf = new Map(products.map((p) => [p.id, p.categories]));
  const agg = new Map();
  for (const r of rows) {
    for (const c of catsOf.get(Number(r.productId)) || []) {
      if (!agg.has(c.id)) agg.set(c.id, { category_id: c.id, name: c.name, items_sold: 0, net_revenue: 0, products: new Set(), orders: new Set() });
      const a = agg.get(c.id);
      a.items_sold += Number(r.quantity);
      a.net_revenue += n(r.total);
      a.products.add(Number(r.productId));
      a.orders.add(Number(r.orderId));
    }
  }
  const out = [...agg.values()].map((a) => ({ category_id: a.category_id, name: a.name, items_sold: a.items_sold, net_revenue: r2(a.net_revenue), products_count: a.products.size, orders_count: a.orders.size }));
  res.json({
    totals: { items_sold: out.reduce((x, o) => x + o.items_sold, 0), net_revenue: r2(out.reduce((x, o) => x + o.net_revenue, 0)), categories_count: out.length },
    rows: out,
  });
}));

router.get('/coupons', ah(async (req, res) => {
  const ctx = await context(req);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT oi.code AS code, COUNT(DISTINCT oi.orderId) AS orders_count, SUM(oi.discount) AS amount
    FROM OrderItem oi JOIN \`Order\` o ON o.id = oi.orderId
    WHERE oi.type = 'coupon' AND o.createdAt >= ? AND o.createdAt < ? AND o.status NOT IN (${inList(ctx.statuses)})
    GROUP BY oi.code`, ctx.start, ctx.end, ...ctx.statuses);
  const coupons = await prisma.coupon.findMany({ where: { code: { in: rows.map((r) => r.code) } } });
  const byCode = new Map(coupons.map((c) => [c.code, c]));
  const out = rows.map((r) => {
    const c = byCode.get(r.code);
    return { coupon_id: c ? c.id : 0, code: r.code, orders_count: Number(r.orders_count), amount: r2(r.amount), created: c ? c.createdAt : null, expires: c ? c.dateExpires : null, type: c ? c.discountType : '' };
  });
  res.json({ totals: { coupons_count: out.length, orders_count: out.reduce((x, o) => x + o.orders_count, 0), amount: r2(out.reduce((x, o) => x + o.amount, 0)) }, rows: out });
}));

router.get('/taxes', ah(async (req, res) => {
  const ctx = await context(req);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT oi.rateCode AS tax_code, oi.rateId AS tax_rate_id, MAX(oi.ratePercent) AS rate, SUM(oi.total) AS order_tax,
      SUM(oi.shippingTaxTotal) AS shipping_tax, COUNT(DISTINCT oi.orderId) AS orders_count
    FROM OrderItem oi JOIN \`Order\` o ON o.id = oi.orderId
    WHERE oi.type = 'tax' AND o.createdAt >= ? AND o.createdAt < ? AND o.status NOT IN (${inList(ctx.statuses)})
    GROUP BY oi.rateCode, oi.rateId`, ctx.start, ctx.end, ...ctx.statuses);
  const out = rows.map((r) => ({ tax_rate_id: Number(r.tax_rate_id) || 0, tax_code: r.tax_code, rate: n(r.rate), order_tax: r2(r.order_tax), shipping_tax: r2(r.shipping_tax), total_tax: r2(n(r.order_tax) + n(r.shipping_tax)), orders_count: Number(r.orders_count) }));
  res.json({ totals: { total_tax: r2(out.reduce((x, o) => x + o.total_tax, 0)), order_tax: r2(out.reduce((x, o) => x + o.order_tax, 0)), shipping_tax: r2(out.reduce((x, o) => x + o.shipping_tax, 0)), orders_count: out.reduce((x, o) => x + o.orders_count, 0) }, rows: out });
}));

// Stock (not date based). type: all | lowstock | instock | outofstock | onbackorder
async function lowStockThresholds() {
  const [low, none] = await Promise.all([options.getOption('woocommerce_notify_low_stock_amount'), options.getOption('woocommerce_notify_no_stock_amount')]);
  return { low: parseInt(low, 10) || 2, none: parseInt(none, 10) || 0 };
}
router.get('/stock', ah(async (req, res) => {
  const type = String(req.query.type || 'all');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 25));
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const sortCol = { name: 'p.name', sku: 'p.sku', stock_quantity: 'p.stockQuantity', stock_status: 'p.stockStatus' }[req.query.orderby] || 'p.stockQuantity';
  const t = await lowStockThresholds();
  const base = "p.status <> 'trash' AND (p.type <> 'variable' OR p.manageStock = 1)";
  const low = 'p.manageStock = 1 AND p.stockQuantity <= COALESCE(p.lowStockAmount, ?) AND p.stockQuantity > ?';
  let cond = base;
  const params = [];
  if (type === 'lowstock') { cond += ` AND ${low}`; params.push(t.low, t.none); } else if (['instock', 'outofstock', 'onbackorder'].includes(type)) { cond += ' AND p.stockStatus = ?'; params.push(type); }
  const [countRow] = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM Product p WHERE ${cond}`, ...params);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.parentId, p.name, p.sku, p.type, p.stockStatus, p.stockQuantity, p.manageStock FROM Product p WHERE ${cond} ORDER BY ${sortCol} ${order}, p.id ASC LIMIT ? OFFSET ?`,
    ...params, perPage, (page - 1) * perPage,
  );
  const [counts] = await prisma.$queryRawUnsafe(`SELECT
    SUM(CASE WHEN p.stockStatus = 'instock' THEN 1 ELSE 0 END) AS instock,
    SUM(CASE WHEN p.stockStatus = 'outofstock' THEN 1 ELSE 0 END) AS outofstock,
    SUM(CASE WHEN p.stockStatus = 'onbackorder' THEN 1 ELSE 0 END) AS onbackorder,
    SUM(CASE WHEN ${low} THEN 1 ELSE 0 END) AS lowstock,
    COUNT(*) AS products
    FROM Product p WHERE ${base}`, t.low, t.none);
  const total = Number(countRow.c);
  res.set('X-WP-Total', String(total));
  res.set('X-WP-TotalPages', String(Math.ceil(total / perPage)));
  res.json({
    totals: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v || 0)])),
    rows: rows.map((p) => ({
      id: Number(p.id), parent_id: Number(p.parentId) || 0, name: p.name, sku: p.sku || '', type: p.type, stock_status: p.stockStatus,
      stock_quantity: p.manageStock ? Number(p.stockQuantity) : null, manage_stock: !!p.manageStock,
    })),
  });
}));

// Leaderboards for the Overview page
router.get('/leaderboards', ah(async (req, res) => {
  const ctx = await context(req);
  const limit = Math.min(20, parseInt(req.query.per_page, 10) || 5);
  const rows = await lineItems(ctx);
  const prod = new Map();
  for (const r of rows) {
    const id = Number(r.productId);
    if (!id) continue;
    if (!prod.has(id)) prod.set(id, { product_id: id, name: r.name, items_sold: 0, net_revenue: 0 });
    const p = prod.get(id);
    p.items_sold += Number(r.quantity);
    p.net_revenue += n(r.total);
  }
  const products = await prisma.product.findMany({ where: { id: { in: [...prod.keys()] } }, select: { id: true, name: true, categories: { select: { id: true, name: true } } } });
  const cats = new Map();
  for (const p of products) {
    const s = prod.get(p.id);
    s.name = p.name;
    for (const c of p.categories) {
      if (!cats.has(c.id)) cats.set(c.id, { category_id: c.id, name: c.name, items_sold: 0, net_revenue: 0 });
      cats.get(c.id).items_sold += s.items_sold;
      cats.get(c.id).net_revenue += s.net_revenue;
    }
  }
  const top = (m) => [...m.values()].sort((a, b) => b.items_sold - a.items_sold).slice(0, limit).map((x) => ({ ...x, net_revenue: r2(x.net_revenue) }));
  const coupons = await prisma.$queryRawUnsafe(`
    SELECT oi.code AS code, COUNT(DISTINCT oi.orderId) AS orders_count, SUM(oi.discount) AS amount
    FROM OrderItem oi JOIN \`Order\` o ON o.id = oi.orderId
    WHERE oi.type = 'coupon' AND o.createdAt >= ? AND o.createdAt < ? AND o.status NOT IN (${inList(ctx.statuses)})
    GROUP BY oi.code ORDER BY orders_count DESC LIMIT ${limit}`, ctx.start, ctx.end, ...ctx.statuses);
  res.json({
    products: top(prod),
    categories: top(cats),
    coupons: coupons.map((c) => ({ code: c.code, orders_count: Number(c.orders_count), amount: r2(c.amount) })),
  });
}));

module.exports = { router, lowStockThresholds, DEFAULT_EXCLUDED };
