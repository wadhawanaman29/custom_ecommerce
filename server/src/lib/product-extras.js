// Structured access to plugin data stored in meta, using the SAME meta keys as the WordPress plugins
// (so imported data shows up unchanged and the storefront can read it):
//   seo       — Yoast SEO (_yoast_wpseo_*)
//   addons    — WooCommerce Product Add-ons (_product_addons, _product_addons_exclude_global)
//   facebook  — Meta for WooCommerce (_wc_facebook_sync_enabled, fb_*)
//   acf       — ACF fields ("acf:<name>")

const SEO_KEYS = {
  focus_keyphrase: '_yoast_wpseo_focuskw',
  title: '_yoast_wpseo_title',
  description: '_yoast_wpseo_metadesc',
  cornerstone: '_yoast_wpseo_is_cornerstone',
  noindex: '_yoast_wpseo_meta-robots-noindex', // '1' = noindex, '2' = index, '' = default
  nofollow: '_yoast_wpseo_meta-robots-nofollow', // '1' = nofollow
  canonical: '_yoast_wpseo_canonical',
  breadcrumb_title: '_yoast_wpseo_bctitle',
  og_title: '_yoast_wpseo_opengraph-title',
  og_description: '_yoast_wpseo_opengraph-description',
  og_image: '_yoast_wpseo_opengraph-image',
  twitter_title: '_yoast_wpseo_twitter-title',
  twitter_description: '_yoast_wpseo_twitter-description',
  twitter_image: '_yoast_wpseo_twitter-image',
};
const PRIMARY_KEYS = { product: '_yoast_wpseo_primary_product_cat', post: '_yoast_wpseo_primary_category' };

const FB_KEYS = {
  sync: '_wc_facebook_sync_enabled', // 'yes' | 'no'
  visibility: 'fb_visibility', // 'yes' (show) | 'no' (hide)
  description: 'fb_product_description',
  image: 'fb_product_image',
  price: 'fb_product_price',
  google_product_category: '_wc_facebook_google_product_category',
};

const ADDON_KEYS = { addons: '_product_addons', exclude_global: '_product_addons_exclude_global' };

// Meta keys that are exposed through structured fields (hidden from meta_data)
const STRUCTURED = new Set([...Object.values(SEO_KEYS), ...Object.values(PRIMARY_KEYS), ...Object.values(FB_KEYS), ...Object.values(ADDON_KEYS), '_storewide_sale']);
const isStructured = (key) => !!key && (STRUCTURED.has(key) || key.startsWith('acf:') || key.startsWith('_yoast_wpseo_'));

const list = (meta) => (Array.isArray(meta) ? meta : []);
const get = (meta, key) => { const m = list(meta).find((x) => x.key === key); return m ? m.value : undefined; };

function setMany(meta, pairs) {
  const out = list(meta).filter((m) => !Object.prototype.hasOwnProperty.call(pairs, m.key));
  let id = out.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
  for (const [key, value] of Object.entries(pairs)) {
    if (value === null || value === undefined || value === '') continue; // empty = remove (Yoast/WC behaviour)
    out.push({ id: ++id, key, value });
  }
  return out;
}

function seoOut(meta, kind = 'product') {
  const o = {};
  for (const [field, key] of Object.entries(SEO_KEYS)) o[field] = get(meta, key) ?? '';
  o.cornerstone = o.cornerstone === '1' || o.cornerstone === true;
  o.primary_category = parseInt(get(meta, PRIMARY_KEYS[kind]), 10) || 0;
  return o;
}
function seoMerge(meta, seo, kind = 'product') {
  if (!seo || typeof seo !== 'object') return meta;
  const pairs = {};
  for (const [field, key] of Object.entries(SEO_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(seo, field)) continue;
    let v = seo[field];
    if (field === 'cornerstone') v = v === true || v === '1' || v === 'yes' ? '1' : null;
    pairs[key] = v === undefined ? null : v;
  }
  if (Object.prototype.hasOwnProperty.call(seo, 'primary_category')) pairs[PRIMARY_KEYS[kind]] = seo.primary_category ? String(seo.primary_category) : null;
  return setMany(meta, pairs);
}

