// /wp-json/wc/v3/coupons
const express = require('express');
const prisma = require('../../db');
const config = require('../../config');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { parseCollection, setPaginationHeaders } = require('../../lib/pagination');
const {
  money, wpDate, wpDateGmt, parseWpDate, metaOut, metaMerge, bool,
} = require('../../lib/format');
const { store } = require('../../lib/options');
const { runBatch } = require('../../lib/batch');
const { can } = require('../../middleware/auth');

const router = express.Router();
const API = `${config.siteUrl}/wp-json/wc/v3`;
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
const ids = (v) => (Array.isArray(v) ? v.map((x) => parseInt(x, 10)).filter(Boolean) : []);
const arr = (v) => (Array.isArray(v) ? v : []);
const USAGES = { usages: { orderBy: { id: 'desc' }, take: 100, select: { usedBy: true } } };

function serializeCoupon(c, s) {
  return {
    id: c.id,
    code: c.code,
    amount: money(c.amount, s.dp),
    status: c.status,
    date_created: wpDate(c.createdAt, s.gmtOffset),
    date_created_gmt: wpDateGmt(c.createdAt),
    date_modified: wpDate(c.updatedAt, s.gmtOffset),
    date_modified_gmt: wpDateGmt(c.updatedAt),
    discount_type: c.discountType,
    description: c.description,
    date_expires: wpDate(c.dateExpires, s.gmtOffset),
    date_expires_gmt: wpDateGmt(c.dateExpires),
    usage_count: c.usageCount,
    individual_use: c.individualUse,
    product_ids: arr(c.productIds),
    excluded_product_ids: arr(c.excludedProductIds),
    usage_limit: c.usageLimit,
    usage_limit_per_user: c.usageLimitPerUser,
    limit_usage_to_x_items: c.limitUsageToXItems,
    free_shipping: c.freeShipping,
    product_categories: arr(c.productCategories),
    excluded_product_categories: arr(c.excludedProductCategories),
    exclude_sale_items: c.excludeSaleItems,
    minimum_amount: money(c.minimumAmount, s.dp),
    maximum_amount: money(c.maximumAmount, s.dp),
    email_restrictions: arr(c.emailRestrictions),
    // Most recent users (capped — popular coupons can have hundreds of thousands of uses)
    used_by: c.usages ? c.usages.map((u) => u.usedBy) : [],
    meta_data: metaOut(c.meta),
    _links: { self: [{ href: `${API}/coupons/${c.id}` }], collection: [{ href: `${API}/coupons` }] },
  };
}

async function saveCoupon(body, existing, s) {
  const d = {};
  if (has(body, 'code')) {
    const code = String(body.code).trim().toLowerCase();
    if (!code) throw badRequest('woocommerce_rest_empty_coupon_code', 'The coupon code cannot be empty.');
    const dupe = await prisma.coupon.findFirst({ where: { code, NOT: existing ? { id: existing.id } : undefined } });
    if (dupe) throw badRequest('woocommerce_rest_coupon_code_already_exists', 'The coupon code already exists');
    d.code = code;
  }
  if (!existing && !d.code) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): code');
  const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const intOrNull = (v) => (v === '' || v === null || v === undefined || Number(v) === 0 ? null : parseInt(v, 10));
  const map = {
    amount: ['amount', (v) => Number(v) || 0],
    status: ['status', String],
    discount_type: ['discountType', (v) => {
      if (!['percent', 'fixed_cart', 'fixed_product'].includes(v)) throw badRequest('rest_invalid_param', 'Invalid parameter(s): discount_type');
      return v;
    }],
    description: ['description', String],
    individual_use: ['individualUse', bool],
    product_ids: ['productIds', ids],
    excluded_product_ids: ['excludedProductIds', ids],
    usage_limit: ['usageLimit', intOrNull],
    usage_limit_per_user: ['usageLimitPerUser', intOrNull],
    limit_usage_to_x_items: ['limitUsageToXItems', intOrNull],
    free_shipping: ['freeShipping', bool],
    product_categories: ['productCategories', ids],
    excluded_product_categories: ['excludedProductCategories', ids],
    exclude_sale_items: ['excludeSaleItems', bool],
    minimum_amount: ['minimumAmount', numOrNull],
    maximum_amount: ['maximumAmount', numOrNull],
    email_restrictions: ['emailRestrictions', (v) => arr(v).map((e) => String(e).trim().toLowerCase()).filter(Boolean)],
  };
  for (const [k, [f, fn]] of Object.entries(map)) if (has(body, k)) d[f] = fn(body[k]);
  if (has(body, 'date_expires_gmt')) d.dateExpires = parseWpDate(body.date_expires_gmt, true);
  else if (has(body, 'date_expires')) d.dateExpires = parseWpDate(body.date_expires, false, s.gmtOffset);
  if (has(body, 'meta_data')) d.meta = metaMerge(existing?.meta, body.meta_data);
  return existing ? prisma.coupon.update({ where: { id: existing.id }, data: d, include: USAGES }) : prisma.coupon.create({ data: d, include: USAGES });
}

