// /taxes, /taxes/classes, /shipping/zones, /shipping_methods, /payment_gateways, /settings, /data, /reports
const express = require('express');
const prisma = require('../../db');
const config = require('../../config');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { parseCollection, setPaginationHeaders } = require('../../lib/pagination');
const { bool, money } = require('../../lib/format');
const { slugify } = require('../../lib/slug');
const options = require('../../lib/options');
const registry = require('../../lib/settings-registry');
const { runBatch } = require('../../lib/batch');
const { SYMBOLS, symbol } = require('../../lib/currency');
const { can } = require('../../middleware/auth');
const { clearRatesCache } = require('../../services/tax');
const shipping = require('../../services/shipping');

const API = `${config.siteUrl}/wp-json/wc/v3`;
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
const router = express.Router();
const admin = can('manage_woocommerce');

// ───────────── Taxes ─────────────
const taxOut = (r) => ({
  id: r.id,
  country: r.country,
  state: r.state,
  postcode: Array.isArray(r.postcodes) ? r.postcodes.join(';') : '',
  city: Array.isArray(r.cities) ? r.cities.join(';') : '',
  postcodes: r.postcodes || [],
  cities: r.cities || [],
  rate: Number(r.rate).toFixed(4),
  name: r.name,
  priority: r.priority,
  compound: r.compound,
  shipping: r.shipping,
  order: r.order,
  class: r.class,
  _links: { self: [{ href: `${API}/taxes/${r.id}` }], collection: [{ href: `${API}/taxes` }] },
});
const splitList = (v) => (Array.isArray(v) ? v : String(v || '').split(';')).map((x) => String(x).trim()).filter(Boolean);
function taxData(body) {
  const d = {};
  if (has(body, 'country')) d.country = String(body.country || '').toUpperCase();
  if (has(body, 'state')) d.state = String(body.state || '').toUpperCase();
  if (has(body, 'postcodes')) d.postcodes = splitList(body.postcodes);
  else if (has(body, 'postcode')) d.postcodes = splitList(body.postcode);
  if (has(body, 'cities')) d.cities = splitList(body.cities);
  else if (has(body, 'city')) d.cities = splitList(body.city);
  if (has(body, 'rate')) d.rate = Number(body.rate) || 0;
  if (has(body, 'name')) d.name = String(body.name);
  if (has(body, 'priority')) d.priority = parseInt(body.priority, 10) || 1;
  if (has(body, 'compound')) d.compound = bool(body.compound);
  if (has(body, 'shipping')) d.shipping = bool(body.shipping);
  if (has(body, 'order')) d.order = parseInt(body.order, 10) || 0;
  if (has(body, 'class')) d.class = String(body.class || 'standard');
  return d;
}
const findTax = async (id) => {
  const r = await prisma.taxRate.findUnique({ where: { id: intParam(id, 'woocommerce_rest_invalid_id') } });
  if (!r) throw new ApiError(404, 'woocommerce_rest_invalid_id', 'Invalid resource ID.');
  return r;
};
router.get('/taxes', admin, ah(async (req, res) => {
  const c = parseCollection(req.query, { defaultOrder: 'asc' });
  const where = req.query.class ? { class: String(req.query.class) } : {};
  const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'priority' ? { priority: c.order } : [{ order: c.order }, { id: 'asc' }];
  const [total, rows] = await Promise.all([prisma.taxRate.count({ where }), prisma.taxRate.findMany({ where, orderBy, skip: c.skip, take: c.take })]);
  setPaginationHeaders(req, res, total, c);
  res.json(rows.map(taxOut));
}));
router.post('/taxes', admin, ah(async (req, res) => { const r = await prisma.taxRate.create({ data: taxData(req.body || {}) }); clearRatesCache(); res.status(201).json(taxOut(r)); }));
router.post('/taxes/batch', admin, ah(async (req, res) => {
  const out = await runBatch(req.body || {}, {
    create: async (item) => taxOut(await prisma.taxRate.create({ data: taxData(item) })),
    update: async (id, item) => taxOut(await prisma.taxRate.update({ where: { id: (await findTax(id)).id }, data: taxData(item) })),
    remove: async (id) => { const r = await findTax(id); await prisma.taxRate.delete({ where: { id: r.id } }); return taxOut(r); },
  });
  clearRatesCache();
  res.json(out);
}));
router.get('/taxes/classes', admin, ah(async (req, res) => {
  const custom = await prisma.taxClass.findMany({ orderBy: { name: 'asc' } });
  res.json([{ slug: 'standard', name: 'Standard rate' }, ...custom.map((c) => ({ slug: c.slug, name: c.name }))]
    .map((c) => ({ ...c, _links: { collection: [{ href: `${API}/taxes/classes` }] } })));
}));
router.get('/taxes/classes/:slug', admin, ah(async (req, res) => {
  const rates = await prisma.taxRate.findMany({ where: { class: req.params.slug } });
  res.json(rates.map(taxOut));
}));
router.post('/taxes/classes', admin, ah(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): name');
  const slug = slugify(req.body.slug || name);
  if (slug === 'standard' || await prisma.taxClass.findUnique({ where: { slug } })) throw badRequest('woocommerce_rest_tax_class_exists', 'Tax class already exists');
  const c = await prisma.taxClass.create({ data: { slug, name } });
  res.status(201).json({ slug: c.slug, name: c.name });
}));
router.delete('/taxes/classes/:slug', admin, ah(async (req, res) => {
  if (!bool(req.query.force ?? req.body?.force)) throw new ApiError(501, 'woocommerce_rest_trash_not_supported', 'Taxes do not support trashing.');
  const c = await prisma.taxClass.findUnique({ where: { slug: req.params.slug } });
  if (!c) throw new ApiError(404, 'woocommerce_rest_invalid_id', 'Invalid resource ID.');
  await prisma.$transaction([prisma.taxRate.deleteMany({ where: { class: c.slug } }), prisma.taxClass.delete({ where: { slug: c.slug } })]);
  clearRatesCache();
  res.json({ slug: c.slug, name: c.name });
}));
router.get('/taxes/:id(\\d+)', admin, ah(async (req, res) => res.json(taxOut(await findTax(req.params.id)))));
const updTax = ah(async (req, res) => {
  const r = await prisma.taxRate.update({ where: { id: (await findTax(req.params.id)).id }, data: taxData(req.body || {}) });
  clearRatesCache();
  res.json(taxOut(r));
});
router.put('/taxes/:id(\\d+)', admin, updTax);
router.patch('/taxes/:id(\\d+)', admin, updTax);
router.delete('/taxes/:id(\\d+)', admin, ah(async (req, res) => {
  if (!bool(req.query.force ?? req.body?.force)) throw new ApiError(501, 'woocommerce_rest_trash_not_supported', 'Taxes do not support trashing.');
  const r = await findTax(req.params.id);
  await prisma.taxRate.delete({ where: { id: r.id } });
  clearRatesCache();
  res.json(taxOut(r));
}));

