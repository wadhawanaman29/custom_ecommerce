// /products/categories, /products/tags, /products/shipping_classes,
// /products/attributes (+ /terms), /products/reviews
const express = require('express');
const crypto = require('crypto');
const prisma = require('../../db');
const config = require('../../config');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { parseCollection, setPaginationHeaders, idList } = require('../../lib/pagination');
const { bool, wpDate, wpDateGmt } = require('../../lib/format');
const { uniqueSlug } = require('../../lib/slug');
const { store } = require('../../lib/options');
const { cached } = require('../../lib/cache');
const { runBatch } = require('../../lib/batch');
const { can, publicRead } = require('../../middleware/auth');
const { imageOut } = require('../../serializers/product');

const API = `${config.siteUrl}/wp-json/wc/v3`;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const publishedOnly = { status: 'publish', type: { not: 'variation' } };

function termOrder(orderby, order) {
  switch (orderby) {
    case 'id': return [{ id: order }];
    case 'slug': return [{ slug: order }];
    case 'description': return [{ description: order }];
    case 'count': return [{ products: { _count: order } }];
    case 'menu_order': return [{ menuOrder: order }, { name: 'asc' }];
    case 'name':
    default: return [{ name: order }];
  }
}

// Generic CRUD router for product_cat / product_tag / product_shipping_class
function termRouter({ model, idCode, serialize, include, writable, hasParent, hasMenuOrder, extraWhere }) {
  const router = express.Router();
  const delegate = () => prisma[model];
  const find = async (id) => {
    const t = await delegate().findUnique({ where: { id: intParam(id, idCode) }, include: include() });
    if (!t) throw new ApiError(404, idCode, 'Resource does not exist.');
    return t;
  };

  router.get('/', publicRead('read'), cached(), ah(async (req, res) => {
    const s = await store();
    const q = req.query;
    const c = parseCollection(q, { defaultOrder: 'asc' });
    const where = {};
    if (c.include) where.id = { in: c.include };
    if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
    if (c.search) where.OR = [{ name: { contains: c.search } }, { slug: { contains: c.search } }];
    if (q.slug) where.slug = String(q.slug);
    if (hasParent && q.parent !== undefined) where.parentId = parseInt(q.parent, 10) || null;
    if (q.hide_empty && bool(q.hide_empty)) where.products = { some: publishedOnly };
    if (q.product) where.products = { some: { id: parseInt(q.product, 10) } };
    if (extraWhere) Object.assign(where, extraWhere(q));
    let orderBy = termOrder(c.orderby || (hasMenuOrder ? 'name' : 'name'), c.order);
    if (!hasMenuOrder && c.orderby === 'menu_order') orderBy = [{ name: c.order }];
    const [total, rows] = await Promise.all([
      delegate().count({ where }),
      delegate().findMany({ where, include: include(), orderBy, skip: c.skip, take: c.take }),
    ]);
    setPaginationHeaders(req, res, total, c);
    res.json(rows.map((t) => serialize(t, s)));
  }));

  async function save(body, existing) {
    const data = {};
    if (has(body, 'name')) data.name = String(body.name);
    if (!existing && !data.name) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): name');
    if (has(body, 'description')) data.description = String(body.description);
    if (!existing || has(body, 'slug')) {
      data.slug = await uniqueSlug(body.slug || data.name || existing.name, async (slug) => !!(await delegate().findFirst({ where: { slug, NOT: existing ? { id: existing.id } : undefined } })));
    }
    Object.assign(data, await writable(body, existing));
    const t = existing
      ? await delegate().update({ where: { id: existing.id }, data })
      : await delegate().create({ data });
    return find(t.id);
  }

  router.post('/', can('manage_woocommerce'), ah(async (req, res) => {
    const s = await store();
    res.status(201).json(serialize(await save(req.body || {}, null), s));
  }));

  router.post('/batch', can('manage_woocommerce'), ah(async (req, res) => {
    const s = await store();
    res.json(await runBatch(req.body || {}, {
      create: async (item) => serialize(await save(item, null), s),
      update: async (id, item) => serialize(await save(item, await find(id)), s),
      remove: async (id) => {
        const t = await find(id);
        await delegate().delete({ where: { id: t.id } });
        return serialize(t, s);
      },
    }));
  }));

  router.get('/:id(\\d+)', publicRead('read'), cached(), ah(async (req, res) => {
    res.json(serialize(await find(req.params.id), await store()));
  }));

  const update = ah(async (req, res) => {
    const existing = await find(req.params.id);
    res.json(serialize(await save(req.body || {}, existing), await store()));
  });
  router.put('/:id(\\d+)', can('manage_woocommerce'), update);
  router.patch('/:id(\\d+)', can('manage_woocommerce'), update);

  router.delete('/:id(\\d+)', can('manage_woocommerce'), ah(async (req, res) => {
    if (!bool(req.query.force ?? req.body?.force)) {
      throw new ApiError(501, 'woocommerce_rest_trash_not_supported', 'Resource does not support trashing.');
    }
    const t = await find(req.params.id);
    await delegate().delete({ where: { id: t.id } });
    res.json(serialize(t, await store()));
  }));

  return router;
}

