// /wp-json/custom/v1/admin/plugins/* — replacements for WordPress plugins (dashboard → Plugins)
const express = require('express');
const prisma = require('../db');
const { ah, ApiError, badRequest, intParam } = require('../lib/http');
const { can } = require('../middleware/auth');
const jobs = require('../lib/jobs');
const options = require('../lib/options');

const router = express.Router();
const manage = can('manage_woocommerce');

// Status of every plugin from the WordPress site (Plugins → Overview)
const PLUGINS = [
  // built
  ['Advanced Custom Fields PRO', 'built', 'Tools → Content Types (field groups)'],
  ['Custom Post Type UI', 'built', 'Tools → Content Types (post types & taxonomies)'],
  ['eBrands - ACF Extensions', 'built', 'Tools → Content Types'],
  ['Classic Editor', 'built', 'Visual / Text editor on all edit screens'],
  ['Simple Page Ordering', 'built', '"Order" field + "Sort by Order" on lists'],
  ['Redis Object Cache', 'built', 'Built-in response/count caching + indexed database'],
  ['Custom Order List', 'built', 'WooCommerce → Orders (search, filters, pagination)'],
  ['HUSKY - Products Filter Professional', 'built', 'API filters: category, attribute, price, stock, on sale'],
  ['WooCommerce Basic Ordernumbers', 'built', 'Plugins → Order Numbers'],
  ['Storewide Sale', 'built', 'Plugins → Storewide Sale'],
  ['Easy Auto SKU Generator for WooCommerce', 'built', 'Plugins → Auto SKU'],
  ['SMTP for AmazonSES - YaySMTP', 'built', 'Plugins → Email (SMTP) + Email Log'],
  ['Advanced Order Export For WooCommerce', 'built', 'Plugins → Order Export (CSV)'],
  ['WooCommerce (emails)', 'built', 'WooCommerce → Settings → Emails'],
  // next batches
  ['GR8 Rewards System', 'planned', 'Batch 2 — needs plugin code'],
  ['Gr8Health Cart Rewards', 'planned', 'Batch 2 — needs plugin code'],
  ['Custom Stock Notify Me plugin', 'planned', 'Batch 2 — needs plugin code'],
  ['Practitioner Consent Logger', 'planned', 'Batch 2 — needs plugin code'],
  ['gr8Health CRM — Order Push', 'planned', 'Batch 2 — needs plugin code'],
  ['TI WooCommerce Wishlist', 'planned', 'Batch 2'],
  ['WooCommerce Product Add-ons', 'planned', 'Batch 2'],
  ['WooCommerce Product Bundles', 'planned', 'Batch 2'],
  ['Yoast SEO', 'planned', 'Batch 3'],
  ['Klaviyo', 'planned', 'Batch 3'],
  ['WooCommerce → Klaviyo Review Event Pusher', 'planned', 'Batch 3 — needs plugin code'],
  ['Gravity Forms + Gravity Forms Klaviyo Add-On', 'planned', 'Batch 3'],
  ['Customer Reviews for WooCommerce', 'planned', 'Batch 3'],
  ['REVIEWS.io for WooCommerce', 'planned', 'Batch 3'],
  ['Product Feed PRO for WooCommerce', 'planned', 'Batch 3'],
  ['Meta for WooCommerce', 'planned', 'Batch 3'],
  ['Plugin for Google Reviews', 'planned', 'Batch 3'],
  ['Smash Balloon Instagram Feed', 'planned', 'Batch 3'],
  ['Algolia Custom Integration', 'planned', 'Batch 3 — needs plugin code'],
  ['Product Recommendation Quiz for eCommerce', 'external', 'RevenueHunt SaaS — only needs product data access'],
  ['FrontEnd APIs', 'planned', 'API phase (frontend-api/v1)'],
  // not needed
  ['Jetpack', 'not_needed', 'WordPress.com features'],
  ['Smush', 'not_needed', 'Optimise images at upload / CDN'],
  ['UpdraftPlus - Backup/Restore', 'not_needed', 'Database + server backups (docs/database.md)'],
  ['Wordfence Security', 'not_needed', 'Server firewall / WAF'],
  ['WP User Avatars', 'not_needed', 'Gravatar is used'],
  ['WooCommerce Shipping & Tax', 'not_needed', 'Only needed for WooCommerce label printing'],
  ['Query Monitor', 'not_needed', 'Slow query log (docs/database.md)'],
  ['Advanced Database Cleaner / Database Manager', 'not_needed', 'No WordPress tables to clean'],
  ['Blogger Importer, FG Magento modules', 'not_needed', 'One-off migration tools'],
  ['WooCommerce Admin / Blocks', 'not_needed', 'Replaced by this dashboard'],
  ['Braintree, PayPal Payments, WooPayments, ShipStation, HubSpot, Woo Discount Rules, Order Export & Import (inactive)', 'not_needed', 'Inactive on the WordPress site'],
];
router.get('/overview', manage, (req, res) => res.json(PLUGINS.map(([name, status, where]) => ({ name, status, where }))));