// ───────────── Shipping zones ─────────────
const zoneOut = (z) => ({
  id: z.id, name: z.name, order: z.order,
  _links: { self: [{ href: `${API}/shipping/zones/${z.id}` }], collection: [{ href: `${API}/shipping/zones` }], describedby: [{ href: `${API}/shipping/zones/${z.id}/locations` }] },
});
const ZONE0 = { id: 0, name: 'Locations not covered by your other zones', order: 0 };
async function findZone(id) {
  const zid = intParam(id, 'woocommerce_rest_shipping_zone_invalid');
  if (zid === 0) return ZONE0;
  const z = await prisma.shippingZone.findUnique({ where: { id: zid } });
  if (!z) throw new ApiError(404, 'woocommerce_rest_shipping_zone_invalid', 'Invalid resource ID.');
  return z;
}
router.get('/shipping/zones', admin, ah(async (req, res) => {
  const zones = await prisma.shippingZone.findMany({ orderBy: [{ order: 'asc' }, { id: 'asc' }] });
  res.json([ZONE0, ...zones].map(zoneOut));
}));
router.post('/shipping/zones', admin, ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): name');
  res.status(201).json(zoneOut(await prisma.shippingZone.create({ data: { name: String(b.name), order: parseInt(b.order, 10) || 0 } })));
}));
router.get('/shipping/zones/:id(\\d+)', admin, ah(async (req, res) => res.json(zoneOut(await findZone(req.params.id)))));
const updZone = ah(async (req, res) => {
  const z = await findZone(req.params.id);
  if (z.id === 0) throw badRequest('woocommerce_rest_shipping_zone_invalid_zone', 'The "locations not covered by your other zones" zone cannot be updated.');
  const d = {};
  if (has(req.body, 'name')) d.name = String(req.body.name);
  if (has(req.body, 'order')) d.order = parseInt(req.body.order, 10) || 0;
  res.json(zoneOut(await prisma.shippingZone.update({ where: { id: z.id }, data: d })));
});
router.put('/shipping/zones/:id(\\d+)', admin, updZone);
router.patch('/shipping/zones/:id(\\d+)', admin, updZone);
router.delete('/shipping/zones/:id(\\d+)', admin, ah(async (req, res) => {
  const z = await findZone(req.params.id);
  if (z.id === 0) throw badRequest('woocommerce_rest_shipping_zone_invalid_zone', 'The "locations not covered by your other zones" zone cannot be deleted.');
  await prisma.shippingZone.delete({ where: { id: z.id } });
  res.json(zoneOut(z));
}));
router.get('/shipping/zones/:id(\\d+)/locations', admin, ah(async (req, res) => {
  const z = await findZone(req.params.id);
  const locs = z.id ? await prisma.shippingZoneLocation.findMany({ where: { zoneId: z.id }, orderBy: { id: 'asc' } }) : [];
  res.json(locs.map((l) => ({ code: l.code, type: l.type })));
}));
router.put('/shipping/zones/:id(\\d+)/locations', admin, ah(async (req, res) => {
  const z = await findZone(req.params.id);
  if (z.id === 0) throw badRequest('woocommerce_rest_shipping_zone_invalid_zone', 'The "locations not covered by your other zones" zone cannot be updated.');
  const list = Array.isArray(req.body) ? req.body : [];
  const data = list.filter((l) => l && l.code).map((l) => ({ zoneId: z.id, code: String(l.code), type: ['country', 'state', 'postcode', 'continent'].includes(l.type) ? l.type : 'country' }));
  await prisma.$transaction([prisma.shippingZoneLocation.deleteMany({ where: { zoneId: z.id } }), prisma.shippingZoneLocation.createMany({ data })]);
  res.json(data.map((l) => ({ code: l.code, type: l.type })));
}));

