// Translates WooCommerce REST product payloads into DB writes, applying WC business rules.
const prisma = require('../db');
const { ApiError, badRequest } = require('../lib/http');
const { parseWpDate, bool, metaMerge } = require('../lib/format');
const { uniqueSlug, slugify } = require('../lib/slug');
const { isOnSale } = require('../serializers/product');

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const dec = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : parseInt(v, 10));
const idArr = (v) => (Array.isArray(v) ? v.map((x) => parseInt(typeof x === 'object' ? x.id : x, 10)).filter(Boolean) : []);

const PRODUCT_TYPES = ['simple', 'variable', 'grouped', 'external'];
const STATUSES = ['draft', 'pending', 'private', 'publish', 'future', 'trash'];

// Scalar fields shared by products and variations
async function scalarData(body, existing, s) {
  const d = {};
  const set = (key, field, fn = (x) => x) => { if (has(body, key)) d[field] = fn(body[key]); };

  set('name', 'name', String);
  set('description', 'description', String);
  set('short_description', 'shortDescription', String);
  set('status', 'status', (v) => {
    if (!STATUSES.includes(v)) throw badRequest('rest_invalid_param', 'Invalid parameter(s): status');
    return v;
  });
  set('featured', 'featured', bool);
  set('catalog_visibility', 'catalogVisibility', String);
  set('regular_price', 'regularPrice', dec);
  set('sale_price', 'salePrice', dec);
  set('virtual', 'virtual', bool);
  set('downloadable', 'downloadable', bool);
  set('downloads', 'downloads', (v) => (Array.isArray(v) ? v.map((x, i) => ({ id: x.id || `${Date.now()}-${i}`, name: x.name || '', file: x.file || '' })) : []));
  set('download_limit', 'downloadLimit', (v) => parseInt(v, 10));
  set('download_expiry', 'downloadExpiry', (v) => parseInt(v, 10));
  set('external_url', 'externalUrl', String);
  set('button_text', 'buttonText', String);
  set('tax_status', 'taxStatus', String);
  set('tax_class', 'taxClass', (v) => (v === 'standard' ? '' : String(v)));
  set('manage_stock', 'manageStock', (v) => v === 'parent' ? false : bool(v));
  set('stock_quantity', 'stockQuantity', intOrNull);
  set('stock_status', 'stockStatus', String);
  set('backorders', 'backorders', String);
  set('low_stock_amount', 'lowStockAmount', intOrNull);
  set('sold_individually', 'soldIndividually', bool);
  set('weight', 'weight', (v) => String(v ?? ''));
  set('reviews_allowed', 'reviewsAllowed', bool);
  set('purchase_note', 'purchaseNote', String);
  set('menu_order', 'menuOrder', (v) => parseInt(v, 10) || 0);
  set('upsell_ids', 'upsellIds', idArr);
  set('cross_sell_ids', 'crossSellIds', idArr);
  set('grouped_products', 'groupedProducts', idArr);
  set('default_attributes', 'defaultAttributes', (v) => (Array.isArray(v) ? v : []));

  if (has(body, 'dimensions') && body.dimensions) {
    for (const k of ['length', 'width', 'height']) if (has(body.dimensions, k)) d[k] = String(body.dimensions[k] ?? '');
  }

  // Sale dates (local or *_gmt)
  for (const [key, field] of [['date_on_sale_from', 'dateOnSaleFrom'], ['date_on_sale_to', 'dateOnSaleTo']]) {
    if (has(body, `${key}_gmt`)) d[field] = parseWpDate(body[`${key}_gmt`], true);
    else if (has(body, key)) d[field] = parseWpDate(body[key], false, s.gmtOffset);
  }
  if (has(body, 'date_created_gmt')) d.createdAt = parseWpDate(body.date_created_gmt, true) || undefined;
  else if (has(body, 'date_created')) d.createdAt = parseWpDate(body.date_created, false, s.gmtOffset) || undefined;

  if (has(body, 'sku')) {
    const sku = String(body.sku || '').trim();
    if (sku) {
      const dupe = await prisma.product.findFirst({ where: { sku, NOT: existing ? { id: existing.id } : undefined }, select: { id: true } });
      if (dupe) throw badRequest('product_invalid_sku', 'Invalid or duplicated SKU.', { resource_id: dupe.id, unique_sku: sku });
    }
    d.sku = sku || null;
  }

  if (has(body, 'shipping_class')) {
    if (!body.shipping_class) d.shippingClassId = null;
    else {
      const sc = await prisma.shippingClass.findUnique({ where: { slug: String(body.shipping_class) } });
      d.shippingClassId = sc ? sc.id : null;
    }
  }

  if (has(body, 'meta_data')) d.meta = metaMerge(existing?.meta, body.meta_data);

  // ── Derived: active price ──
  const merged = { ...(existing || {}), ...d };
  const regular = merged.regularPrice ?? null;
  const sale = merged.salePrice ?? null;
  const onSale = sale !== null && isOnSale({ ...merged, salePrice: sale, regularPrice: regular });
  d.price = onSale ? sale : regular;

  // ── Derived: stock status (WC: managed stock decides the status) ──
  if (merged.manageStock && (s.manageStock)) {
    const qty = merged.stockQuantity ?? 0;
    if (qty > s.noStockAmount) d.stockStatus = 'instock';
    else if ((merged.backorders || 'no') !== 'no') d.stockStatus = 'onbackorder';
    else d.stockStatus = 'outofstock';
  }
  if (merged.manageStock === false && has(d, 'manageStock')) d.stockQuantity = null;

  return d;
}