const countInclude = () => ({ _count: { select: { products: { where: publishedOnly } } } });

// ── Categories ──
const categories = termRouter({
  model: 'productCategory',
  idCode: 'woocommerce_rest_term_invalid',
  hasParent: true,
  hasMenuOrder: true,
  include: () => ({ ...countInclude(), image: true }),
  serialize: (t, s) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    parent: t.parentId || 0,
    description: t.description,
    display: t.display,
    image: t.image ? imageOut(t.image, s) : null,
    menu_order: t.menuOrder,
    count: t._count ? t._count.products : 0,
    // ACF term fields (e.g. menu_title), like the "ACF to REST API" plugin
    acf: Array.isArray(t.meta) && t.meta.some((m) => m.key && m.key.startsWith('acf:'))
      ? Object.fromEntries(t.meta.filter((m) => m.key && m.key.startsWith('acf:')).map((m) => [m.key.slice(4), m.value])) : {},
    _links: { self: [{ href: `${API}/products/categories/${t.id}` }], collection: [{ href: `${API}/products/categories` }] },
  }),
  writable: async (body, existing) => {
    const d = {};
    if (has(body, 'parent')) d.parentId = parseInt(body.parent, 10) || null;
    if (has(body, 'acf') && body.acf && typeof body.acf === 'object') {
      const list = (Array.isArray(existing?.meta) ? existing.meta : []).filter((m) => !(m.key && m.key.startsWith('acf:') && has(body.acf, m.key.slice(4))));
      let id = list.reduce((n, m) => Math.max(n, m.id || 0), 0);
      for (const [key, value] of Object.entries(body.acf)) if (value !== null) list.push({ id: ++id, key: `acf:${key}`, value });
      d.meta = list;
    }
    if (has(body, 'display')) d.display = String(body.display);
    if (has(body, 'menu_order')) d.menuOrder = parseInt(body.menu_order, 10) || 0;
    if (has(body, 'image')) {
      if (!body.image) d.imageId = null;
      else if (body.image.id) d.imageId = parseInt(body.image.id, 10);
      else if (body.image.src) {
        const { resolveImages } = require('../../services/product');
        [d.imageId] = await resolveImages([body.image]);
      }
    }
    return d;
  },
});

// ── Brands (WooCommerce Brands, taxonomy product_brand) ──
const brands = termRouter({
  model: 'productBrand',
  idCode: 'woocommerce_rest_term_invalid',
  hasParent: true,
  hasMenuOrder: true,
  include: () => ({ ...countInclude(), image: true }),
  serialize: (t, s) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    parent: t.parentId || 0,
    description: t.description,
    display: 'default',
    image: t.image ? imageOut(t.image, s) : null,
    menu_order: t.menuOrder,
    count: t._count ? t._count.products : 0,
    acf: Array.isArray(t.meta) ? Object.fromEntries(t.meta.filter((m) => m.key && m.key.startsWith('acf:')).map((m) => [m.key.slice(4), m.value])) : {},
    _links: { self: [{ href: `${API}/products/brands/${t.id}` }], collection: [{ href: `${API}/products/brands` }] },
  }),
  writable: async (body, existing) => {
    const d = {};
    if (has(body, 'parent')) d.parentId = parseInt(body.parent, 10) || null;
    if (has(body, 'menu_order')) d.menuOrder = parseInt(body.menu_order, 10) || 0;
    if (has(body, 'image')) d.imageId = body.image && body.image.id ? parseInt(body.image.id, 10) : null;
    if (has(body, 'acf') && body.acf && typeof body.acf === 'object') d.meta = require('../../lib/product-extras').acfMerge(existing?.meta, body.acf);
    return d;
  },
});