// Zone methods
async function methodOut(m) {
  const classes = m.methodId === 'flat_rate' ? await prisma.shippingClass.findMany() : [];
  const schema = shipping.methodSettingsSchema(m.methodId, classes);
  const settings = {};
  for (const f of schema) settings[f.id] = { ...f, value: m.settings && m.settings[f.id] !== undefined ? m.settings[f.id] : f.default };
  const zoneId = m.zoneId || 0;
  return {
    id: m.instanceId,
    instance_id: m.instanceId,
    title: settings.title ? settings.title.value : '',
    order: m.order,
    enabled: m.enabled,
    method_id: m.methodId,
    method_title: shipping.METHODS[m.methodId]?.title || m.methodId,
    method_description: shipping.METHODS[m.methodId]?.description || '',
    settings,
    _links: { self: [{ href: `${API}/shipping/zones/${zoneId}/methods/${m.instanceId}` }], collection: [{ href: `${API}/shipping/zones/${zoneId}/methods` }] },
  };
}
const methodSettings = (incoming, existing) => {
  const out = { ...(existing || {}) };
  for (const [k, v] of Object.entries(incoming || {})) out[k] = v && typeof v === 'object' && has(v, 'value') ? v.value : v;
  return out;
};
async function findMethod(zone, id) {
  const m = await prisma.shippingZoneMethod.findUnique({ where: { instanceId: intParam(id, 'woocommerce_rest_shipping_zone_method_invalid') } });
  if (!m || (m.zoneId || 0) !== zone.id) throw new ApiError(404, 'woocommerce_rest_shipping_zone_method_invalid', 'Resource does not exist.');
  return m;
}
router.get('/shipping/zones/:id(\\d+)/methods', admin, ah(async (req, res) => {
  const z = await findZone(req.params.id);
  const ms = await prisma.shippingZoneMethod.findMany({ where: { zoneId: z.id || null }, orderBy: [{ order: 'asc' }, { instanceId: 'asc' }] });
  res.json(await Promise.all(ms.map(methodOut)));
}));
router.post('/shipping/zones/:id(\\d+)/methods', admin, ah(async (req, res) => {
  const z = await findZone(req.params.id);
  const b = req.body || {};
  if (!shipping.METHODS[b.method_id]) throw badRequest('woocommerce_rest_shipping_zone_method_invalid', 'Resource cannot be created.');
  const m = await prisma.shippingZoneMethod.create({
    data: { zoneId: z.id || null, methodId: b.method_id, order: parseInt(b.order, 10) || 0, enabled: has(b, 'enabled') ? bool(b.enabled) : true, settings: methodSettings(b.settings, { title: shipping.METHODS[b.method_id].title }) },
  });
  res.status(201).json(await methodOut(m));
}));
router.get('/shipping/zones/:id(\\d+)/methods/:mid(\\d+)', admin, ah(async (req, res) => {
  const z = await findZone(req.params.id);
  res.json(await methodOut(await findMethod(z, req.params.mid)));
}));
const updMethod = ah(async (req, res) => {
  const z = await findZone(req.params.id);
  const m = await findMethod(z, req.params.mid);
  const b = req.body || {};
  const d = {};
  if (has(b, 'order')) d.order = parseInt(b.order, 10) || 0;
  if (has(b, 'enabled')) d.enabled = bool(b.enabled);
  if (has(b, 'settings')) d.settings = methodSettings(b.settings, m.settings);
  res.json(await methodOut(await prisma.shippingZoneMethod.update({ where: { instanceId: m.instanceId }, data: d })));
});
router.put('/shipping/zones/:id(\\d+)/methods/:mid(\\d+)', admin, updMethod);
router.patch('/shipping/zones/:id(\\d+)/methods/:mid(\\d+)', admin, updMethod);
router.delete('/shipping/zones/:id(\\d+)/methods/:mid(\\d+)', admin, ah(async (req, res) => {
  const z = await findZone(req.params.id);
  const m = await findMethod(z, req.params.mid);
  const out = await methodOut(m);
  await prisma.shippingZoneMethod.delete({ where: { instanceId: m.instanceId } });
  res.json(out);
}));
router.get('/shipping_methods', admin, (req, res) => {
  res.json(Object.entries(shipping.METHODS).map(([id, m]) => ({ id, title: m.title, description: m.description, _links: { self: [{ href: `${API}/shipping_methods/${id}` }] } })));
});
router.get('/shipping_methods/:id', admin, (req, res, next) => {
  const m = shipping.METHODS[req.params.id];
  if (!m) return next(new ApiError(404, 'woocommerce_rest_shipping_method_invalid', 'Resource does not exist.'));
  res.json({ id: req.params.id, title: m.title, description: m.description });
});

