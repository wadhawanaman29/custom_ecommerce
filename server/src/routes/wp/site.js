// Menus (wp/v2/menus, wp/v2/menu-items, menus/v1 plugin format), wp/v2/settings, wp/v2/search,
// and custom headless helpers (custom/v1/cart/calculate).
const express = require('express');
const prisma = require('../../db');
const config = require('../../config');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { bool } = require('../../lib/format');
const { slugify } = require('../../lib/slug');
const options = require('../../lib/options');
const { cached } = require('../../lib/cache');
const { can } = require('../../middleware/auth');

const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
const WP = `${config.siteUrl}/wp-json/wp/v2`;

// Resolve menu item URLs for page/post/category links
async function resolveItemUrls(items) {
  const postIds = items.filter((i) => i.type === 'post_type' && ['page', 'post'].includes(i.object)).map((i) => i.objectId);
  const prodIds = items.filter((i) => i.object === 'product').map((i) => i.objectId);
  const catIds = items.filter((i) => i.object === 'category' || i.object === 'post_tag').map((i) => i.objectId);
  const pcatIds = items.filter((i) => i.object === 'product_cat').map((i) => i.objectId);
  const [posts, prods, terms, pcats] = await Promise.all([
    prisma.post.findMany({ where: { id: { in: postIds } }, select: { id: true, slug: true, type: true, title: true } }),
    prisma.product.findMany({ where: { id: { in: prodIds } }, select: { id: true, slug: true, name: true } }),
    prisma.term.findMany({ where: { id: { in: catIds } }, select: { id: true, slug: true, taxonomy: true, name: true } }),
    prisma.productCategory.findMany({ where: { id: { in: pcatIds } }, select: { id: true, slug: true, name: true } }),
  ]);
  const F = config.frontendUrl;
  return (i) => {
    if (i.type === 'custom') return { url: i.url, title: i.title };
    if (i.object === 'page' || i.object === 'post') { const p = posts.find((x) => x.id === i.objectId); return p ? { url: `${F}/${p.slug}/`, title: i.title || p.title } : { url: i.url, title: i.title }; }
    if (i.object === 'product') { const p = prods.find((x) => x.id === i.objectId); return p ? { url: `${F}/product/${p.slug}/`, title: i.title || p.name } : { url: i.url, title: i.title }; }
    if (i.object === 'product_cat') { const c = pcats.find((x) => x.id === i.objectId); return c ? { url: `${F}/product-category/${c.slug}/`, title: i.title || c.name } : { url: i.url, title: i.title }; }
    const t = terms.find((x) => x.id === i.objectId);
    return t ? { url: `${F}/${t.taxonomy === 'category' ? 'category' : 'tag'}/${t.slug}/`, title: i.title || t.name } : { url: i.url, title: i.title };
  };
}

const menuOut = (m) => ({
  id: m.id, description: '', name: m.name, slug: m.slug, meta: [], locations: m.locations || [], auto_add: false,
  _links: { self: [{ href: `${WP}/menus/${m.id}` }], collection: [{ href: `${WP}/menus` }] },
});

// WP core v2 menu-item shape
async function menuItemsOut(items) {
  const resolve = await resolveItemUrls(items);
  return items.map((i) => {
    const r = resolve(i);
    return {
      id: i.id, title: { rendered: r.title }, status: 'publish', url: r.url, attr_title: '', description: '',
      type: i.type, type_label: i.type === 'custom' ? 'Custom Link' : i.object, object: i.object, object_id: i.objectId,
      parent: i.parentId, menu_order: i.menuOrder, target: i.target, classes: i.classes ? i.classes.split(' ') : [''], xfn: [''],
      invalid: false, meta: [], menus: i.menuId,
      _links: { self: [{ href: `${WP}/menu-items/${i.id}` }], collection: [{ href: `${WP}/menu-items` }] },
    };
  });
}

// "WP REST API Menus" plugin shape (menus/v1/menus/:slug) with nested child_items
async function legacyMenuOut(menu) {
  const items = await prisma.menuItem.findMany({ where: { menuId: menu.id }, orderBy: { menuOrder: 'asc' } });
  const resolve = await resolveItemUrls(items);
  const flat = items.map((i) => {
    const r = resolve(i);
    return {
      ID: i.id, id: i.id, title: r.title, url: r.url, menu_order: i.menuOrder, menu_item_parent: String(i.parentId), object_id: String(i.objectId),
      object: i.object, type: i.type, type_label: i.type === 'custom' ? 'Custom Link' : i.object, target: i.target, classes: i.classes ? i.classes.split(' ') : [''], child_items: [],
    };
  });
  const byId = new Map(flat.map((i) => [i.ID, i]));
  const roots = [];
  for (const i of flat) {
    const p = Number(i.menu_item_parent) ? byId.get(Number(i.menu_item_parent)) : null;
    if (p) p.child_items.push(i); else roots.push(i);
  }
  const prune = (list) => list.forEach((i) => { if (!i.child_items.length) delete i.child_items; else prune(i.child_items); });
  prune(roots);
  return { term_id: menu.id, name: menu.name, slug: menu.slug, term_group: 0, term_taxonomy_id: menu.id, taxonomy: 'nav_menu', description: '', parent: 0, count: items.length, filter: 'raw', items: roots };
}