function facebookOut(meta) {
  const o = {};
  for (const [field, key] of Object.entries(FB_KEYS)) o[field] = get(meta, key) ?? '';
  o.sync = o.sync !== 'no'; // Meta for WooCommerce syncs unless explicitly disabled
  o.visibility = o.visibility !== 'no';
  return o;
}
function facebookMerge(meta, fb) {
  if (!fb || typeof fb !== 'object') return meta;
  const pairs = {};
  for (const [field, key] of Object.entries(FB_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(fb, field)) continue;
    let v = fb[field];
    if (field === 'sync' || field === 'visibility') v = v === false || v === 'no' ? 'no' : 'yes';
    pairs[key] = v;
  }
  return setMany(meta, pairs);
}

// WooCommerce Product Add-ons format: [{ name, title_format, description_enable, description, type, display,
// position, required, restrictions, min, max, adjust_price, price_type, price, options: [{ label, price, image, price_type }] }]
function addonsOut(meta) {
  const raw = get(meta, ADDON_KEYS.addons);
  const addons = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return {
    addons: addons.map((a, i) => ({
      name: a.name || '', title_format: a.title_format || 'label', description_enable: !!Number(a.description_enable || 0), description: a.description || '',
      type: a.type || 'multiple_choice', display: a.display || 'select', position: Number(a.position ?? i), required: !!Number(a.required || 0),
      restrictions: !!Number(a.restrictions || 0), min: a.min ?? '', max: a.max ?? '', adjust_price: !!Number(a.adjust_price || 0),
      price_type: a.price_type || 'flat_fee', price: a.price ?? '',
      options: (Array.isArray(a.options) ? a.options : Object.values(a.options || {})).map((o) => ({ label: o.label || '', price: o.price ?? '', image: o.image || '', price_type: o.price_type || 'flat_fee' })),
    })),
    exclude_global: get(meta, ADDON_KEYS.exclude_global) === '1' || get(meta, ADDON_KEYS.exclude_global) === 1,
  };
}
function addonsMerge(meta, body) {
  const pairs = {};
  if (Array.isArray(body.addons)) {
    pairs[ADDON_KEYS.addons] = body.addons.map((a, i) => ({
      name: String(a.name || ''), title_format: a.title_format || 'label', description_enable: a.description_enable ? 1 : 0, description: String(a.description || ''),
      type: a.type || 'multiple_choice', display: a.display || 'select', position: i, required: a.required ? 1 : 0, restrictions: a.restrictions ? 1 : 0,
      restrictions_type: 'any_text', min: a.min === '' || a.min === undefined ? '' : Number(a.min), max: a.max === '' || a.max === undefined ? '' : Number(a.max),
      adjust_price: a.adjust_price ? 1 : 0, price_type: a.price_type || 'flat_fee', price: a.price === '' || a.price === undefined ? '' : String(a.price),
      options: (a.options || []).map((o) => ({ label: String(o.label || ''), price: o.price === '' || o.price === undefined ? '' : String(o.price), image: o.image || '', price_type: o.price_type || 'flat_fee' })),
    }));
    if (!pairs[ADDON_KEYS.addons].length) pairs[ADDON_KEYS.addons] = null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'exclude_global_addons')) pairs[ADDON_KEYS.exclude_global] = body.exclude_global_addons ? '1' : null;
  return Object.keys(pairs).length ? setMany(meta, pairs) : meta;
}

function acfOut(meta) {
  return Object.fromEntries(list(meta).filter((m) => m.key && m.key.startsWith('acf:')).map((m) => [m.key.slice(4), m.value]));
}
function acfMerge(meta, acf) {
  if (!acf || typeof acf !== 'object') return meta;
  const out = list(meta).filter((m) => !(m.key && m.key.startsWith('acf:') && Object.prototype.hasOwnProperty.call(acf, m.key.slice(4))));
  let id = out.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
  for (const [k, v] of Object.entries(acf)) if (v !== null && v !== undefined) out.push({ id: ++id, key: `acf:${k}`, value: v });
  return out;
}

// Underscore meta from WordPress that must survive import (plugin data with no own column)
const KEEP_PREFIXES = ['_yoast_wpseo_', '_wc_facebook_', '_product_addons', '_old_price', '_old_sale_price'];
const keepOnImport = (key) => KEEP_PREFIXES.some((p) => key.startsWith(p)) || key.startsWith('fb_');

module.exports = {
  SEO_KEYS, FB_KEYS, ADDON_KEYS, isStructured, seoOut, seoMerge, facebookOut, facebookMerge, addonsOut, addonsMerge, acfOut, acfMerge, keepOnImport, get,
};