// ───────────── Payment gateways ─────────────
const gatewayOut = (g) => {
  const settings = {};
  const values = { title: g.title, description: g.description, ...(g.settings || {}) };
  for (const [k, v] of Object.entries(values)) {
    settings[k] = { id: k, label: k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), description: '', type: typeof v === 'boolean' ? 'checkbox' : 'text', value: v, default: '', tip: '', placeholder: '' };
  }
  return {
    id: g.id, title: g.title, description: g.description, order: g.order, enabled: g.enabled,
    method_title: g.methodTitle || g.title, method_description: g.methodDescription, method_supports: ['products'], settings,
    needs_setup: false, post_install_scripts: [], settings_url: '', connection_url: null, setup_help_text: null, required_settings_keys: [],
    _links: { self: [{ href: `${API}/payment_gateways/${g.id}` }], collection: [{ href: `${API}/payment_gateways` }] },
  };
};
router.get('/payment_gateways', admin, ah(async (req, res) => {
  res.json((await prisma.paymentGateway.findMany({ orderBy: [{ order: 'asc' }, { id: 'asc' }] })).map(gatewayOut));
}));
router.get('/payment_gateways/:id', admin, ah(async (req, res) => {
  const g = await prisma.paymentGateway.findUnique({ where: { id: req.params.id } });
  if (!g) throw new ApiError(404, 'woocommerce_rest_payment_gateway_invalid', 'Resource does not exist.');
  res.json(gatewayOut(g));
}));
const updGateway = ah(async (req, res) => {
  const g = await prisma.paymentGateway.findUnique({ where: { id: req.params.id } });
  if (!g) throw new ApiError(404, 'woocommerce_rest_payment_gateway_invalid', 'Resource does not exist.');
  const b = req.body || {};
  const d = {};
  if (has(b, 'title')) d.title = String(b.title);
  if (has(b, 'description')) d.description = String(b.description);
  if (has(b, 'order')) d.order = parseInt(b.order, 10) || 0;
  if (has(b, 'enabled')) d.enabled = bool(b.enabled);
  if (has(b, 'settings')) {
    const merged = { ...(g.settings || {}) };
    for (const [k, v] of Object.entries(b.settings || {})) {
      if (k === 'title') d.title = String(v); else if (k === 'description') d.description = String(v); else merged[k] = v;
    }
    d.settings = merged;
  }
  res.json(gatewayOut(await prisma.paymentGateway.update({ where: { id: g.id }, data: d })));
});
router.put('/payment_gateways/:id', admin, updGateway);
router.patch('/payment_gateways/:id', admin, updGateway);

