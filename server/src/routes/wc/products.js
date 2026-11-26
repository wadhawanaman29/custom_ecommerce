// /wp-json/wc/v3/products (+ /variations, /batch)
const express = require('express');
const prisma = require('../../db');
const { ah, intParam, ApiError } = require('../../lib/http');
const { parseCollection, setPaginationHeaders, idList, strList } = require('../../lib/pagination');
const { parseWpDate, bool } = require('../../lib/format');
const { store } = require('../../lib/options');
const { cached } = require('../../lib/cache');
const { runBatch } = require('../../lib/batch');
const { can, publicRead } = require('../../middleware/auth');
const {
  productInclude, variationInclude, serializeProducts, serializeVariation,
} = require('../../serializers/product');
const svc = require('../../services/product');
const { searchWhere } = require('../../lib/search');
const { countOf } = require('../../lib/cache');

const router = express.Router();

const isStaff = (req) => req.can('manage_woocommerce') || req.can('edit_products');

async function categoryWithDescendants(ids) {
  const all = await prisma.productCategory.findMany({ select: { id: true, parentId: true } });
  const out = new Set(ids);
  let added = true;
  while (added) {
    added = false;
    for (const c of all) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); added = true; }
    }
  }
  return [...out];
}

async function onSaleProductIds() {
  const rows = await prisma.$queryRaw`
    SELECT id, parentId FROM Product
    WHERE salePrice IS NOT NULL AND (regularPrice IS NULL OR salePrice < regularPrice)
      AND (dateOnSaleFrom IS NULL OR dateOnSaleFrom <= NOW())
      AND (dateOnSaleTo IS NULL OR dateOnSaleTo >= NOW())
      AND status = 'publish'`;
  return [...new Set(rows.map((r) => Number(r.parentId || r.id)))];
}

// Shared filters (also used by variations)
function commonFilters(q, where, s) {
  if (q.sku) where.sku = { in: strList(q.sku) };
  if (q.stock_status) where.stockStatus = String(q.stock_status);
  if (q.tax_class) where.taxClass = q.tax_class === 'standard' ? '' : String(q.tax_class);
  if (q.min_price !== undefined && q.min_price !== '') where.price = { ...(where.price || {}), gte: Number(q.min_price) };
  if (q.max_price !== undefined && q.max_price !== '') where.price = { ...(where.price || {}), lte: Number(q.max_price) };
  const AND = where.AND || [];
  if (q.after) AND.push({ createdAt: { gt: parseWpDate(q.after, bool(q.dates_are_gmt), s.gmtOffset) } });
  if (q.before) AND.push({ createdAt: { lt: parseWpDate(q.before, bool(q.dates_are_gmt), s.gmtOffset) } });
  if (q.modified_after) AND.push({ updatedAt: { gt: parseWpDate(q.modified_after, bool(q.dates_are_gmt), s.gmtOffset) } });
  if (q.modified_before) AND.push({ updatedAt: { lt: parseWpDate(q.modified_before, bool(q.dates_are_gmt), s.gmtOffset) } });
  if (AND.length) where.AND = AND;
}

function orderByFor(orderby, order) {
  switch (orderby) {
    case 'id': return [{ id: order }];
    case 'title': return [{ name: order }, { id: order }];
    case 'slug': return [{ slug: order }];
    case 'modified': return [{ updatedAt: order }];
    case 'price': return [{ price: order }, { id: order }];
    case 'popularity': return [{ totalSales: order }, { id: order }];
    case 'rating': return [{ averageRating: order }, { id: order }];
    case 'menu_order': return [{ menuOrder: order }, { name: 'asc' }];
    case 'date':
    default: return [{ createdAt: order }, { id: order }];
  }
}