const menus = express.Router();
menus.get('/', cached(), ah(async (req, res) => res.json((await prisma.menu.findMany({ orderBy: { name: 'asc' } })).map(menuOut))));
menus.post('/', can('edit_others_pages'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): name');
  const m = await prisma.menu.create({ data: { name: String(b.name), slug: slugify(b.slug || b.name), locations: Array.isArray(b.locations) ? b.locations : [] } });
  res.status(201).json(menuOut(m));
}));
const findMenu = async (id) => {
  const m = await prisma.menu.findUnique({ where: { id: intParam(id, 'rest_term_invalid') } });
  if (!m) throw new ApiError(404, 'rest_term_invalid', 'Term does not exist.');
  return m;
};
menus.get('/:id(\\d+)', cached(), ah(async (req, res) => res.json(menuOut(await findMenu(req.params.id)))));
const updMenu = ah(async (req, res) => {
  const m = await findMenu(req.params.id);
  const b = req.body || {};
  const d = {};
  if (has(b, 'name')) d.name = String(b.name);
  if (has(b, 'slug')) d.slug = slugify(b.slug);
  if (has(b, 'locations')) d.locations = Array.isArray(b.locations) ? b.locations : [];
  res.json(menuOut(await prisma.menu.update({ where: { id: m.id }, data: d })));
});
menus.post('/:id(\\d+)', can('edit_others_pages'), updMenu);
menus.put('/:id(\\d+)', can('edit_others_pages'), updMenu);
menus.delete('/:id(\\d+)', can('edit_others_pages'), ah(async (req, res) => {
  const m = await findMenu(req.params.id);
  await prisma.menu.delete({ where: { id: m.id } });
  res.json({ deleted: true, previous: menuOut(m) });
}));

const menuItems = express.Router();
menuItems.get('/', cached(), ah(async (req, res) => {
  const where = {};
  if (req.query.menus) where.menuId = { in: String(req.query.menus).split(',').map(Number) };
  const items = await prisma.menuItem.findMany({ where, orderBy: [{ menuId: 'asc' }, { menuOrder: 'asc' }], take: Math.min(parseInt(req.query.per_page, 10) || 100, 100) });
  res.json(await menuItemsOut(items));
}));
async function saveMenuItem(b, existing) {
  const d = {};
  if (has(b, 'menus')) d.menuId = parseInt(b.menus, 10);
  if (has(b, 'title')) d.title = typeof b.title === 'object' ? String(b.title.raw ?? b.title.rendered ?? '') : String(b.title);
  if (has(b, 'url')) d.url = String(b.url);
  if (has(b, 'type')) d.type = String(b.type);
  if (has(b, 'object')) d.object = String(b.object);
  if (has(b, 'object_id')) d.objectId = parseInt(b.object_id, 10) || 0;
  if (has(b, 'parent')) d.parentId = parseInt(b.parent, 10) || 0;
  if (has(b, 'menu_order')) d.menuOrder = parseInt(b.menu_order, 10) || 0;
  if (has(b, 'target')) d.target = String(b.target);
  if (has(b, 'classes')) d.classes = (Array.isArray(b.classes) ? b.classes : [b.classes]).join(' ').trim();
  if (!existing && !d.menuId) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): menus');
  return existing ? prisma.menuItem.update({ where: { id: existing.id }, data: d }) : prisma.menuItem.create({ data: { title: '', ...d } });
}
const findItem = async (id) => {
  const i = await prisma.menuItem.findUnique({ where: { id: intParam(id, 'rest_post_invalid_id') } });
  if (!i) throw new ApiError(404, 'rest_post_invalid_id', 'Invalid post ID.');
  return i;
};
menuItems.post('/', can('edit_others_pages'), ah(async (req, res) => res.status(201).json((await menuItemsOut([await saveMenuItem(req.body || {}, null)]))[0])));
menuItems.get('/:id(\\d+)', cached(), ah(async (req, res) => res.json((await menuItemsOut([await findItem(req.params.id)]))[0])));
const updItem = ah(async (req, res) => res.json((await menuItemsOut([await saveMenuItem(req.body || {}, await findItem(req.params.id))]))[0]));
menuItems.post('/:id(\\d+)', can('edit_others_pages'), updItem);
menuItems.put('/:id(\\d+)', can('edit_others_pages'), updItem);
menuItems.delete('/:id(\\d+)', can('edit_others_pages'), ah(async (req, res) => {
  const i = await findItem(req.params.id);
  const out = (await menuItemsOut([i]))[0];
  await prisma.menuItem.delete({ where: { id: i.id } });
  res.json({ deleted: true, previous: out });
}));