// ───────────── Settings ─────────────
async function settingOut(def) {
  let value = await options.getOption(def.id);
  if (value === undefined || value === null) value = def.default;
  const out = { id: def.id, label: def.label, description: def.description, type: def.type, default: def.default, tip: def.tip, value, group_id: def.group_id };
  if (def.options) out.options = def.options;
  out._links = { self: [{ href: `${API}/settings/${def.group_id}/${def.id}` }], collection: [{ href: `${API}/settings/${def.group_id}` }] };
  return out;
}
function findSetting(group, id) {
  const def = registry.byId.get(id);
  if (!def || def.group_id !== group) throw new ApiError(404, 'rest_setting_setting_invalid', 'Invalid setting.');
  return def;
}
async function updateSetting(def, value) {
  if (def.type === 'checkbox' && typeof value === 'boolean') value = value ? 'yes' : 'no';
  if (def.options && !['multiselect', 'checkbox'].includes(def.type) && !has(def.options, value) && !(def.type === 'select' && !Object.keys(def.options).length)) {
    throw badRequest('rest_setting_value_invalid', 'An invalid setting value was passed.');
  }
  await options.setOption(def.id, value);
  return settingOut(def);
}
router.get('/settings', admin, (req, res) => {
  res.json(registry.groups.map((g) => ({ ...g, _links: { options: [{ href: `${API}/settings/${g.id}` }] } })));
});
router.get('/settings/:group', admin, ah(async (req, res) => {
  if (!registry.groups.some((g) => g.id === req.params.group)) throw new ApiError(404, 'rest_setting_setting_group_invalid', 'Invalid setting group.');
  res.json(await Promise.all(registry.settings.filter((x) => x.group_id === req.params.group).map(settingOut)));
}));
router.post('/settings/:group/batch', admin, ah(async (req, res) => {
  const out = [];
  for (const item of (req.body && req.body.update) || []) {
    try { out.push(await updateSetting(findSetting(req.params.group, item.id), item.value)); } catch (e) { out.push({ id: item.id, error: { code: e.code, message: e.message, data: { status: e.status || 500 } } }); }
  }
  res.json({ update: out });
}));
router.get('/settings/:group/:id', admin, ah(async (req, res) => res.json(await settingOut(findSetting(req.params.group, req.params.id)))));
const updSetting = ah(async (req, res) => res.json(await updateSetting(findSetting(req.params.group, req.params.id), (req.body || {}).value)));
router.put('/settings/:group/:id', admin, updSetting);
router.patch('/settings/:group/:id', admin, updSetting);