// ── Jobs ──
router.get('/jobs/:id', manage, (req, res, next) => {
  const j = jobs.get(req.params.id);
  if (!j) return next(new ApiError(404, 'not_found', 'Job not found.'));
  res.json(jobs.out(j, parseInt(req.query.since, 10) || 0));
});
const startJob = (kind, label, fn) => {
  try { return jobs.out(jobs.start(kind, label, fn)); } catch (e) { throw new ApiError(e.status || 500, e.code || 'job_error', e.message); }
};

// ── Order numbers ──
router.get('/ordernumbers', manage, ah(async (req, res) => res.json(await require('../services/ordernumbers').status())));
router.post('/ordernumbers/counter', can('*'), ah(async (req, res) => {
  if (req.body === undefined || req.body.value === undefined) throw badRequest('missing_value', 'Provide "value".');
  res.json(await require('../services/ordernumbers').setCounter(req.body.value));
}));

// ── Storewide sale ──
const sws = () => require('../services/storewide-sale');
router.get('/storewide-sale', manage, ah(async (req, res) => {
  const latest = jobs.latest('storewide_sale');
  res.json({ ...(await sws().status()), job: latest ? jobs.out(latest) : null });
}));
router.post('/storewide-sale/apply', manage, ah(async (req, res) => res.status(202).json(startJob('storewide_sale', 'Apply storewide sale', (ctx) => sws().apply(ctx)))));
router.post('/storewide-sale/remove', manage, ah(async (req, res) => res.status(202).json(startJob('storewide_sale', 'End storewide sale', (ctx) => sws().remove(ctx)))));

// ── Auto SKU ──
router.get('/auto-sku', manage, ah(async (req, res) => {
  const missing = await prisma.product.count({ where: { sku: null, status: { not: 'trash' } } });
  const latest = jobs.latest('auto_sku');
  res.json({ missing, job: latest ? jobs.out(latest) : null });
}));
router.post('/auto-sku/generate', manage, ah(async (req, res) => res.status(202).json(startJob('auto_sku', 'Generate missing SKUs', (ctx) => require('../services/auto-sku').generateMissing(ctx)))));