// menus/v1 (WP REST API Menus plugin)
const menusV1 = express.Router();
menusV1.get('/menus', cached(), ah(async (req, res) => {
  const list = await prisma.menu.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { items: true } } } });
  res.json(list.map((m) => ({ term_id: m.id, name: m.name, slug: m.slug, count: m._count.items, meta: { links: { collection: `${config.siteUrl}/wp-json/menus/v1/menus`, self: `${config.siteUrl}/wp-json/menus/v1/menus/${m.slug}` } } })));
}));
menusV1.get('/menus/:idOrSlug', cached(), ah(async (req, res) => {
  const v = req.params.idOrSlug;
  const menu = /^\d+$/.test(v) ? await prisma.menu.findUnique({ where: { id: Number(v) } }) : await prisma.menu.findUnique({ where: { slug: v } });
  if (!menu) throw new ApiError(404, 'rest_invalid_menu', 'Invalid menu id or slug.');
  res.json(await legacyMenuOut(menu));
}));
menusV1.get('/locations', cached(), ah(async (req, res) => {
  const list = await prisma.menu.findMany();
  const out = {};
  for (const m of list) for (const loc of m.locations || []) out[loc] = { ID: m.id, label: loc, slug: loc };
  res.json(out);
}));
menusV1.get('/locations/:location', cached(), ah(async (req, res) => {
  const list = await prisma.menu.findMany();
  const menu = list.find((m) => (m.locations || []).includes(req.params.location));
  if (!menu) return res.json([]);
  res.json((await legacyMenuOut(menu)).items);
}));

// ── wp/v2/settings ──
const SETTINGS_MAP = {
  title: 'blogname', description: 'blogdescription', email: 'admin_email', timezone: 'timezone_string',
  date_format: 'date_format', time_format: 'time_format', start_of_week: 'start_of_week', language: 'WPLANG',
  posts_per_page: 'posts_per_page', default_comment_status: 'default_comment_status', show_on_front: 'show_on_front',
  page_on_front: 'page_on_front', page_for_posts: 'page_for_posts', site_logo: 'site_logo', site_icon: 'site_icon',
};
const NUMERIC = ['start_of_week', 'posts_per_page', 'page_on_front', 'page_for_posts', 'site_logo', 'site_icon'];
async function settingsOut() {
  const out = { url: config.frontendUrl };
  for (const [k, opt] of Object.entries(SETTINGS_MAP)) {
    const v = await options.getOption(opt);
    out[k] = NUMERIC.includes(k) ? parseInt(v, 10) || 0 : v ?? '';
  }
  out.language = out.language || 'en_US';
  out.use_smilies = true;
  out.default_category = 1;
  out.default_post_format = '0';
  out.default_ping_status = 'open';
  return out;
}
const settings = express.Router();
settings.get('/', can('*'), ah(async (req, res) => res.json(await settingsOut())));
const updSettings = ah(async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) if (SETTINGS_MAP[k]) await options.setOption(SETTINGS_MAP[k], NUMERIC.includes(k) ? String(parseInt(v, 10) || 0) : v);
  res.json(await settingsOut());
});
settings.post('/', can('*'), updSettings);
settings.put('/', can('*'), updSettings);

// ── wp/v2/search ──
const search = express.Router();
search.get('/', cached(), ah(async (req, res) => {
  const term = String(req.query.search || '');
  const perPage = Math.min(parseInt(req.query.per_page, 10) || 10, 100);
  const type = req.query.type || 'post';
  const out = [];
  if (type === 'post' && term) {
    const sub = req.query.subtype && req.query.subtype !== 'any' ? String(req.query.subtype).split(',') : ['post', 'page', 'product'];
    if (sub.includes('post') || sub.includes('page')) {
      const sw = await require('../../lib/search').searchWhere('Post', ['title', 'content'], term, ['slug']);
      const rows = await prisma.post.findMany({ where: { status: 'publish', type: { in: sub.filter((x) => x !== 'product') }, ...(sw || {}) }, take: perPage, orderBy: { createdAt: 'desc' } });
      out.push(...rows.map((p) => ({ id: p.id, title: p.title, url: `${config.frontendUrl}/${p.slug}/`, type: 'post', subtype: p.type })));
    }
    if (sub.includes('product')) {
      const sw = await require('../../lib/search').searchWhere('Product', ['name', 'sku'], term, ['sku']);
      const rows = await prisma.product.findMany({ where: { status: 'publish', type: { not: 'variation' }, ...(sw || {}) }, take: perPage });
      out.push(...rows.map((p) => ({ id: p.id, title: p.name, url: `${config.frontendUrl}/product/${p.slug}/`, type: 'post', subtype: 'product' })));
    }
  }
  res.json(out.slice(0, perPage));
}));