// ───────────── Data ─────────────
const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');
let regionNames;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { regionNames = null; }
let currencyNames;
try { currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' }); } catch { currencyNames = null; }

router.get('/data/countries', (req, res) => {
  res.json(COUNTRY_CODES.map((code) => ({ code, name: regionNames ? regionNames.of(code) : code, states: [], _links: { self: [{ href: `${API}/data/countries/${code.toLowerCase()}` }] } })));
});
router.get('/data/countries/:code', (req, res, next) => {
  const code = req.params.code.toUpperCase();
  if (!COUNTRY_CODES.includes(code)) return next(new ApiError(404, 'woocommerce_rest_data_invalid_location', 'There are no locations matching these parameters.'));
  res.json({ code, name: regionNames ? regionNames.of(code) : code, states: [] });
});
router.get('/data/currencies', (req, res) => {
  res.json(Object.keys(SYMBOLS).map((code) => ({ code, name: currencyNames ? currencyNames.of(code) : code, symbol: symbol(code) })));
});
router.get('/data/currencies/current', ah(async (req, res) => {
  const s = await options.store();
  res.json({ code: s.currency, name: currencyNames ? currencyNames.of(s.currency) : s.currency, symbol: symbol(s.currency) });
}));
router.get('/data/continents', (req, res) => {
  const names = { AF: 'Africa', AN: 'Antarctica', AS: 'Asia', EU: 'Europe', NA: 'North America', OC: 'Oceania', SA: 'South America' };
  res.json(Object.entries(shipping.CONTINENTS).map(([code, countries]) => ({ code, name: names[code], countries: countries.map((c) => ({ code: c, name: regionNames ? regionNames.of(c) : c, states: [] })) })));
});

// ───────────── Reports (basic) ─────────────
router.get('/reports', can('view_woocommerce_reports'), (req, res) => {
  res.json(['sales', 'top_sellers', 'orders/totals', 'products/totals', 'customers/totals', 'coupons/totals', 'reviews/totals']
    .map((slug) => ({ slug, description: slug, _links: { self: [{ href: `${API}/reports/${slug}` }] } })));
});
router.get('/reports/orders/totals', can('view_woocommerce_reports'), ah(async (req, res) => {
  const rows = await prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
  const { STATUS_LABELS } = require('../../services/order');
  res.json(Object.entries(STATUS_LABELS).map(([slug, name]) => ({ slug, name, total: (rows.find((r) => r.status === slug) || { _count: { _all: 0 } })._count._all })));
}));
router.get('/reports/products/totals', can('view_woocommerce_reports'), ah(async (req, res) => {
  const rows = await prisma.product.groupBy({ by: ['type'], where: { type: { not: 'variation' }, status: { not: 'trash' } }, _count: { _all: true } });
  res.json(['external', 'grouped', 'simple', 'variable'].map((slug) => ({ slug, name: `${slug[0].toUpperCase()}${slug.slice(1)} product`, total: (rows.find((r) => r.type === slug) || { _count: { _all: 0 } })._count._all })));
}));
router.get('/reports/customers/totals', can('view_woocommerce_reports'), ah(async (req, res) => {
  const [paying, nonPaying] = await Promise.all([prisma.user.count({ where: { role: 'customer', isPayingCustomer: true } }), prisma.user.count({ where: { role: 'customer', isPayingCustomer: false } })]);
  res.json([{ slug: 'paying', name: 'Paying customer', total: paying }, { slug: 'non_paying', name: 'Non-paying customer', total: nonPaying }]);
}));
router.get('/reports/coupons/totals', can('view_woocommerce_reports'), ah(async (req, res) => {
  const rows = await prisma.coupon.groupBy({ by: ['discountType'], where: { status: { not: 'trash' } }, _count: { _all: true } });
  const names = { percent: 'Percentage discount', fixed_cart: 'Fixed cart discount', fixed_product: 'Fixed product discount' };
  res.json(Object.entries(names).map(([slug, name]) => ({ slug, name, total: (rows.find((r) => r.discountType === slug) || { _count: { _all: 0 } })._count._all })));
}));
router.get('/reports/sales', can('view_woocommerce_reports'), ah(async (req, res) => {
  const s = await options.store();
  const q = req.query;
  const now = new Date();
  let from = q.date_min ? new Date(`${q.date_min}T00:00:00Z`) : null;
  const to = q.date_max ? new Date(`${q.date_max}T23:59:59Z`) : now;
  if (!from) {
    const days = { week: 7, month: 30, last_month: 60, year: 365 }[q.period] || 7;
    from = new Date(now.getTime() - days * 86400000);
  }
  const where = { status: { in: ['processing', 'completed', 'on-hold'] }, createdAt: { gte: from, lte: to } };
  const [agg, items, refunds] = await Promise.all([
    prisma.order.aggregate({ where, _sum: { total: true, totalTax: true, shippingTotal: true, shippingTax: true, discountTotal: true }, _count: { _all: true } }),
    prisma.orderItem.aggregate({ where: { type: 'line_item', order: where }, _sum: { quantity: true, total: true } }),
    prisma.orderRefund.aggregate({ where: { createdAt: { gte: from, lte: to } }, _sum: { amount: true } }),
  ]);
  const days = Math.max(1, Math.ceil((to - from) / 86400000));
  res.json([{
    total_sales: money(agg._sum.total, s.dp),
    net_sales: money(Number(agg._sum.total || 0) - Number(agg._sum.totalTax || 0) - Number(agg._sum.shippingTotal || 0), s.dp),
    average_sales: money(Number(agg._sum.total || 0) / days, s.dp),
    total_orders: agg._count._all,
    total_items: items._sum.quantity || 0,
    total_tax: money(agg._sum.totalTax, s.dp),
    total_shipping: money(agg._sum.shippingTotal, s.dp),
    total_refunds: Number(refunds._sum.amount || 0),
    total_discount: money(agg._sum.discountTotal, s.dp),
    totals_grouped_by: 'day',
    totals: {},
    total_customers: 0,
  }]);
}));
router.get('/reports/top_sellers', can('view_woocommerce_reports'), ah(async (req, res) => {
  const rows = await prisma.orderItem.groupBy({
    by: ['productId', 'name'], where: { type: 'line_item', productId: { not: null }, order: { status: { in: ['processing', 'completed', 'on-hold'] } } },
    _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: 10,
  });
  res.json(rows.map((r) => ({ name: r.name, product_id: r.productId, quantity: r._sum.quantity })));
}));

module.exports = router;
