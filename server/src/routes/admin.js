// /wp-json/custom/v1/admin — endpoints used only by the dashboard (wp-admin replacement)
const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { ah, ApiError, badRequest, intParam } = require('../lib/http');
const { store } = require('../lib/options');
const { money, wpDate } = require('../lib/format');
const { can } = require('../middleware/auth');
const { hashConsumerKey } = require('../middleware/auth');
const { STATUS_LABELS } = require('../services/order');

const router = express.Router();
const admin = can('*');

// ───────── Dashboard stats ─────────
router.get('/stats', can('view_woocommerce_reports'), ah(async (req, res) => {
  const s = await store();
  const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30));
  const since = new Date(Date.now() - days * 86400000);
  const paid = { in: ['processing', 'completed', 'on-hold'] };
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);

  const [byStatus, revenue, today, products, lowStock, outOfStock, customers, recent, daily, top, pendingReviews] = await Promise.all([
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.order.aggregate({ where: { status: paid, createdAt: { gte: since } }, _sum: { total: true }, _count: { _all: true } }),
    prisma.order.aggregate({ where: { status: paid, createdAt: { gte: startOfToday } }, _sum: { total: true }, _count: { _all: true } }),
    prisma.product.count({ where: { type: { not: 'variation' }, status: { not: 'trash' } } }),
    prisma.product.findMany({ where: { manageStock: true, stockQuantity: { gt: 0, lte: 5 }, status: 'publish' }, select: { id: true, name: true, stockQuantity: true, parentId: true }, take: 10, orderBy: { stockQuantity: 'asc' } }),
    prisma.product.count({ where: { stockStatus: 'outofstock', status: 'publish', type: { not: 'variation' } } }),
    prisma.user.count({ where: { role: 'customer' } }),
    prisma.order.findMany({ where: { status: { not: 'trash' } }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, number: true, status: true, total: true, currency: true, billing: true, createdAt: true } }),
    prisma.$queryRaw`SELECT DATE(createdAt) AS d, COUNT(*) AS orders, SUM(total) AS sales FROM \`Order\` WHERE status IN ('processing','completed','on-hold') AND createdAt >= ${since} GROUP BY DATE(createdAt) ORDER BY d`,
    prisma.orderItem.groupBy({ by: ['productId', 'name'], where: { type: 'line_item', productId: { not: null }, order: { status: paid, createdAt: { gte: since } } }, _sum: { quantity: true, total: true }, orderBy: { _sum: { quantity: 'desc' } }, take: 5 }),
    prisma.productReview.count({ where: { status: 'hold' } }),
  ]);

  // Fill missing days with zeros for the chart
  const map = new Map(daily.map((r) => [new Date(r.d).toISOString().slice(0, 10), r]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const r = map.get(d);
    series.push({ date: d, orders: r ? Number(r.orders) : 0, sales: r ? Number(r.sales) : 0 });
  }
  res.json({
    currency: s.currency,
    period_days: days,
    sales: money(revenue._sum.total, s.dp),
    orders: revenue._count._all,
    average_order: money(revenue._count._all ? Number(revenue._sum.total || 0) / revenue._count._all : 0, s.dp),
    today_sales: money(today._sum.total, s.dp),
    today_orders: today._count._all,
    products,
    customers,
    out_of_stock: outOfStock,
    pending_reviews: pendingReviews,
    low_stock: lowStock.map((p) => ({ id: p.parentId || p.id, variation_id: p.parentId ? p.id : 0, name: p.name, stock: p.stockQuantity })),
    status_counts: Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, (byStatus.find((b) => b.status === k) || { _count: { _all: 0 } })._count._all])),
    recent_orders: recent.map((o) => ({ id: o.id, number: o.number || String(o.id), status: o.status, total: money(o.total, s.dp), name: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(' ') || o.billing?.email || 'Guest', date: wpDate(o.createdAt, s.gmtOffset) })),
    top_products: top.map((t) => ({ product_id: t.productId, name: t.name, quantity: t._sum.quantity, total: money(t._sum.total, s.dp) })),
    series,
  });
}));

// ───────── Import jobs ─────────
const jobs = [];
let running = null;

function startJob(type, label, fn) {
  if (running) throw new ApiError(409, 'import_running', 'Another import is already running. Wait for it to finish.');
  const job = { id: crypto.randomBytes(6).toString('hex'), type, label, status: 'running', logs: [], startedAt: new Date(), finishedAt: null, error: null };
  jobs.unshift(job);
  if (jobs.length > 20) jobs.pop();
  running = job;
  const log = (line) => {
    job.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    if (job.logs.length > 3000) job.logs.splice(0, job.logs.length - 3000);
  };
  Promise.resolve()
    .then(() => fn(log))
    .then(() => { job.status = 'done'; })
    .catch((e) => { job.status = 'failed'; job.error = e.message; log(`ERROR: ${e.message}`); })
    .finally(() => { job.finishedAt = new Date(); running = null; });
  return job;
}
const jobOut = (j, withLogs = true, since = 0) => ({
  id: j.id, type: j.type, label: j.label, status: j.status, error: j.error, started_at: j.startedAt, finished_at: j.finishedAt,
  log_count: j.logs.length, ...(withLogs ? { logs: j.logs.slice(since) } : {}),
});