// ── Tags ──
const simpleSerialize = (base) => (t) => ({
  id: t.id, name: t.name, slug: t.slug, description: t.description, count: t._count ? t._count.products : 0,
  _links: { self: [{ href: `${API}/products/${base}/${t.id}` }], collection: [{ href: `${API}/products/${base}` }] },
});
const tags = termRouter({
  model: 'productTag', idCode: 'woocommerce_rest_term_invalid', include: countInclude, serialize: simpleSerialize('tags'), writable: async () => ({}),
});
const shippingClasses = termRouter({
  model: 'shippingClass', idCode: 'woocommerce_rest_term_invalid', include: countInclude, serialize: simpleSerialize('shipping_classes'), writable: async () => ({}),
});

// ── Global attributes + terms ──
const attributes = express.Router();
const attrOut = (a) => ({
  id: a.id, name: a.name, slug: `pa_${a.slug}`, type: a.type, order_by: a.orderBy, has_archives: a.hasArchives,
  _links: { self: [{ href: `${API}/products/attributes/${a.id}` }], collection: [{ href: `${API}/products/attributes` }] },
});
const findAttr = async (id) => {
  const a = await prisma.attribute.findUnique({ where: { id: intParam(id, 'woocommerce_rest_attribute_invalid') } });
  if (!a) throw new ApiError(404, 'woocommerce_rest_attribute_invalid', 'Resource does not exist.');
  return a;
};
async function saveAttr(body, existing) {
  const d = {};
  if (has(body, 'name')) d.name = String(body.name);
  if (!existing && !d.name) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): name');
  if (has(body, 'slug') || !existing) {
    const raw = String(body.slug || d.name).replace(/^pa_/, '');
    d.slug = await uniqueSlug(raw, async (slug) => !!(await prisma.attribute.findFirst({ where: { slug, NOT: existing ? { id: existing.id } : undefined } })));
    if (d.slug.length > 28) throw badRequest('woocommerce_rest_invalid_product_attribute_slug_too_long', 'Slug is too long.');
  }
  if (has(body, 'type')) d.type = String(body.type);
  if (has(body, 'order_by')) d.orderBy = String(body.order_by);
  if (has(body, 'has_archives')) d.hasArchives = bool(body.has_archives);
  return existing ? prisma.attribute.update({ where: { id: existing.id }, data: d }) : prisma.attribute.create({ data: d });
}

attributes.get('/', publicRead('read'), cached(), ah(async (req, res) => {
  res.json((await prisma.attribute.findMany({ orderBy: { name: 'asc' } })).map(attrOut));
}));
attributes.post('/', can('manage_woocommerce'), ah(async (req, res) => res.status(201).json(attrOut(await saveAttr(req.body || {}, null)))));
attributes.post('/batch', can('manage_woocommerce'), ah(async (req, res) => {
  res.json(await runBatch(req.body || {}, {
    create: async (item) => attrOut(await saveAttr(item, null)),
    update: async (id, item) => attrOut(await saveAttr(item, await findAttr(id))),
    remove: async (id) => { const a = await findAttr(id); await prisma.attribute.delete({ where: { id: a.id } }); return attrOut(a); },
  }));
}));
attributes.get('/:id(\\d+)', publicRead('read'), cached(), ah(async (req, res) => res.json(attrOut(await findAttr(req.params.id)))));
const updAttr = ah(async (req, res) => res.json(attrOut(await saveAttr(req.body || {}, await findAttr(req.params.id)))));
attributes.put('/:id(\\d+)', can('manage_woocommerce'), updAttr);
attributes.patch('/:id(\\d+)', can('manage_woocommerce'), updAttr);
attributes.delete('/:id(\\d+)', can('manage_woocommerce'), ah(async (req, res) => {
  const a = await findAttr(req.params.id);
  await prisma.attribute.delete({ where: { id: a.id } });
  res.json(attrOut(a));
}));