// ── Email: SMTP test, WooCommerce email settings, previews, log ──
const tpl = () => require('../services/email/templates');
const mailer = () => require('../services/email/mailer');
router.post('/smtp/test', manage, ah(async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw badRequest('invalid_email', 'Enter a valid email address.');
  res.json(await mailer().sendTest(to));
}));
router.get('/emails', manage, ah(async (req, res) => res.json(await Promise.all(Object.keys(tpl().EMAILS).map((id) => tpl().emailSettings(id))))));
const emailId = (id) => { if (!tpl().EMAILS[id]) throw new ApiError(404, 'not_found', 'Unknown email.'); return id; };
router.get('/emails/:id', manage, ah(async (req, res) => res.json(await tpl().emailSettings(emailId(req.params.id)))));
router.put('/emails/:id', manage, ah(async (req, res) => res.json(await tpl().saveEmailSettings(emailId(req.params.id), req.body || {}))));
// HTML preview, rendered with a real order (latest one if none given)
router.get('/emails/:id/preview', manage, ah(async (req, res) => {
  const id = emailId(req.params.id);
  const order = req.query.order_id ? { id: intParam(req.query.order_id) } : await prisma.order.findFirst({ where: { status: { not: 'trash' } }, orderBy: { id: 'desc' }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { role: 'customer' }, orderBy: { id: 'desc' } });
  const needsOrder = !['customer_new_account', 'customer_reset_password'].includes(id);
  if (needsOrder && !order) throw badRequest('no_orders', 'There are no orders to preview with yet.');
  const msg = await tpl().render({ template: id, to: 'preview@example.com', orderId: needsOrder ? order.id : null, userId: needsOrder ? null : (user || {}).id, data: { note: 'This is an example note.', partial: false, reset_url: '#' } });
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!-- Subject: ${msg.subject.replace(/--/g, '')} -->${msg.html}`);
}));
// Order screen → "Order actions": resend an email for an order
router.post('/emails/send', can('edit_shop_orders'), ah(async (req, res) => {
  const b = req.body || {};
  const id = emailId(String(b.email || ''));
  const order = await prisma.order.findUnique({ where: { id: intParam(b.order_id) }, select: { id: true, billingEmail: true, billing: true } });
  if (!order) throw new ApiError(404, 'not_found', 'Order not found.');
  const isCustomer = !tpl().EMAILS[id].admin;
  const to = isCustomer ? (order.billingEmail || (order.billing && order.billing.email)) : '';
  if (isCustomer && !to) throw badRequest('no_email', 'This order has no billing email.');
  const cfg = await tpl().emailSettings(id);
  const row = await prisma.emailLog.create({ data: { template: id, to: to || cfg.recipient, orderId: order.id } }); // manual sends ignore "enabled"
  setImmediate(() => mailer().processQueue());
  await require('../services/order').addNote(order.id, `${tpl().EMAILS[id].title} email ${isCustomer ? `sent to ${to}` : 'resent'} manually.`, { author: req.user.displayName || req.user.login });
  res.status(202).json({ queued: true, id: row.id });
}));
router.get('/email-log', manage, ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = {};
  if (req.query.status) where.status = String(req.query.status);
  if (req.query.search) where.to = { startsWith: String(req.query.search) };
  if (req.query.order_id) where.orderId = parseInt(req.query.order_id, 10) || 0;
  const [total, rows] = await Promise.all([prisma.emailLog.count({ where }), prisma.emailLog.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * 50, take: 50 })]);
  res.set('X-WP-Total', String(total));
  res.set('X-WP-TotalPages', String(Math.ceil(total / 50)));
  res.json(rows);
}));
router.post('/email-log/:id/resend', manage, ah(async (req, res) => {
  const row = await prisma.emailLog.findUnique({ where: { id: intParam(req.params.id) } });
  if (!row) throw new ApiError(404, 'not_found', 'Not found.');
  const copy = await prisma.emailLog.create({ data: { template: row.template, to: row.to, orderId: row.orderId, userId: row.userId, data: row.data || undefined } });
  setImmediate(() => mailer().processQueue());
  res.status(202).json({ queued: true, id: copy.id });
}));

// ── Order export (Advanced Order Export): streams CSV in ID batches — works for any number of orders ──
const ORDER_COLUMNS = {
  order_number: ['Order number', (o) => o.number || o.id],
  order_id: ['Order ID', (o) => o.id],
  date: ['Order date', (o) => o.createdAt.toISOString().replace('T', ' ').slice(0, 19)],
  status: ['Status', (o) => o.status],
  customer_id: ['Customer ID', (o) => o.customerId || ''],
  billing_name: ['Billing name', (o) => o.billingName],
  billing_email: ['Billing email', (o) => o.billingEmail],
  billing_phone: ['Billing phone', (o) => o.billingPhone],
  billing_company: ['Billing company', (o) => (o.billing || {}).company || ''],
  billing_address: ['Billing address', (o) => [(o.billing || {}).address_1, (o.billing || {}).address_2].filter(Boolean).join(', ')],
  billing_city: ['Billing city', (o) => (o.billing || {}).city || ''],
  billing_state: ['Billing state', (o) => (o.billing || {}).state || ''],
  billing_postcode: ['Billing postcode', (o) => (o.billing || {}).postcode || ''],
  billing_country: ['Billing country', (o) => (o.billing || {}).country || ''],
  shipping_name: ['Shipping name', (o) => [(o.shipping || {}).first_name, (o.shipping || {}).last_name].filter(Boolean).join(' ')],
  shipping_address: ['Shipping address', (o) => [(o.shipping || {}).address_1, (o.shipping || {}).address_2].filter(Boolean).join(', ')],
  shipping_city: ['Shipping city', (o) => (o.shipping || {}).city || ''],
  shipping_state: ['Shipping state', (o) => (o.shipping || {}).state || ''],
  shipping_postcode: ['Shipping postcode', (o) => (o.shipping || {}).postcode || ''],
  shipping_country: ['Shipping country', (o) => (o.shipping || {}).country || ''],
  shipping_method: ['Shipping method', (o) => o.items.filter((i) => i.type === 'shipping').map((i) => i.name).join('; ')],
  payment_method: ['Payment method', (o) => o.paymentMethodTitle || o.paymentMethod],
  transaction_id: ['Transaction ID', (o) => o.transactionId],
  products: ['Products', (o) => o.items.filter((i) => i.type === 'line_item').map((i) => `${i.quantity} x ${i.name}${i.sku ? ` (${i.sku})` : ''}`).join('; ')],
  items_count: ['Items', (o) => o.items.filter((i) => i.type === 'line_item').reduce((n, i) => n + i.quantity, 0)],
  coupons: ['Coupons', (o) => o.items.filter((i) => i.type === 'coupon').map((i) => i.code).join(' ')],
  subtotal: ['Subtotal', (o) => o.items.filter((i) => i.type === 'line_item').reduce((n, i) => n + Number(i.subtotal), 0).toFixed(2)],
  discount_total: ['Discount', (o) => Number(o.discountTotal).toFixed(2)],
  shipping_total: ['Shipping', (o) => Number(o.shippingTotal).toFixed(2)],
  fee_total: ['Fees', (o) => o.items.filter((i) => i.type === 'fee').reduce((n, i) => n + Number(i.total), 0).toFixed(2)],
  total_tax: ['Tax', (o) => Number(o.totalTax).toFixed(2)],
  total: ['Order total', (o) => Number(o.total).toFixed(2)],
  refunded: ['Refunded', (o) => o.refunds.reduce((n, r) => n + Number(r.amount), 0).toFixed(2)],
  currency: ['Currency', (o) => o.currency],
  customer_note: ['Customer note', (o) => o.customerNote],
};
const ITEM_COLUMNS = {
  order_number: ['Order number', (o) => o.number || o.id], date: ['Order date', (o) => o.createdAt.toISOString().replace('T', ' ').slice(0, 19)],
  status: ['Status', (o) => o.status], billing_name: ['Billing name', (o) => o.billingName], billing_email: ['Billing email', (o) => o.billingEmail],
  product_id: ['Product ID', (o, i) => i.productId || ''], variation_id: ['Variation ID', (o, i) => i.variationId || ''], sku: ['SKU', (o, i) => i.sku],
  name: ['Item', (o, i) => i.name], quantity: ['Quantity', (o, i) => i.quantity], item_price: ['Item price', (o, i) => Number(i.price).toFixed(2)],
  line_subtotal: ['Line subtotal', (o, i) => Number(i.subtotal).toFixed(2)], line_total: ['Line total', (o, i) => Number(i.total).toFixed(2)],
  line_tax: ['Line tax', (o, i) => Number(i.totalTax).toFixed(2)], coupons: ['Coupons', (o) => o.items.filter((x) => x.type === 'coupon').map((x) => x.code).join(' ')],
};
router.get('/export/columns', manage, (req, res) => res.json({
  orders: Object.entries(ORDER_COLUMNS).map(([key, [label]]) => ({ key, label })),
  items: Object.entries(ITEM_COLUMNS).map(([key, [label]]) => ({ key, label })),
}));
router.get('/export/orders', manage, ah(async (req, res) => {
  const q = req.query;
  const mode = q.mode === 'items' ? 'items' : 'orders';
  const defs = mode === 'items' ? ITEM_COLUMNS : ORDER_COLUMNS;
  const cols = (q.columns ? String(q.columns).split(',') : Object.keys(defs)).filter((c) => defs[c]);
  if (!cols.length) throw badRequest('no_columns', 'Choose at least one column.');
  const gmt = parseFloat(await options.getOption('gmt_offset')) || 0;
  const where = { status: { notIn: ['trash', 'checkout-draft'] } };
  if (q.status) where.status = { in: String(q.status).split(',') };
  const range = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.after || '')) range.gte = new Date(new Date(`${q.after}T00:00:00Z`).getTime() - gmt * 3600000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.before || '')) range.lt = new Date(new Date(`${q.before}T00:00:00Z`).getTime() + 86400000 - gmt * 3600000);
  if (Object.keys(range).length) where.createdAt = range;
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${mode}-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(`﻿${cols.map((c) => esc(defs[c][0])).join(',')}\n`);
  let lastId = 0;
  for (;;) {
    const orders = await prisma.order.findMany({ where: { ...where, id: { gt: lastId } }, orderBy: { id: 'asc' }, take: 500, include: { items: true, refunds: { select: { amount: true } } } });
    if (!orders.length) break;
    lastId = orders[orders.length - 1].id;
    let chunk = '';
    for (const o of orders) {
      if (mode === 'items') {
        for (const i of o.items.filter((x) => x.type === 'line_item')) chunk += `${cols.map((c) => esc(defs[c][1](o, i))).join(',')}\n`;
      } else chunk += `${cols.map((c) => esc(defs[c][1](o))).join(',')}\n`;
    }
    if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)); // respect back-pressure
  }
  res.end();
}));

module.exports = router;