const dbOpts = (b) => ({
  host: String(b.host || 'localhost'), port: String(b.port || '3306'), user: String(b.user || 'root'), password: String(b.password || ''),
  database: String(b.database || ''), prefix: String(b.prefix || 'wp_'),
});
const restOpts = (b) => ({
  siteUrl: String(b.site_url || ''), consumerKey: String(b.consumer_key || ''), consumerSecret: String(b.consumer_secret || ''),
  wpUser: String(b.wp_user || ''), wpAppPassword: String(b.wp_app_password || ''),
});

router.post('/import/test-db', admin, ah(async (req, res) => {
  const o = dbOpts(req.body || {});
  if (!o.database) throw badRequest('missing_database', 'Database name is required.');
  try {
    res.json(await require('../services/import/wp-db').testConnection(o));
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
}));
router.post('/import/test-rest', admin, ah(async (req, res) => {
  try {
    res.json(await require('../services/import/wp-rest').testConnection(restOpts(req.body || {})));
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
}));
router.post('/import/db', admin, ah(async (req, res) => {
  const b = req.body || {};
  const o = dbOpts(b);
  if (!o.database) throw badRequest('missing_database', 'Database name is required.');
  const job = startJob('db', `Database ${o.database}@${o.host}`, (log) => require('../services/import/wp-db').run({
    ...o, only: Array.isArray(b.only) ? b.only : [], remoteMedia: !!b.remote_media, uploadsUrl: b.uploads_url, reset: b.reset === true,
  }, log));
  res.status(202).json(jobOut(job));
}));
router.post('/import/rest', admin, ah(async (req, res) => {
  const b = req.body || {};
  const o = restOpts(b);
  if (!o.siteUrl) throw badRequest('missing_site_url', 'Site URL is required.');
  const job = startJob('rest', `REST ${o.siteUrl}`, (log) => require('../services/import/wp-rest').run({
    ...o, only: Array.isArray(b.only) ? b.only : [], downloadMedia: !!b.download_media, orderNotes: !!b.order_notes,
  }, log));
  res.status(202).json(jobOut(job));
}));
router.get('/import/jobs', admin, (req, res) => res.json(jobs.map((j) => jobOut(j, false))));
router.get('/import/jobs/:id', admin, (req, res, next) => {
  const j = jobs.find((x) => x.id === req.params.id);
  if (!j) return next(new ApiError(404, 'not_found', 'Job not found.'));
  res.json(jobOut(j, true, parseInt(req.query.since, 10) || 0));
});

// ───────── REST API keys (WooCommerce → Settings → Advanced → REST API) ─────────
const keyOut = (k) => ({
  id: k.id, description: k.description, permissions: k.permissions, truncated_key: k.truncatedKey, last_access: k.lastAccess,
  user: k.user ? { id: k.user.id, name: k.user.displayName || k.user.login, email: k.user.email } : null,
});
router.get('/api-keys', admin, ah(async (req, res) => {
  res.json((await prisma.apiKey.findMany({ include: { user: true }, orderBy: { id: 'desc' } })).map(keyOut));
}));
router.post('/api-keys', admin, ah(async (req, res) => {
  const b = req.body || {};
  if (!['read', 'write', 'read_write'].includes(b.permissions)) throw badRequest('invalid_permissions', 'Permissions must be read, write or read_write.');
  const userId = parseInt(b.user_id, 10) || req.user.id;
  if (!(await prisma.user.findUnique({ where: { id: userId } }))) throw badRequest('invalid_user', 'User not found.');
  const ck = `ck_${crypto.randomBytes(20).toString('hex')}`;
  const cs = `cs_${crypto.randomBytes(20).toString('hex')}`;
  const k = await prisma.apiKey.create({
    data: { userId, description: String(b.description || 'API key'), permissions: b.permissions, consumerKey: hashConsumerKey(ck), consumerSecret: cs, truncatedKey: ck.slice(-7) },
    include: { user: true },
  });
  // The plain consumer key is only ever shown here, once.
  res.status(201).json({ ...keyOut(k), consumer_key: ck, consumer_secret: cs });
}));
router.delete('/api-keys/:id', admin, ah(async (req, res) => {
  const id = intParam(req.params.id);
  await prisma.apiKey.delete({ where: { id } });
  res.json({ deleted: true, id });
}));

module.exports = router;