// Terms of an attribute
async function termCount(attr, term) {
  return prisma.product.count({ where: { ...publishedOnly, attributes: { some: { attributeId: attr.id, options: { array_contains: [term.name] } } } } });
}
const termOut = async (attr, t, withCount = true) => ({
  id: t.id, name: t.name, slug: t.slug, description: t.description, menu_order: t.menuOrder,
  count: withCount ? await termCount(attr, t) : 0,
  _links: { self: [{ href: `${API}/products/attributes/${attr.id}/terms/${t.id}` }], collection: [{ href: `${API}/products/attributes/${attr.id}/terms` }] },
});
const findTerm = async (attr, id) => {
  const t = await prisma.attributeTerm.findUnique({ where: { id: intParam(id, 'woocommerce_rest_term_invalid') } });
  if (!t || t.attributeId !== attr.id) throw new ApiError(404, 'woocommerce_rest_term_invalid', 'Resource does not exist.');
  return t;
};
async function saveTerm(attr, body, existing) {
  const d = {};
  if (has(body, 'name')) d.name = String(body.name);
  if (!existing && !d.name) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): name');
  if (has(body, 'description')) d.description = String(body.description);
  if (has(body, 'menu_order')) d.menuOrder = parseInt(body.menu_order, 10) || 0;
  if (!existing || has(body, 'slug')) {
    d.slug = await uniqueSlug(body.slug || d.name, async (slug) => !!(await prisma.attributeTerm.findFirst({ where: { attributeId: attr.id, slug, NOT: existing ? { id: existing.id } : undefined } })));
  }
  // Renaming a term must rename it inside product attribute options too
  if (existing && d.name && d.name !== existing.name) {
    const rows = await prisma.productAttribute.findMany({ where: { attributeId: attr.id, options: { array_contains: [existing.name] } } });
    for (const r of rows) {
      await prisma.productAttribute.update({ where: { id: r.id }, data: { options: r.options.map((o) => (o === existing.name ? d.name : o)) } });
    }
  }
  return existing
    ? prisma.attributeTerm.update({ where: { id: existing.id }, data: d })
    : prisma.attributeTerm.create({ data: { ...d, attributeId: attr.id } });
}

attributes.get('/:aid(\\d+)/terms', publicRead('read'), cached(), ah(async (req, res) => {
  const attr = await findAttr(req.params.aid);
  const c = parseCollection(req.query, { defaultOrder: 'asc' });
  const where = { attributeId: attr.id };
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  if (c.search) where.name = { contains: c.search };
  if (req.query.slug) where.slug = String(req.query.slug);
  const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'slug' ? { slug: c.order } : (c.orderby === 'name' || attr.orderBy === 'name') ? { name: c.order } : [{ menuOrder: c.order }, { name: 'asc' }];
  const [total, rows] = await Promise.all([
    prisma.attributeTerm.count({ where }),
    prisma.attributeTerm.findMany({ where, orderBy, skip: c.skip, take: c.take }),
  ]);
  let out = await Promise.all(rows.map((t) => termOut(attr, t)));
  if (bool(req.query.hide_empty)) out = out.filter((t) => t.count > 0);
  setPaginationHeaders(req, res, total, c);
  res.json(out);
}));
attributes.post('/:aid(\\d+)/terms', can('manage_woocommerce'), ah(async (req, res) => {
  const attr = await findAttr(req.params.aid);
  res.status(201).json(await termOut(attr, await saveTerm(attr, req.body || {}, null)));
}));
attributes.post('/:aid(\\d+)/terms/batch', can('manage_woocommerce'), ah(async (req, res) => {
  const attr = await findAttr(req.params.aid);
  res.json(await runBatch(req.body || {}, {
    create: async (item) => termOut(attr, await saveTerm(attr, item, null)),
    update: async (id, item) => termOut(attr, await saveTerm(attr, item, await findTerm(attr, id))),
    remove: async (id) => { const t = await findTerm(attr, id); await prisma.attributeTerm.delete({ where: { id: t.id } }); return termOut(attr, t, false); },
  }));
}));
attributes.get('/:aid(\\d+)/terms/:id(\\d+)', publicRead('read'), cached(), ah(async (req, res) => {
  const attr = await findAttr(req.params.aid);
  res.json(await termOut(attr, await findTerm(attr, req.params.id)));
}));
const updTerm = ah(async (req, res) => {
  const attr = await findAttr(req.params.aid);
  res.json(await termOut(attr, await saveTerm(attr, req.body || {}, await findTerm(attr, req.params.id))));
});
attributes.put('/:aid(\\d+)/terms/:id(\\d+)', can('manage_woocommerce'), updTerm);
attributes.patch('/:aid(\\d+)/terms/:id(\\d+)', can('manage_woocommerce'), updTerm);
attributes.delete('/:aid(\\d+)/terms/:id(\\d+)', can('manage_woocommerce'), ah(async (req, res) => {
  if (!bool(req.query.force ?? req.body?.force)) throw new ApiError(501, 'woocommerce_rest_trash_not_supported', 'Resource does not support trashing.');
  const attr = await findAttr(req.params.aid);
  const t = await findTerm(attr, req.params.id);
  await prisma.attributeTerm.delete({ where: { id: t.id } });
  res.json(await termOut(attr, t, false));
}));