async function resolveImages(images) {
  // images: [{ id }] or [{ src, name, alt }]. Returns media ids in order.
  const out = [];
  for (const img of images || []) {
    if (!img) continue;
    if (img.id) {
      const m = await prisma.media.findUnique({ where: { id: parseInt(img.id, 10) } });
      if (!m) throw badRequest('woocommerce_product_invalid_image_id', `#${img.id} is an invalid image ID.`);
      if (img.alt !== undefined || img.name !== undefined) {
        await prisma.media.update({ where: { id: m.id }, data: { altText: img.alt ?? m.altText, title: img.name ?? m.title } });
      }
      out.push(m.id);
    } else if (img.src) {
      // Remote image: registered by URL (not downloaded). Upload via /wp/v2/media to host it locally.
      const fileName = String(img.src).split('?')[0].split('/').pop() || 'image';
      const m = await prisma.media.create({
        data: { title: img.name || fileName.replace(/\.[^.]+$/, ''), slug: slugify(fileName), fileName, path: String(img.src), mimeType: guessMime(fileName), altText: img.alt || '' },
      });
      out.push(m.id);
    }
  }
  return out;
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || 'application/octet-stream';
}

async function setImages(tx, productId, mediaIds) {
  await tx.productImage.deleteMany({ where: { productId } });
  if (mediaIds.length) {
    await tx.productImage.createMany({ data: [...new Set(mediaIds)].map((mediaId, position) => ({ productId, mediaId, position })) });
  }
}

async function resolveAttributes(attrs) {
  const rows = [];
  for (let i = 0; i < (attrs || []).length; i++) {
    const a = attrs[i];
    let attributeId = parseInt(a.id, 10) || 0;
    let { name } = a;
    if (!attributeId && a.slug && String(a.slug).startsWith('pa_')) {
      const g = await prisma.attribute.findUnique({ where: { slug: String(a.slug).slice(3) } });
      if (g) attributeId = g.id;
    }
    if (attributeId) {
      const g = await prisma.attribute.findUnique({ where: { id: attributeId } });
      if (!g) throw badRequest('woocommerce_rest_invalid_attribute', 'Invalid attribute ID.');
      name = g.name;
    }
    const options = Array.isArray(a.options) ? a.options.map(String) : (a.option ? [String(a.option)] : []);
    rows.push({
      attributeId, name: name || '', position: a.position ?? i, visible: a.visible === undefined ? true : bool(a.visible),
      variation: bool(a.variation), options,
    });
  }
  return rows;
}

// Variation attributes [{ id, name, option }] — fill name for global attributes
async function resolveVariationAttributes(attrs) {
  const out = [];
  for (const a of attrs || []) {
    let id = parseInt(a.id, 10) || 0;
    let { name } = a;
    if (id) {
      const g = await prisma.attribute.findUnique({ where: { id } });
      if (g) name = g.name; else id = 0;
    }
    out.push({ id, name: name || '', option: a.option === undefined ? '' : String(a.option) });
  }
  return out;
}

const termConnect = (list) => idArr(list).map((id) => ({ id }));