async function buildProductWhere(req, s) {
  const q = req.query;
  const where = { type: { not: 'variation' } };
  const staff = isStaff(req);

  if (!staff) where.status = 'publish';
  else if (q.status && q.status !== 'any') where.status = { in: strList(q.status) };
  else where.status = { not: 'trash' };

  if (q.type) where.type = String(q.type);
  if (q.featured !== undefined) where.featured = bool(q.featured);
  if (q.slug) where.slug = String(q.slug);
  if (q.parent) where.parentId = { in: idList(q.parent) };
  if (q.parent_exclude) where.NOT = [...(where.NOT || []), { parentId: { in: idList(q.parent_exclude) } }];
  if (q.category) where.categories = { some: { id: { in: await categoryWithDescendants(idList(q.category) || []) } } };
  if (q.tag) where.tags = { some: { id: { in: idList(q.tag) || [] } } };
  if (q.shipping_class) where.shippingClassId = { in: idList(q.shipping_class) };
  if (!staff && s.hideOutOfStock && !q.stock_status) where.stockStatus = { not: 'outofstock' };
  if (q.search) {
    const term = String(q.search);
    // FULLTEXT on name/SKU + SKU prefix (index) — no LIKE '%term%' table scans
    const sw = await searchWhere('Product', ['name', 'sku'], term, ['sku']);
    if (sw) where.AND = [...(where.AND || []), sw];
  }
  if (q.attribute) {
    const slug = String(q.attribute).replace(/^pa_/, '');
    const attr = await prisma.attribute.findUnique({ where: { slug } });
    if (!attr) return null;
    const attrWhere = { attributeId: attr.id };
    if (q.attribute_term) {
      const terms = await prisma.attributeTerm.findMany({ where: { id: { in: idList(q.attribute_term) || [] } } });
      if (!terms.length) return null;
      // MySQL JSON array_contains matches products having ANY of the term names
      return { ...where, AND: [...(where.AND || []), { OR: terms.map((t) => ({ attributes: { some: { ...attrWhere, options: { array_contains: [t.name] } } } })) }] };
    }
    where.attributes = { some: attrWhere };
  }
  if (q.on_sale !== undefined) {
    const saleIds = await onSaleProductIds();
    where.AND = [...(where.AND || []), bool(q.on_sale) ? { id: { in: saleIds } } : { id: { notIn: saleIds } }];
  }
  commonFilters(q, where, s);
  return where;
}

// ── Products ──

router.get('/', publicRead('read'), cached(), ah(async (req, res) => {
  const s = await store();
  const c = parseCollection(req.query);
  const where = await buildProductWhere(req, s);
  if (!where) {
    setPaginationHeaders(req, res, 0, c);
    return res.json([]);
  }
  if (c.include) where.id = { ...(where.id || {}), in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };

  const [total, rows] = await Promise.all([
    countOf('product', where),
    prisma.product.findMany({ where, include: productInclude, orderBy: orderByFor(c.orderby, c.order), skip: c.skip, take: c.take }),
  ]);
  if (c.orderby === 'include' && c.include) rows.sort((a, b) => c.include.indexOf(a.id) - c.include.indexOf(b.id));
  setPaginationHeaders(req, res, total, c);
  res.json(await serializeProducts(rows, s));
}));

router.post('/', can('edit_products'), ah(async (req, res) => {
  const s = await store();
  const p = await svc.createOrUpdateProduct(req.body || {}, s);
  res.status(201).json(await loadProduct(p.id, s));
}));

router.post('/batch', can('edit_products'), ah(async (req, res) => {
  const s = await store();
  res.json(await runBatch(req.body || {}, {
    create: async (item) => loadProduct((await svc.createOrUpdateProduct(item, s)).id, s),
    update: async (id, item) => {
      const existing = await findProduct(id);
      await svc.createOrUpdateProduct(item, s, existing);
      return loadProduct(existing.id, s);
    },
    remove: async (id) => {
      const existing = await findProduct(id);
      const out = await loadProduct(existing.id, s);
      await svc.deleteProduct(existing, true);
      return out;
    },
  }));
}));