// ── Reviews ──
const reviews = express.Router();
const gravatar = (email) => {
  const h = crypto.createHash('md5').update(String(email || '').trim().toLowerCase()).digest('hex');
  return { 24: `https://secure.gravatar.com/avatar/${h}?s=24&d=mm&r=g`, 48: `https://secure.gravatar.com/avatar/${h}?s=48&d=mm&r=g`, 96: `https://secure.gravatar.com/avatar/${h}?s=96&d=mm&r=g` };
};
const reviewOut = (r, s) => ({
  id: r.id,
  date_created: wpDate(r.createdAt, s.gmtOffset),
  date_created_gmt: wpDateGmt(r.createdAt),
  product_id: r.productId,
  product_name: r.product ? r.product.name : '',
  product_permalink: r.product ? `${config.frontendUrl}/product/${r.product.slug}/` : '',
  status: r.status,
  reviewer: r.reviewer,
  reviewer_email: r.reviewerEmail,
  review: r.review,
  rating: r.rating,
  verified: r.verified,
  reviewer_avatar_urls: gravatar(r.reviewerEmail),
  _links: { self: [{ href: `${API}/products/reviews/${r.id}` }], collection: [{ href: `${API}/products/reviews` }], up: [{ href: `${API}/products/${r.productId}` }] },
});
const reviewInclude = { product: { select: { name: true, slug: true } } };

// Keep product average_rating / rating_count in sync (approved reviews only)
async function syncRating(productId) {
  const agg = await prisma.productReview.aggregate({ where: { productId, status: 'approved', rating: { gt: 0 } }, _avg: { rating: true }, _count: { rating: true } });
  await prisma.product.update({ where: { id: productId }, data: { averageRating: agg._avg.rating || 0, ratingCount: agg._count.rating } });
}

async function findReview(id) {
  const r = await prisma.productReview.findUnique({ where: { id: intParam(id, 'woocommerce_rest_review_invalid_id') }, include: reviewInclude });
  if (!r) throw new ApiError(404, 'woocommerce_rest_review_invalid_id', 'Invalid review ID.');
  return r;
}

async function saveReview(body, existing, req) {
  const d = {};
  if (has(body, 'product_id')) {
    const p = await prisma.product.findUnique({ where: { id: parseInt(body.product_id, 10) || 0 } });
    if (!p || p.type === 'variation') throw new ApiError(404, 'woocommerce_rest_product_invalid_id', 'Invalid product ID.');
    d.productId = p.id;
  }
  if (!existing && !d.productId) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): product_id');
  if (has(body, 'review')) d.review = String(body.review);
  if (has(body, 'reviewer')) d.reviewer = String(body.reviewer);
  if (has(body, 'reviewer_email')) d.reviewerEmail = String(body.reviewer_email);
  if (has(body, 'rating')) d.rating = Math.max(0, Math.min(5, parseInt(body.rating, 10) || 0));
  if (has(body, 'verified')) d.verified = bool(body.verified);
  if (has(body, 'status')) d.status = String(body.status);
  if (!existing) {
    if (!d.review) throw badRequest('woocommerce_rest_review_content_invalid', 'Invalid review content.');
    if (!d.reviewer || !d.reviewerEmail) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): reviewer, reviewer_email');
    if (req && req.user && !d.verified) {
      // Mark as verified owner if the customer bought the product
      const bought = await prisma.orderItem.findFirst({ where: { productId: d.productId, order: { customerId: req.user.id, status: { in: ['processing', 'completed'] } } } });
      d.verified = !!bought;
    }
  }
  const r = existing
    ? await prisma.productReview.update({ where: { id: existing.id }, data: d })
    : await prisma.productReview.create({ data: d });
  await syncRating(r.productId);
  if (existing && d.productId && existing.productId !== d.productId) await syncRating(existing.productId);
  return findReview(r.id);
}