async function findCoupon(id) {
  const c = await prisma.coupon.findUnique({ where: { id: intParam(id, 'woocommerce_rest_shop_coupon_invalid_id') }, include: USAGES });
  if (!c) throw new ApiError(404, 'woocommerce_rest_shop_coupon_invalid_id', 'Invalid ID.');
  return c;
}

router.get('/', can('edit_shop_coupons'), ah(async (req, res) => {
  const s = await store();
  const c = parseCollection(req.query);
  const where = {};
  if (req.query.code) where.code = String(req.query.code).toLowerCase();
  if (req.query.status && req.query.status !== 'any') where.status = String(req.query.status);
  else where.status = { not: 'trash' };
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  if (c.search) where.OR = [{ code: { contains: c.search.toLowerCase() } }, { description: { contains: c.search } }];
  const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'title' || c.orderby === 'slug' ? { code: c.order } : c.orderby === 'modified' ? { updatedAt: c.order } : { createdAt: c.order };
  const [total, rows] = await Promise.all([prisma.coupon.count({ where }), prisma.coupon.findMany({ where, orderBy, skip: c.skip, take: c.take, include: USAGES })]);
  setPaginationHeaders(req, res, total, c);
  res.json(rows.map((x) => serializeCoupon(x, s)));
}));
router.post('/', can('edit_shop_coupons'), ah(async (req, res) => {
  const s = await store();
  res.status(201).json(serializeCoupon(await saveCoupon(req.body || {}, null, s), s));
}));
router.post('/batch', can('edit_shop_coupons'), ah(async (req, res) => {
  const s = await store();
  res.json(await runBatch(req.body || {}, {
    create: async (item) => serializeCoupon(await saveCoupon(item, null, s), s),
    update: async (id, item) => serializeCoupon(await saveCoupon(item, await findCoupon(id), s), s),
    remove: async (id) => { const c = await findCoupon(id); await prisma.coupon.delete({ where: { id: c.id } }); return serializeCoupon(c, s); },
  }));
}));
router.get('/:id(\\d+)', can('edit_shop_coupons'), ah(async (req, res) => res.json(serializeCoupon(await findCoupon(req.params.id), await store()))));
const update = ah(async (req, res) => {
  const s = await store();
  res.json(serializeCoupon(await saveCoupon(req.body || {}, await findCoupon(req.params.id), s), s));
});
router.put('/:id(\\d+)', can('edit_shop_coupons'), update);
router.patch('/:id(\\d+)', can('edit_shop_coupons'), update);
router.delete('/:id(\\d+)', can('edit_shop_coupons'), ah(async (req, res) => {
  const s = await store();
  const c = await findCoupon(req.params.id);
  if (bool(req.query.force ?? req.body?.force)) {
    await prisma.coupon.delete({ where: { id: c.id } });
    return res.json(serializeCoupon(c, s));
  }
  res.json(serializeCoupon(await prisma.coupon.update({ where: { id: c.id }, data: { status: 'trash' }, include: USAGES }), s));
}));

module.exports = router;