async function findProduct(id, req) {
  const p = await prisma.product.findUnique({ where: { id: intParam(id, 'woocommerce_rest_product_invalid_id') } });
  if (!p || p.type === 'variation') throw new ApiError(404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.');
  if (req && !isStaff(req) && p.status !== 'publish') throw new ApiError(404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.');
  return p;
}

async function loadProduct(id, s) {
  const p = await prisma.product.findUnique({ where: { id }, include: productInclude });
  return (await serializeProducts([p], s))[0];
}

router.get('/:id(\\d+)', publicRead('read'), cached(), ah(async (req, res) => {
  const s = await store();
  const p = await findProduct(req.params.id, req);
  res.json(await loadProduct(p.id, s));
}));

const updateProduct = ah(async (req, res) => {
  const s = await store();
  const existing = await findProduct(req.params.id);
  await svc.createOrUpdateProduct(req.body || {}, s, existing);
  res.json(await loadProduct(existing.id, s));
});
router.put('/:id(\\d+)', can('edit_products'), updateProduct);
router.patch('/:id(\\d+)', can('edit_products'), updateProduct);

router.delete('/:id(\\d+)', can('edit_products'), ah(async (req, res) => {
  const s = await store();
  const existing = await findProduct(req.params.id);
  const out = await loadProduct(existing.id, s);
  const force = bool(req.query.force ?? req.body?.force);
  await svc.deleteProduct(existing, force);
  res.json(force ? out : { ...out, status: 'trash' });
}));

// ── Variations ──

async function findParent(id, req) {
  const parent = await findProduct(id, req);
  return parent;
}

async function findVariation(parentId, id) {
  const v = await prisma.product.findUnique({ where: { id: intParam(id, 'woocommerce_rest_product_variation_invalid_id') }, include: variationInclude });
  if (!v || v.type !== 'variation' || v.parentId !== parentId) {
    throw new ApiError(404, 'woocommerce_rest_product_variation_invalid_id', 'Invalid ID.');
  }
  return v;
}

router.get('/:pid(\\d+)/variations', publicRead('read'), cached(), ah(async (req, res) => {
  const s = await store();
  const parent = await findParent(req.params.pid, req);
  const c = parseCollection(req.query, { defaultOrder: 'asc' });
  const where = { parentId: parent.id, type: 'variation' };
  if (!isStaff(req)) where.status = 'publish';
  else if (req.query.status && req.query.status !== 'any') where.status = { in: strList(req.query.status) };
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  commonFilters(req.query, where, s);
  const orderBy = c.orderby && c.orderby !== 'menu_order' ? orderByFor(c.orderby, c.order) : [{ menuOrder: c.order }, { id: 'asc' }];
  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, include: variationInclude, orderBy, skip: c.skip, take: c.take }),
  ]);
  setPaginationHeaders(req, res, total, c);
  res.json(rows.map((v) => serializeVariation(v, s)));
}));

router.post('/:pid(\\d+)/variations', can('edit_products'), ah(async (req, res) => {
  const s = await store();
  const parent = await findParent(req.params.pid);
  const v = await svc.createOrUpdateVariation(parent, req.body || {}, s);
  res.status(201).json(serializeVariation(await findVariation(parent.id, v.id), s));
}));

router.post('/:pid(\\d+)/variations/batch', can('edit_products'), ah(async (req, res) => {
  const s = await store();
  const parent = await findParent(req.params.pid);
  res.json(await runBatch(req.body || {}, {
    create: async (item) => serializeVariation(await findVariation(parent.id, (await svc.createOrUpdateVariation(parent, item, s)).id), s),
    update: async (id, item) => {
      const existing = await findVariation(parent.id, id);
      await svc.createOrUpdateVariation(parent, item, s, existing);
      return serializeVariation(await findVariation(parent.id, existing.id), s);
    },
    remove: async (id) => {
      const existing = await findVariation(parent.id, id);
      const out = serializeVariation(existing, s);
      await svc.deleteProduct(existing, true);
      return out;
    },
  }));
}));

router.get('/:pid(\\d+)/variations/:id(\\d+)', publicRead('read'), cached(), ah(async (req, res) => {
  const s = await store();
  const parent = await findParent(req.params.pid, req);
  const v = await findVariation(parent.id, req.params.id);
  if (!isStaff(req) && v.status !== 'publish') throw new ApiError(404, 'woocommerce_rest_product_variation_invalid_id', 'Invalid ID.');
  res.json(serializeVariation(v, s));
}));

const updateVariation = ah(async (req, res) => {
  const s = await store();
  const parent = await findParent(req.params.pid);
  const existing = await findVariation(parent.id, req.params.id);
  await svc.createOrUpdateVariation(parent, req.body || {}, s, existing);
  res.json(serializeVariation(await findVariation(parent.id, existing.id), s));
});
router.put('/:pid(\\d+)/variations/:id(\\d+)', can('edit_products'), updateVariation);
router.patch('/:pid(\\d+)/variations/:id(\\d+)', can('edit_products'), updateVariation);

router.delete('/:pid(\\d+)/variations/:id(\\d+)', can('edit_products'), ah(async (req, res) => {
  const s = await store();
  const parent = await findParent(req.params.pid);
  const existing = await findVariation(parent.id, req.params.id);
  const out = serializeVariation(existing, s);
  await svc.deleteProduct(existing, bool(req.query.force ?? req.body?.force));
  res.json(out);
}));

module.exports = router;
