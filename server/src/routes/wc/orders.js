// /wp-json/wc/v3/orders (+ /notes, /refunds, /batch)
const express = require('express');
const prisma = require('../../db');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { parseCollection, setPaginationHeaders, idList, strList } = require('../../lib/pagination');
const { parseWpDate, bool } = require('../../lib/format');
const { store } = require('../../lib/options');
const { runBatch } = require('../../lib/batch');
const { can, requireUser } = require('../../middleware/auth');
const {
  orderInclude, serializeOrders, serializeNote, serializeRefund,
} = require('../../serializers/order');
const svc = require('../../services/order');
const { searchWhere } = require('../../lib/search');
const { countOf } = require('../../lib/cache');

const router = express.Router();
const isStaff = (req) => req.can('edit_shop_orders');

// Staff: everything. Logged-in customers (JWT): only their own orders, read-only.
const readAccess = (req, res, next) => (isStaff(req) || !req.user ? can('edit_shop_orders')(req, res, next) : requireUser(req, res, next));

async function findOrder(id, req) {
  const o = await prisma.order.findUnique({ where: { id: intParam(id, 'woocommerce_rest_shop_order_invalid_id') }, include: orderInclude });
  if (!o) throw new ApiError(404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.');
  if (req && !isStaff(req) && o.customerId !== req.user.id) throw new ApiError(404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.');
  return o;
}
const one = async (id, s) => (await serializeOrders([await findOrder(id)], s))[0];

router.get('/', readAccess, ah(async (req, res) => {
  const s = await store();
  const q = req.query;
  const c = parseCollection(q);
  const where = {};
  if (q.status && q.status !== 'any') where.status = { in: strList(q.status) };
  else where.status = { notIn: ['trash', 'checkout-draft'] };
  if (!isStaff(req)) where.customerId = req.user.id;
  else if (q.customer !== undefined) where.customerId = parseInt(q.customer, 10) || null;
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  if (q.parent) where.parentId = { in: idList(q.parent) };
  if (q.product) where.items = { some: { type: 'line_item', OR: [{ productId: parseInt(q.product, 10) }, { variationId: parseInt(q.product, 10) }] } };
  const AND = [];
  const gmt = bool(q.dates_are_gmt);
  if (q.after) AND.push({ createdAt: { gt: parseWpDate(q.after, gmt, s.gmtOffset) } });
  if (q.before) AND.push({ createdAt: { lt: parseWpDate(q.before, gmt, s.gmtOffset) } });
  if (q.modified_after) AND.push({ updatedAt: { gt: parseWpDate(q.modified_after, gmt, s.gmtOffset) } });
  if (q.modified_before) AND.push({ updatedAt: { lt: parseWpDate(q.modified_before, gmt, s.gmtOffset) } });
  if (c.search) {
    // Indexed search: order number/ID, billing email/phone prefix, FULLTEXT on name/email/phone
    const t = c.search.trim();
    const asId = /^#?\d+$/.test(t) ? parseInt(t.replace('#', ''), 10) : null;
    const sw = await searchWhere('Order', ['billingName', 'billingEmail', 'billingPhone'], t, ['billingEmail', 'billingPhone', 'number']);
    AND.push({ OR: [...(asId ? [{ id: asId }] : []), ...(sw ? sw.OR || [sw] : [])] });
  }
  if (AND.length) where.AND = AND;
  const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'modified' ? { updatedAt: c.order } : [{ createdAt: c.order }, { id: c.order }];
  const [total, rows] = await Promise.all([
    countOf('order', where),
    prisma.order.findMany({ where, include: orderInclude, orderBy, skip: c.skip, take: c.take }),
  ]);
  if (c.orderby === 'include' && c.include) rows.sort((a, b) => c.include.indexOf(a.id) - c.include.indexOf(b.id));
  setPaginationHeaders(req, res, total, c);
  res.json(await serializeOrders(rows, s));
}));

router.post('/', can('edit_shop_orders'), ah(async (req, res) => {
  const s = await store();
  const id = await svc.saveOrder(req.body || {}, s, null, req);
  res.status(201).json(await one(id, s));
}));

router.post('/batch', can('edit_shop_orders'), ah(async (req, res) => {
  const s = await store();
  res.json(await runBatch(req.body || {}, {
    create: async (item) => one(await svc.saveOrder(item, s, null, req), s),
    update: async (id, item) => one(await svc.saveOrder(item, s, await findOrder(id), req), s),
    remove: async (id) => {
      const out = await one(intParam(id), s);
      await prisma.order.delete({ where: { id: out.id } });
      return out;
    },
  }));
}));

router.get('/:id(\\d+)', readAccess, ah(async (req, res) => {
  const s = await store();
  const o = await findOrder(req.params.id, req);
  res.json((await serializeOrders([o], s))[0]);
}));

const update = ah(async (req, res) => {
  const s = await store();
  const existing = await findOrder(req.params.id);
  await svc.saveOrder(req.body || {}, s, existing, req);
  res.json(await one(existing.id, s));
});
router.put('/:id(\\d+)', can('edit_shop_orders'), update);
router.patch('/:id(\\d+)', can('edit_shop_orders'), update);

router.delete('/:id(\\d+)', can('edit_shop_orders'), ah(async (req, res) => {
  const s = await store();
  const existing = await findOrder(req.params.id);
  const out = (await serializeOrders([existing], s))[0];
  if (bool(req.query.force ?? req.body?.force)) {
    await prisma.order.delete({ where: { id: existing.id } });
    return res.json(out);
  }
  if (existing.status === 'trash') throw new ApiError(410, 'woocommerce_rest_already_trashed', `The order with ID ${existing.id} has already been deleted.`);
  await prisma.order.update({ where: { id: existing.id }, data: { status: 'trash' } });
  await require('../../services/order-stats').syncOrderSafe(existing.id);
  res.json({ ...out, status: 'trash' });
}));

// ── Notes ──
router.get('/:oid(\\d+)/notes', readAccess, ah(async (req, res) => {
  const s = await store();
  const o = await findOrder(req.params.oid, req);
  const where = { orderId: o.id };
  const type = req.query.type || 'any';
  if (!isStaff(req) || type === 'customer') where.customerNote = true;
  else if (type === 'internal') where.customerNote = false;
  const notes = await prisma.orderNote.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  res.json(notes.map((n) => serializeNote(n, s, o.id)));
}));
router.post('/:oid(\\d+)/notes', can('edit_shop_orders'), ah(async (req, res) => {
  const s = await store();
  const o = await findOrder(req.params.oid);
  if (!req.body || !req.body.note) throw badRequest('woocommerce_rest_invalid_order_note', 'Cannot create order note, please try again.');
  const author = bool(req.body.added_by_user) && req.user ? req.user.displayName || req.user.login : 'system';
  const n = await svc.addNote(o.id, String(req.body.note), { customerNote: bool(req.body.customer_note), author });
  if (bool(req.body.customer_note)) await require('../../services/email/triggers').customerNote(o.id, String(req.body.note));
  res.status(201).json(serializeNote(n, s, o.id));
}));
router.get('/:oid(\\d+)/notes/:id(\\d+)', readAccess, ah(async (req, res) => {
  const s = await store();
  const o = await findOrder(req.params.oid, req);
  const n = await prisma.orderNote.findFirst({ where: { id: intParam(req.params.id), orderId: o.id, ...(isStaff(req) ? {} : { customerNote: true }) } });
  if (!n) throw new ApiError(404, 'woocommerce_rest_invalid_id', 'Invalid resource ID.');
  res.json(serializeNote(n, s, o.id));
}));
router.delete('/:oid(\\d+)/notes/:id(\\d+)', can('edit_shop_orders'), ah(async (req, res) => {
  if (!bool(req.query.force ?? req.body?.force)) throw new ApiError(501, 'woocommerce_rest_trash_not_supported', 'Webhooks do not support trashing.');
  const s = await store();
  const o = await findOrder(req.params.oid);
  const n = await prisma.orderNote.findFirst({ where: { id: intParam(req.params.id), orderId: o.id } });
  if (!n) throw new ApiError(404, 'woocommerce_rest_invalid_id', 'Invalid resource ID.');
  await prisma.orderNote.delete({ where: { id: n.id } });
  res.json(serializeNote(n, s, o.id));
}));

// ── Refunds ──
router.get('/:oid(\\d+)/refunds', can('edit_shop_orders'), ah(async (req, res) => {
  const s = await store();
  const o = await findOrder(req.params.oid);
  res.json(o.refunds.map((r) => serializeRefund(r, s, o.id)));
}));
router.post('/:oid(\\d+)/refunds', can('edit_shop_orders'), ah(async (req, res) => {
  const s = await store();
  const o = await findOrder(req.params.oid);
  const r = await svc.refundOrder(o, req.body || {}, s, req);
  res.status(201).json(serializeRefund(r, s, o.id));
}));
router.get('/:oid(\\d+)/refunds/:id(\\d+)', can('edit_shop_orders'), ah(async (req, res) => {
  const s = await store();
  const o = await findOrder(req.params.oid);
  const r = o.refunds.find((x) => x.id === intParam(req.params.id));
  if (!r) throw new ApiError(404, 'woocommerce_rest_invalid_id', 'Invalid resource ID.');
  res.json(serializeRefund(r, s, o.id));
}));
router.delete('/:oid(\\d+)/refunds/:id(\\d+)', can('edit_shop_orders'), ah(async (req, res) => {
  const s = await store();
  const o = await findOrder(req.params.oid);
  const r = o.refunds.find((x) => x.id === intParam(req.params.id));
  if (!r) throw new ApiError(404, 'woocommerce_rest_invalid_id', 'Invalid resource ID.');
  await prisma.orderRefund.delete({ where: { id: r.id } });
  res.json(serializeRefund(r, s, o.id));
}));

module.exports = router;