// ── custom/v1: headless helpers ──
const custom = express.Router();
// Preview totals + available shipping rates for a cart. Body = POST /orders body (+ optional shipping_rate_id).
custom.post('/cart/calculate', ah(async (req, res) => {
  const { previewOrder } = require('../../services/order');
  const s = await options.store();
  res.json(await previewOrder(req.body || {}, s));
}));
// Validate a coupon against a cart without placing an order
custom.post('/coupons/validate', ah(async (req, res) => {
  const { previewOrder } = require('../../services/order');
  const s = await options.store();
  const b = req.body || {};
  if (!b.code) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): code');
  try {
    const r = await previewOrder({ ...b, coupon_lines: [{ code: b.code }] }, s);
    res.json({ valid: true, discount: r.coupon_lines[0]?.discount || '0', totals: r.totals });
  } catch (e) {
    if (e instanceof ApiError) return res.json({ valid: false, code: e.code, message: e.message });
    throw e;
  }
}));
// Store-wide public settings the frontend needs (currency, tax display, etc.)
custom.get('/store', cached(), ah(async (req, res) => {
  const s = await options.store();
  const o = await options.getOptions(['blogname', 'blogdescription', 'woocommerce_tax_display_shop', 'woocommerce_tax_display_cart', 'woocommerce_price_display_suffix', 'woocommerce_enable_guest_checkout', 'woocommerce_enable_reviews', 'woocommerce_weight_unit', 'woocommerce_dimension_unit', 'site_logo']);
  const gateways = await prisma.paymentGateway.findMany({ where: { enabled: true }, orderBy: { order: 'asc' }, select: { id: true, title: true, description: true } });
  res.json({
    name: o.blogname, description: o.blogdescription, currency: s.currency, currency_symbol: require('../../lib/currency').symbol(s.currency),
    currency_position: s.currencyPos, thousand_separator: s.thousandSep, decimal_separator: s.decimalSep, decimals: s.dp,
    prices_include_tax: s.pricesIncludeTax, calc_taxes: s.calcTaxes, tax_display_shop: o.woocommerce_tax_display_shop, tax_display_cart: o.woocommerce_tax_display_cart,
    price_display_suffix: o.woocommerce_price_display_suffix, guest_checkout: o.woocommerce_enable_guest_checkout === 'yes', reviews_enabled: o.woocommerce_enable_reviews === 'yes',
    coupons_enabled: s.couponsEnabled, weight_unit: o.woocommerce_weight_unit, dimension_unit: o.woocommerce_dimension_unit, base_location: s.base, payment_gateways: gateways,
  });
}));
// Lookup an order by key (for "order received" pages without login)
custom.get('/orders/:id(\\d+)/received', ah(async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: intParam(req.params.id) }, include: { items: true, refunds: true } });
  if (!order || !req.query.key || order.orderKey !== req.query.key) throw new ApiError(404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid order.');
  const { serializeOrders } = require('../../serializers/order');
  const [o] = await serializeOrders([order], await options.store());
  delete o.customer_ip_address; delete o.customer_user_agent; delete o.meta_data;
  res.json(o);
}));
// Payment confirmation from your payment flow: marks an order paid by order key (server-to-server use with an API key)
custom.post('/orders/:id(\\d+)/payment-complete', can('edit_shop_orders'), ah(async (req, res) => {
  const { saveOrder } = require('../../services/order');
  const s = await options.store();
  const order = await prisma.order.findUnique({ where: { id: intParam(req.params.id) }, include: { items: true, refunds: true } });
  if (!order) throw new ApiError(404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.');
  if (!['pending', 'failed', 'on-hold'].includes(order.status)) return res.json({ id: order.id, status: order.status, already_paid: true });
  await saveOrder({ set_paid: true, transaction_id: String((req.body || {}).transaction_id || '') }, s, order, req);
  const updated = await prisma.order.findUnique({ where: { id: order.id } });
  res.json({ id: updated.id, status: updated.status, already_paid: false });
}));

module.exports = { menus, menuItems, menusV1, settings, search, custom, bool };