async function createOrUpdateProduct(body, s, existing = null) {
  if (has(body, 'type') && !PRODUCT_TYPES.includes(body.type)) {
    throw badRequest('rest_invalid_param', 'Invalid parameter(s): type');
  }
  const data = await scalarData(body, existing, s);
  if (has(body, 'type')) data.type = body.type;
  if (has(body, 'parent_id')) data.parentId = parseInt(body.parent_id, 10) || null;

  if (!existing || has(body, 'slug') || (has(body, 'name') && !existing.slug)) {
    const base = body.slug || data.name || existing?.name || 'product';
    data.slug = await uniqueSlug(base, async (slug) => !!(await prisma.product.findFirst({
      where: { slug, type: { not: 'variation' }, NOT: existing ? { id: existing.id } : undefined }, select: { id: true },
    })));
  }

  const mediaIds = has(body, 'images') ? await resolveImages(body.images) : null;
  const attributes = has(body, 'attributes') ? await resolveAttributes(body.attributes) : null;

  return prisma.$transaction(async (tx) => {
    const relationData = {};
    if (has(body, 'categories')) relationData.categories = { set: termConnect(body.categories) };
    if (has(body, 'tags')) relationData.tags = { set: termConnect(body.tags) };

    let product;
    if (existing) {
      product = await tx.product.update({ where: { id: existing.id }, data: { ...data, ...relationData } });
    } else {
      if (relationData.categories) relationData.categories = { connect: relationData.categories.set };
      if (relationData.tags) relationData.tags = { connect: relationData.tags.set };
      product = await tx.product.create({ data: { ...data, ...relationData } });
    }
    if (mediaIds) await setImages(tx, product.id, mediaIds);
    if (attributes) {
      await tx.productAttribute.deleteMany({ where: { productId: product.id } });
      if (attributes.length) await tx.productAttribute.createMany({ data: attributes.map((a) => ({ ...a, productId: product.id })) });
    }
    return product;
  });
}

async function createOrUpdateVariation(parent, body, s, existing = null) {
  const data = await scalarData(body, existing, s);
  if (has(body, 'attributes')) data.variationAttributes = await resolveVariationAttributes(body.attributes);
  // Variation name: "Parent – Option, Option" like WC
  const attrs = data.variationAttributes || existing?.variationAttributes || [];
  data.name = `${parent.name}${attrs.length ? ` - ${attrs.map((a) => a.option).filter(Boolean).join(', ')}` : ''}`;
  if (!existing) {
    data.type = 'variation';
    data.parentId = parent.id;
    data.slug = slugify(data.name);
  }
  const mediaIds = has(body, 'image') ? (body.image ? await resolveImages([body.image]) : []) : null;

  const variation = await prisma.$transaction(async (tx) => {
    const v = existing
      ? await tx.product.update({ where: { id: existing.id }, data })
      : await tx.product.create({ data });
    if (mediaIds) await setImages(tx, v.id, mediaIds);
    return v;
  });
  await syncVariableParent(parent.id);
  return variation;
}

// Keep the parent's price/stock_status in sync with its variations (WC_Product_Variable::sync)
async function syncVariableParent(parentId) {
  const vars = await prisma.product.findMany({
    where: { parentId, status: 'publish' },
    select: { price: true, stockStatus: true },
  });
  const prices = vars.map((v) => v.price).filter((p) => p !== null).map(Number);
  let stockStatus = 'outofstock';
  if (vars.some((v) => v.stockStatus === 'instock')) stockStatus = 'instock';
  else if (vars.some((v) => v.stockStatus === 'onbackorder')) stockStatus = 'onbackorder';
  const parent = await prisma.product.findUnique({ where: { id: parentId }, select: { manageStock: true } });
  await prisma.product.update({
    where: { id: parentId },
    data: {
      price: prices.length ? Math.min(...prices) : null,
      ...(parent && !parent.manageStock ? { stockStatus } : {}),
    },
  });
}

async function deleteProduct(product, force) {
  if (product.type === 'variation' && !force) {
    throw new ApiError(501, 'woocommerce_rest_trash_not_supported', 'Variations do not support trashing.');
  }
  if (force) {
    await prisma.product.delete({ where: { id: product.id } });
    if (product.parentId) await syncVariableParent(product.parentId);
  } else {
    if (product.status === 'trash') throw new ApiError(410, 'woocommerce_rest_already_trashed', `The product with ID ${product.id} has already been deleted.`);
    await prisma.product.update({ where: { id: product.id }, data: { status: 'trash' } });
  }
}

module.exports = { createOrUpdateProduct, createOrUpdateVariation, deleteProduct, syncVariableParent, resolveImages };