reviews.get('/', publicRead('read'), cached(), ah(async (req, res) => {
  const s = await store();
  const q = req.query;
  const c = parseCollection(q);
  const staff = req.can('manage_woocommerce');
  const where = {};
  if (!staff) where.status = 'approved';
  else if (q.status && q.status !== 'all') where.status = String(q.status);
  else where.status = { notIn: ['trash', 'spam'] };
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  if (q.product) where.productId = { in: idList(q.product) };
  if (q.reviewer_email) where.reviewerEmail = String(q.reviewer_email);
  if (c.search) where.OR = [{ review: { contains: c.search } }, { reviewer: { contains: c.search } }];
  const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'product' ? { productId: c.order } : { createdAt: c.order };
  const [total, rows] = await Promise.all([
    prisma.productReview.count({ where }),
    prisma.productReview.findMany({ where, include: reviewInclude, orderBy, skip: c.skip, take: c.take }),
  ]);
  setPaginationHeaders(req, res, total, c);
  res.json(rows.map((r) => reviewOut(r, s)));
}));
// Customers (JWT) may post reviews; they land in moderation unless staff
reviews.post('/', (req, res, next) => (req.user ? next() : can('moderate_comments')(req, res, next)), ah(async (req, res) => {
  const body = { ...(req.body || {}) };
  if (!req.can('moderate_comments')) {
    body.status = 'hold';
    body.reviewer = body.reviewer || req.user.displayName;
    body.reviewer_email = req.user.email;
    delete body.verified;
  }
  res.status(201).json(reviewOut(await saveReview(body, null, req), await store()));
}));
reviews.post('/batch', can('moderate_comments'), ah(async (req, res) => {
  const s = await store();
  res.json(await runBatch(req.body || {}, {
    create: async (item) => reviewOut(await saveReview(item, null, req), s),
    update: async (id, item) => reviewOut(await saveReview(item, await findReview(id), req), s),
    remove: async (id) => { const r = await findReview(id); await prisma.productReview.delete({ where: { id: r.id } }); await syncRating(r.productId); return reviewOut(r, s); },
  }));
}));
reviews.get('/:id(\\d+)', publicRead('read'), cached(), ah(async (req, res) => {
  const r = await findReview(req.params.id);
  if (!req.can('manage_woocommerce') && r.status !== 'approved') throw new ApiError(404, 'woocommerce_rest_review_invalid_id', 'Invalid review ID.');
  res.json(reviewOut(r, await store()));
}));
const updReview = ah(async (req, res) => res.json(reviewOut(await saveReview(req.body || {}, await findReview(req.params.id), req), await store())));
reviews.put('/:id(\\d+)', can('moderate_comments'), updReview);
reviews.patch('/:id(\\d+)', can('moderate_comments'), updReview);
reviews.delete('/:id(\\d+)', can('moderate_comments'), ah(async (req, res) => {
  const s = await store();
  const r = await findReview(req.params.id);
  if (bool(req.query.force ?? req.body?.force)) {
    await prisma.productReview.delete({ where: { id: r.id } });
    await syncRating(r.productId);
    return res.json({ deleted: true, previous: reviewOut(r, s) });
  }
  const t = await prisma.productReview.update({ where: { id: r.id }, data: { status: 'trash' }, include: reviewInclude });
  await syncRating(r.productId);
  res.json(reviewOut(t, s));
}));

module.exports = { categories, brands, tags, shippingClasses, attributes, reviews };
