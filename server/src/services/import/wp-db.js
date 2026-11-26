/* eslint-disable no-await-in-loop */
// Imports a WordPress + WooCommerce DATABASE into the new schema, preserving all IDs.
// Used by the dashboard (Tools → Import) and the CLI (scripts/migrate-woocommerce.js).
// Re-runnable: existing rows (same ID) are skipped. reset=true wipes the new DB tables first.
const mysql = require('mysql2/promise');
const { unserialize } = require('php-serialize');
const prisma = require('../../db');
const options = require('../../lib/options');
const registry = require('../../lib/settings-registry');

// Per-run configuration (only one import runs at a time — enforced by the job runner)
let P = 'wp_';
const T = (name) => `\`${P}${name}\``;
let ONLY = null;
const should = (phase) => !ONLY || ONLY.includes(phase);
let REMOTE_MEDIA = false;
let UPLOADS_URL = '';
const CHUNK = 500;

let db;
let logger = console.log;

// ───────── helpers ─────────
const log = (...a) => logger(a.join(' '));

function php(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^[aOsibdN][:;]/.test(v)) return v;
  try { return unserialize(v, {}, { strict: false }); } catch { return null; }
}
const toArr = (v) => {
  const x = php(v);
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object') return Object.values(x);
  return [x];
};
const csvIds = (v) => String(v || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
const gmt = (s) => {
  if (!s || String(s).startsWith('0000')) return null;
  const d = new Date(`${String(s).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const ts = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (/^\d+$/.test(String(v))) return new Date(parseInt(v, 10) * 1000);
  return gmt(v);
};
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const yes = (v) => v === 'yes' || v === '1' || v === 1 || v === true;
const chunks = (arr, n = CHUNK) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

async function q(sql, params = []) {
  const [rows] = await db.query(sql, params);
  return rows;
}
async function tableExists(name) {
  const rows = await q('SHOW TABLES LIKE ?', [`${P}${name}`]);
  return rows.length > 0;
}

// Map<objectId, Map<meta_key, value>> (last value wins; use metaAll for multi-value keys)
async function metaFor(table, idCol, ids, { all = false } = {}) {
  const out = new Map();
  for (const part of chunks(ids, 1000)) {
    if (!part.length) continue;
    const rows = await q(`SELECT ${idCol} AS id, meta_key AS k, meta_value AS v FROM ${T(table)} WHERE ${idCol} IN (?)`, [part]);
    for (const r of rows) {
      if (!out.has(r.id)) out.set(r.id, new Map());
      const m = out.get(r.id);
      if (all) { if (!m.has(r.k)) m.set(r.k, []); m.get(r.k).push(r.v); } else m.set(r.k, r.v);
    }
  }
  return out;
}

async function insertMany(model, rows) {
  let n = 0;
  for (const part of chunks(rows)) {
    const r = await prisma[model].createMany({ data: part, skipDuplicates: true });
    n += r.count;
  }
  return n;
}

// Implicit many-to-many tables: figure out which column (A/B) points at which model
async function m2m(table, leftModel) {
  // Case-insensitive: MySQL/MariaDB on Windows lowercases table names (lower_case_table_names=1)
  const rows = await prisma.$queryRawUnsafe(
    'SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS ref FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?) AND REFERENCED_TABLE_NAME IS NOT NULL', table,
  );
  const left = rows.find((r) => r.ref.toLowerCase() === leftModel.toLowerCase());
  if (!left) throw new Error(`Relation table ${table} not found — run "npx prisma db push" first`);
  const right = rows.find((r) => r.col !== left.col);
  return { tbl: left.tbl, leftCol: left.col, rightCol: right.col };
}
async function linkMany(table, leftModel, pairs) {
  if (!pairs.length) return 0;
  const { tbl, leftCol, rightCol } = await m2m(table, leftModel);
  table = tbl; // eslint-disable-line no-param-reassign
  let n = 0;
  for (const part of chunks(pairs, 1000)) {
    const values = part.map(() => '(?, ?)').join(',');
    n += await prisma.$executeRawUnsafe(`INSERT IGNORE INTO \`${table}\` (\`${leftCol}\`, \`${rightCol}\`) VALUES ${values}`, ...part.flat());
  }
  return n;
}

// Visible meta: keys not starting with "_" (ACF values exposed as "acf:<name>" when their "_<name>" points to a field key)
function publicMeta(meta, knownKeys = []) {
  const out = [];
  if (!meta) return out;
  let id = 1;
  for (const [k, raw] of meta) {
    if (k.startsWith('_') || knownKeys.includes(k)) continue;
    const v = php(raw);
    const ref = meta.get(`_${k}`);
    const key = ref && String(ref).startsWith('field_') ? `acf:${k}` : k;
    out.push({ id: id++, key, value: v === null ? raw : v });
  }
  return out;
}

const STATUS_MAP = (s) => String(s || '').replace(/^wc-/, '');

// ───────── phases ─────────
async function migrateOptions() {
  log('Options…');
  const names = [...registry.settings.map((s) => s.id), 'woocommerce_gateway_order', 'stylesheet', 'sticky_posts'];
  const rows = await q(`SELECT option_name AS n, option_value AS v FROM ${T('options')} WHERE option_name IN (?)`, [names]);
  for (const r of rows) {
    if (!registry.byId.has(r.n)) continue;
    let v = php(r.v);
    if (v && typeof v === 'object' && !Array.isArray(v)) v = Object.values(v);
    await options.setOption(r.n, v ?? r.v);
  }
  log(`  ${rows.length} options`);

  // Payment gateways (woocommerce_<id>_settings)
  const order = php((rows.find((r) => r.n === 'woocommerce_gateway_order') || {}).v) || {};
  const gw = await q(`SELECT option_name AS n, option_value AS v FROM ${T('options')} WHERE option_name LIKE 'woocommerce\\_%\\_settings'`);
  const skip = /^woocommerce_(flat_rate|free_shipping|local_pickup|.*_\d+)_settings$/;
  let g = 0;
  for (const r of gw) {
    if (skip.test(r.n)) continue;
    const id = r.n.replace(/^woocommerce_/, '').replace(/_settings$/, '');
    const s = php(r.v);
    if (!s || typeof s !== 'object' || !('enabled' in s) || !('title' in s)) continue;
    const { enabled, title, description, ...rest } = s;
    await prisma.paymentGateway.upsert({
      where: { id },
      create: { id, title: String(title || id), description: String(description || ''), enabled: yes(enabled), order: parseInt(order[id], 10) || 0, methodTitle: String(title || id), settings: rest },
      update: { title: String(title || id), description: String(description || ''), enabled: yes(enabled), order: parseInt(order[id], 10) || 0, settings: rest },
    });
    g++;
  }
  log(`  ${g} payment gateways`);
}

async function migrateUsers() {
  log('Users…');
  const users = await q(`SELECT ID, user_login, user_pass, user_nicename, user_email, user_url, user_registered, display_name FROM ${T('users')}`);
  const meta = await metaFor('usermeta', 'user_id', users.map((u) => u.ID));
  const capKey = `${P}capabilities`;
  const ROLE_ORDER = ['administrator', 'shop_manager', 'editor', 'author', 'contributor', 'customer', 'subscriber'];
  const B = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'postcode', 'country', 'state', 'email', 'phone'];
  const rows = users.map((u) => {
    const m = meta.get(u.ID) || new Map();
    const caps = php(m.get(capKey)) || {};
    const roles = Object.keys(caps).filter((k) => caps[k]);
    const role = ROLE_ORDER.find((r) => roles.includes(r)) || roles[0] || 'subscriber';
    const addr = (type) => Object.fromEntries(B.filter((f) => type === 'billing' || f !== 'email').map((f) => [f, m.get(`${type}_${f}`) || '']));
    const known = ['first_name', 'last_name', 'description', 'nickname', capKey, `${P}user_level`, 'paying_customer', 'rich_editing', 'syntax_highlighting', 'comment_shortcuts', 'admin_color', 'use_ssl', 'show_admin_bar_front', 'locale', 'dismissed_wp_pointers', 'session_tokens', 'last_update', 'wc_last_active']
      .concat(B.map((f) => `billing_${f}`), B.map((f) => `shipping_${f}`));
    return {
      id: u.ID,
      login: u.user_login,
      email: (u.user_email || `user${u.ID}@invalid.local`).toLowerCase(),
      passwordHash: u.user_pass,
      displayName: u.display_name || u.user_login,
      firstName: m.get('first_name') || '',
      lastName: m.get('last_name') || '',
      nicename: u.user_nicename || '',
      url: u.user_url || '',
      description: m.get('description') || '',
      role,
      billing: addr('billing'),
      shipping: addr('shipping'),
      isPayingCustomer: m.get('paying_customer') === '1',
      meta: publicMeta(m, known).filter((x) => !x.key.startsWith(P)),
      createdAt: gmt(u.user_registered) || new Date(),
      updatedAt: gmt(u.user_registered) || new Date(),
    };
  });
  // Duplicate emails would violate the unique index — suffix them
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.email)) r.email = `${r.email.replace('@', `+dup${r.id}@`)}`;
    seen.add(r.email);
  }
  log(`  ${await insertMany('user', rows)} users`);

  if (await tableExists('woocommerce_api_keys')) {
    const keys = await q(`SELECT * FROM ${T('woocommerce_api_keys')}`);
    const valid = keys.filter((k) => rows.some((u) => u.id === k.user_id));
    const n = await insertMany('apiKey', valid.map((k) => ({
      id: k.key_id, userId: k.user_id, description: k.description || '', permissions: k.permissions,
      consumerKey: k.consumer_key, consumerSecret: k.consumer_secret, truncatedKey: k.truncated_key || '', lastAccess: gmt(k.last_access),
    })));
    log(`  ${n} REST API keys (existing ck_/cs_ keys keep working)`);
  }
}

async function migrateMedia() {
  log('Media…');
  const posts = await q(`SELECT ID, post_title, post_name, post_excerpt, post_content, post_mime_type, post_author, post_date_gmt, post_modified_gmt, guid FROM ${T('posts')} WHERE post_type = 'attachment'`);
  const meta = await metaFor('postmeta', 'post_id', posts.map((p) => p.ID));
  const userIds = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
  const rows = posts.map((p) => {
    const m = meta.get(p.ID) || new Map();
    const file = m.get('_wp_attached_file') || String(p.guid).replace(/^.*\/wp-content\/uploads\//, '');
    const md = php(m.get('_wp_attachment_metadata')) || {};
    const isRemote = /^https?:/i.test(file);
    let path = file;
    if (!isRemote && REMOTE_MEDIA && UPLOADS_URL) path = `${UPLOADS_URL}/${file}`;
    return {
      id: p.ID,
      title: p.post_title || '',
      slug: p.post_name || '',
      fileName: String(file).split('/').pop(),
      path,
      mimeType: p.post_mime_type || 'application/octet-stream',
      fileSize: parseInt(md.filesize, 10) || 0,
      width: parseInt(md.width, 10) || null,
      height: parseInt(md.height, 10) || null,
      altText: m.get('_wp_attachment_image_alt') || '',
      caption: p.post_excerpt || '',
      description: p.post_content || '',
      sizes: md.sizes && typeof md.sizes === 'object' ? md.sizes : null,
      authorId: userIds.has(p.post_author) ? p.post_author : null,
      createdAt: gmt(p.post_date_gmt) || new Date(),
      updatedAt: gmt(p.post_modified_gmt) || new Date(),
    };
  });
  log(`  ${await insertMany('media', rows)} media items${REMOTE_MEDIA ? ' (remote URLs)' : ' — copy wp-content/uploads/* into server/uploads/'}`);
}

async function termsOf(taxonomy) {
  return q(`SELECT t.term_id AS id, t.name, t.slug, tt.description, tt.parent, tt.term_taxonomy_id AS ttid FROM ${T('terms')} t JOIN ${T('term_taxonomy')} tt ON tt.term_id = t.term_id WHERE tt.taxonomy = ?`, [taxonomy]);
}
async function relationships(ttids) {
  if (!ttids.length) return [];
  return q(`SELECT object_id AS obj, term_taxonomy_id AS ttid FROM ${T('term_relationships')} WHERE term_taxonomy_id IN (?)`, [ttids]);
}

// ── ACF / CPT UI definitions (loaded once per run, merged into the content-type registry) ──
let acfDefs = null;
async function loadAcfDefinitions() {
  if (acfDefs) return acfDefs;
  const acf = require('./acf');
  const ct = require('../../lib/content-types');
  const [defs, groups] = await Promise.all([acf.postTypesFromDb(q, T), acf.fieldGroupsFromDb(q, T)]);
  const reg = await ct.getRegistry();
  if (defs.types.length || defs.taxonomies.length || groups.length) {
    const defaultKeys = new Set(ct.DEFAULTS.field_groups.map((g) => g.key));
    const merge = (list, add, id) => { const m = new Map(list.map((x) => [x[id], x])); for (const a of add) m.set(a[id], { ...(m.get(a[id]) || {}), ...a }); return [...m.values()]; };
    // Real ACF groups from WordPress replace the built-in defaults
    const baseGroups = groups.length ? reg.field_groups.filter((g) => !defaultKeys.has(g.key)) : reg.field_groups;
    try {
      await ct.saveRegistry({
        types: merge(reg.types, defs.types.filter((t) => !ct.BUILTIN_TYPES.includes(t.name)), 'name'),
        taxonomies: merge(reg.taxonomies, defs.taxonomies, 'name'),
        field_groups: merge(baseGroups, groups, 'key'),
      });
      log(`  content types: ${defs.types.length} post types, ${defs.taxonomies.length} taxonomies, ${groups.length} ACF field groups`);
    } catch (e) {
      log(`  ! could not save content types: ${e.message}`);
    }
  }
  const saved = await ct.getRegistry();
  acfDefs = { registry: saved, fields: acf.topLevelFields(saved.field_groups), acf };
  return acfDefs;
}

// Visible meta + nested ACF values ("acf:<name>") for posts and terms
async function contentMeta(m) {
  const { fields, acf } = await loadAcfDefinitions();
  if (!m || !m.size) return [];
  if (!fields.length) return publicMeta(m);
  const { values, managedKeys } = acf.acfValues(m, fields);
  const base = publicMeta(m).filter((x) => !managedKeys.has(x.key.replace(/^acf:/, '')));
  let id = base.reduce((n, x) => Math.max(n, x.id || 0), 0);
  return [...base, ...Object.entries(values).map(([key, value]) => ({ id: ++id, key: `acf:${key}`, value }))];
}

async function migrateCatalogTerms() {
  log('Product categories, tags, shipping classes, attributes…');
  const mediaIds = new Set((await prisma.media.findMany({ select: { id: true } })).map((m) => m.id));
  const cats = await termsOf('product_cat');
  const tmeta = await metaFor('termmeta', 'term_id', cats.map((c) => c.id));
  const catRows = [];
  for (const c of cats) {
    const m = tmeta.get(c.id) || new Map();
    const img = parseInt(m.get('thumbnail_id'), 10);
    const known = new Set(['thumbnail_id', 'display_type', 'order', 'product_count_product_cat']);
    catRows.push({
      id: c.id, name: c.name, slug: c.slug, description: c.description || '', display: m.get('display_type') || 'default',
      imageId: mediaIds.has(img) ? img : null, menuOrder: parseInt(m.get('order'), 10) || 0,
      meta: (await contentMeta(new Map([...m].filter(([k]) => !known.has(k))))),
    });
  }
  await insertMany('productCategory', catRows);
  for (const c of cats.filter((x) => x.parent)) {
    await prisma.productCategory.updateMany({ where: { id: c.id }, data: { parentId: c.parent } });
  }
  log(`  ${cats.length} categories`);

  const tags = await termsOf('product_tag');
  await insertMany('productTag', tags.map((t) => ({ id: t.id, name: t.name, slug: t.slug, description: t.description || '' })));
  log(`  ${tags.length} tags`);

  const classes = await termsOf('product_shipping_class');
  await insertMany('shippingClass', classes.map((t) => ({ id: t.id, name: t.name, slug: t.slug, description: t.description || '' })));
  log(`  ${classes.length} shipping classes`);

  const attrs = await q(`SELECT * FROM ${T('woocommerce_attribute_taxonomies')}`);
  await insertMany('attribute', attrs.map((a) => ({
    id: a.attribute_id, name: a.attribute_label || a.attribute_name, slug: a.attribute_name, type: a.attribute_type || 'select',
    orderBy: a.attribute_orderby || 'menu_order', hasArchives: a.attribute_public === 1,
  })));
  for (const a of attrs) {
    const terms = await termsOf(`pa_${a.attribute_name}`);
    const tm = await metaFor('termmeta', 'term_id', terms.map((t) => t.id));
    await insertMany('attributeTerm', terms.map((t) => ({
      id: t.id, attributeId: a.attribute_id, name: t.name, slug: t.slug, description: t.description || '',
      menuOrder: parseInt((tm.get(t.id) || new Map()).get('order') ?? (tm.get(t.id) || new Map()).get(`order_pa_${a.attribute_name}`), 10) || 0,
    })));
  }
  log(`  ${attrs.length} global attributes`);
}

async function migrateProducts() {
  log('Products…');
  const posts = await q(`SELECT ID, post_title, post_name, post_content, post_excerpt, post_status, post_parent, menu_order, comment_status, post_type, post_date_gmt, post_modified_gmt FROM ${T('posts')} WHERE post_type IN ('product','product_variation') AND post_status NOT IN ('auto-draft','inherit') ORDER BY post_type = 'product_variation', ID`);
  const ids = posts.map((p) => p.ID);
  const meta = await metaFor('postmeta', 'post_id', ids);

  // product_type, product_visibility, shipping class, cats, tags, attribute terms
  const typeTerms = await termsOf('product_type');
  const visTerms = await termsOf('product_visibility');
  const cats = await termsOf('product_cat');
  const tags = await termsOf('product_tag');
  const classes = await termsOf('product_shipping_class');
  const attrs = await q(`SELECT attribute_id, attribute_name, attribute_label FROM ${T('woocommerce_attribute_taxonomies')}`);
  const attrTerms = new Map(); // taxonomy -> terms
  for (const a of attrs) attrTerms.set(`pa_${a.attribute_name}`, await termsOf(`pa_${a.attribute_name}`));
  const allTerms = [...typeTerms, ...visTerms, ...cats, ...tags, ...classes, ...[...attrTerms.values()].flat()];
  const ttidToTerm = new Map(allTerms.map((t) => [t.ttid, t]));
  const rels = await relationships(allTerms.map((t) => t.ttid));
  const termsByObj = new Map();
  for (const r of rels) {
    if (!termsByObj.has(r.obj)) termsByObj.set(r.obj, []);
    termsByObj.get(r.obj).push(ttidToTerm.get(r.ttid));
  }
  const typeSet = new Set(typeTerms.map((t) => t.ttid));
  const visBy = new Map(visTerms.map((t) => [t.slug, t.ttid]));
  const catIds = new Set(cats.map((c) => c.id));
  const tagIds = new Set(tags.map((t) => t.id));
  const classIds = new Set(classes.map((c) => c.id));
  const mediaIds = new Set((await prisma.media.findMany({ select: { id: true } })).map((m) => m.id));
  const termSlugToName = new Map(); // `${taxonomy}|${slug}` -> name
  for (const [tax, list] of attrTerms) for (const t of list) termSlugToName.set(`${tax}|${t.slug}`, t.name);
  const attrByTax = new Map(attrs.map((a) => [`pa_${a.attribute_name}`, a]));

  const KNOWN = ['total_sales'];
  const products = [];
  const images = [];
  const productAttrs = [];
  const catPairs = [];
  const tagPairs = [];
  const productIdSet = new Set(posts.filter((p) => p.post_type === 'product').map((p) => p.ID));

  for (const p of posts) {
    const m = meta.get(p.ID) || new Map();
    const objTerms = (termsByObj.get(p.ID) || []).filter(Boolean);
    const isVar = p.post_type === 'product_variation';
    if (isVar && !productIdSet.has(p.post_parent)) continue; // orphan variation
    const typeTerm = objTerms.find((t) => typeSet.has(t.ttid));
    const vis = new Set(objTerms.filter((t) => [...visBy.values()].includes(t.ttid)).map((t) => t.slug));
    let catalogVisibility = 'visible';
    if (vis.has('exclude-from-catalog') && vis.has('exclude-from-search')) catalogVisibility = 'hidden';
    else if (vis.has('exclude-from-catalog')) catalogVisibility = 'search';
    else if (vis.has('exclude-from-search')) catalogVisibility = 'catalog';
    const cls = objTerms.find((t) => classIds.has(t.id) && classes.some((c) => c.ttid === t.ttid));
    const files = php(m.get('_downloadable_files')) || {};

    // Variation attributes (attribute_pa_color = slug → name)
    let variationAttributes = null;
    if (isVar) {
      variationAttributes = [];
      for (const [k, v] of m) {
        if (!k.startsWith('attribute_')) continue;
        const tax = k.slice(10);
        const a = attrByTax.get(tax);
        if (a) variationAttributes.push({ id: a.attribute_id, name: a.attribute_label || a.attribute_name, option: v ? termSlugToName.get(`${tax}|${v}`) || v : '' });
        else variationAttributes.push({ id: 0, name: tax.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), option: v || '' });
      }
    }
    const defaults = php(m.get('_default_attributes'));
    const defaultAttributes = defaults && typeof defaults === 'object'
      ? Object.entries(defaults).map(([tax, slug]) => {
        const a = attrByTax.get(tax);
        return { id: a ? a.attribute_id : 0, name: a ? a.attribute_label || a.attribute_name : tax, option: a ? termSlugToName.get(`${tax}|${slug}`) || slug : slug };
      })
      : null;

    let status = p.post_status;
    if (isVar) status = p.post_status === 'private' ? 'private' : 'publish';

    products.push({
      id: p.ID,
      type: isVar ? 'variation' : (typeTerm ? typeTerm.slug : 'simple'),
      parentId: isVar ? p.post_parent : null,
      name: p.post_title || '',
      slug: p.post_name || String(p.ID),
      status,
      featured: vis.has('featured'),
      catalogVisibility,
      description: p.post_content || '',
      shortDescription: isVar ? '' : p.post_excerpt || '',
      ...(isVar ? { description: m.get('_variation_description') || '' } : {}),
      sku: (m.get('_sku') || '').trim() || null,
      price: num(m.get('_price')),
      regularPrice: num(m.get('_regular_price')),
      salePrice: num(m.get('_sale_price')),
      dateOnSaleFrom: ts(m.get('_sale_price_dates_from')),
      dateOnSaleTo: ts(m.get('_sale_price_dates_to')),
      virtual: yes(m.get('_virtual')),
      downloadable: yes(m.get('_downloadable')),
      downloads: Object.entries(files).map(([id, f]) => ({ id, name: f.name || '', file: f.file || '' })),
      downloadLimit: parseInt(m.get('_download_limit'), 10) || -1,
      downloadExpiry: parseInt(m.get('_download_expiry'), 10) || -1,
      externalUrl: m.get('_product_url') || '',
      buttonText: m.get('_button_text') || '',
      taxStatus: m.get('_tax_status') || 'taxable',
      taxClass: m.get('_tax_class') === 'parent' ? '' : m.get('_tax_class') || '',
      manageStock: yes(m.get('_manage_stock')),
      stockQuantity: m.get('_stock') !== undefined && m.get('_stock') !== null && m.get('_stock') !== '' ? Math.round(Number(m.get('_stock'))) : null,
      stockStatus: m.get('_stock_status') || 'instock',
      backorders: m.get('_backorders') || 'no',
      lowStockAmount: m.get('_low_stock_amount') ? parseInt(m.get('_low_stock_amount'), 10) : null,
      soldIndividually: yes(m.get('_sold_individually')),
      weight: m.get('_weight') || '',
      length: m.get('_length') || '',
      width: m.get('_width') || '',
      height: m.get('_height') || '',
      shippingClassId: cls ? cls.id : null,
      reviewsAllowed: p.comment_status === 'open',
      averageRating: num(m.get('_wc_average_rating')) || 0,
      ratingCount: (() => { const rc = php(m.get('_wc_rating_count')); return rc && typeof rc === 'object' ? Object.values(rc).reduce((a, b) => a + Number(b), 0) : parseInt(rc, 10) || 0; })(),
      totalSales: parseInt(m.get('total_sales'), 10) || 0,
      purchaseNote: m.get('_purchase_note') || '',
      menuOrder: p.menu_order || 0,
      upsellIds: toArr(m.get('_upsell_ids')).map(Number),
      crossSellIds: toArr(m.get('_crosssell_ids')).map(Number),
      groupedProducts: toArr(m.get('_children')).map(Number),
      variationAttributes,
      defaultAttributes,
      meta: publicMeta(m, KNOWN).filter((x) => !x.key.startsWith('attribute_')),
      createdAt: gmt(p.post_date_gmt) || new Date(),
      updatedAt: gmt(p.post_modified_gmt) || new Date(),
    });

    // Images: thumbnail first, then gallery
    const imgIds = [parseInt(m.get('_thumbnail_id'), 10), ...csvIds(m.get('_product_image_gallery'))].filter((x) => x && mediaIds.has(x));
    [...new Set(imgIds)].forEach((mediaId, position) => images.push({ productId: p.ID, mediaId, position }));

    if (!isVar) {
      for (const t of objTerms) {
        if (catIds.has(t.id) && cats.some((c) => c.ttid === t.ttid)) catPairs.push([p.ID, t.id]);
        if (tagIds.has(t.id) && tags.some((c) => c.ttid === t.ttid)) tagPairs.push([p.ID, t.id]);
      }
      // _product_attributes
      const pa = php(m.get('_product_attributes')) || {};
      Object.values(pa).forEach((a, i) => {
        if (!a || typeof a !== 'object') return;
        const isTax = yes(String(a.is_taxonomy));
        let options;
        let attributeId = 0;
        let name = a.name;
        if (isTax) {
          const g = attrByTax.get(a.name);
          attributeId = g ? g.attribute_id : 0;
          name = g ? g.attribute_label || g.attribute_name : a.name;
          const list = attrTerms.get(a.name) || [];
          options = objTerms.filter((t) => list.some((x) => x.ttid === t.ttid)).map((t) => t.name);
        } else {
          options = String(a.value || '').split('|').map((s) => s.trim()).filter(Boolean);
        }
        productAttrs.push({
          productId: p.ID, attributeId, name: name || '', position: parseInt(a.position, 10) || i,
          visible: yes(String(a.is_visible)), variation: yes(String(a.is_variation)), options,
        });
      });
    }
  }

  // Duplicate SKUs would break the unique index: keep the first, clear the rest
  const skus = new Set();
  for (const p of products) {
    if (!p.sku) continue;
    if (skus.has(p.sku)) { console.warn(`  ! duplicate SKU "${p.sku}" on #${p.id} — cleared`); p.sku = null; } else skus.add(p.sku);
  }

  const parents = products.filter((p) => p.type !== 'variation');
  const vars = products.filter((p) => p.type === 'variation');
  log(`  ${await insertMany('product', parents)} products, ${await insertMany('product', vars)} variations`);
  // Variable parents store several _price rows in WC — recompute from variations
  const { syncVariableParent } = require('../product');
  for (const p of parents.filter((x) => x.type === 'variable')) await syncVariableParent(p.id);
  log(`  ${await insertMany('productImage', images)} product images`);
  if (await prisma.productAttribute.count() === 0) log(`  ${await insertMany('productAttribute', productAttrs)} product attributes`);
  log(`  ${await linkMany('_ProductToCategory', 'Product', catPairs)} category links, ${await linkMany('_ProductToTag', 'Product', tagPairs)} tag links`);

  // Reviews
  const reviews = await q(`SELECT comment_ID, comment_post_ID, comment_author, comment_author_email, comment_content, comment_approved, comment_date_gmt FROM ${T('comments')} WHERE comment_type IN ('review','') AND comment_post_ID IN (SELECT ID FROM ${T('posts')} WHERE post_type = 'product')`);
  const cm = await metaFor('commentmeta', 'comment_id', reviews.map((r) => r.comment_ID));
  const statusOf = (a) => ({ 1: 'approved', 0: 'hold', spam: 'spam', trash: 'trash' }[a] || 'hold');
  const nReviews = await insertMany('productReview', reviews.filter((r) => productIdSet.has(r.comment_post_ID)).map((r) => {
    const m = cm.get(r.comment_ID) || new Map();
    return {
      id: r.comment_ID, productId: r.comment_post_ID, status: statusOf(String(r.comment_approved)), reviewer: r.comment_author || '',
      reviewerEmail: r.comment_author_email || '', review: r.comment_content || '', rating: parseInt(m.get('rating'), 10) || 0,
      verified: m.get('verified') === '1', createdAt: gmt(r.comment_date_gmt) || new Date(),
    };
  }));
  log(`  ${nReviews} reviews`);
}

async function migrateCoupons() {
  log('Coupons…');
  const posts = await q(`SELECT ID, post_title, post_excerpt, post_status, post_date_gmt, post_modified_gmt FROM ${T('posts')} WHERE post_type = 'shop_coupon' AND post_status NOT IN ('auto-draft')`);
  const meta = await metaFor('postmeta', 'post_id', posts.map((p) => p.ID), { all: true });
  const one = (m, k) => (m.get(k) || [])[0];
  const seen = new Set();
  const rows = [];
  for (const p of posts) {
    const m = meta.get(p.ID) || new Map();
    const code = String(p.post_title || '').trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const int = (k) => { const v = parseInt(one(m, k), 10); return v > 0 ? v : null; };
    rows.push({
      id: p.ID, code, status: p.post_status, description: p.post_excerpt || '',
      amount: num(one(m, 'coupon_amount')) || 0, discountType: one(m, 'discount_type') || 'fixed_cart',
      dateExpires: ts(one(m, 'date_expires')) || (one(m, 'expiry_date') ? gmt(`${one(m, 'expiry_date')} 23:59:59`) : null),
      usageCount: parseInt(one(m, 'usage_count'), 10) || 0, individualUse: yes(one(m, 'individual_use')),
      productIds: csvIds(one(m, 'product_ids')), excludedProductIds: csvIds(one(m, 'exclude_product_ids')),
      usageLimit: int('usage_limit'), usageLimitPerUser: int('usage_limit_per_user'), limitUsageToXItems: int('limit_usage_to_x_items'),
      freeShipping: yes(one(m, 'free_shipping')),
      productCategories: toArr(one(m, 'product_categories')).map(Number), excludedProductCategories: toArr(one(m, 'exclude_product_categories')).map(Number),
      excludeSaleItems: yes(one(m, 'exclude_sale_items')),
      minimumAmount: num(one(m, 'minimum_amount')), maximumAmount: num(one(m, 'maximum_amount')),
      emailRestrictions: toArr(one(m, 'customer_email')).map((e) => String(e).toLowerCase()),
      usedBy: (m.get('_used_by') || []).map(String),
      createdAt: gmt(p.post_date_gmt) || new Date(), updatedAt: gmt(p.post_modified_gmt) || new Date(),
    });
  }
  log(`  ${await insertMany('coupon', rows)} coupons`);
}

async function migrateTaxesAndShipping() {
  log('Tax rates & shipping zones…');
  if (await tableExists('wc_tax_rate_classes')) {
    const cls = await q(`SELECT name, slug FROM ${T('wc_tax_rate_classes')}`);
    await insertMany('taxClass', cls.map((c) => ({ slug: c.slug, name: c.name })));
  } else {
    const o = await q(`SELECT option_value AS v FROM ${T('options')} WHERE option_name = 'woocommerce_tax_classes'`);
    const names = String((o[0] || {}).v || '').split('\n').map((s) => s.trim()).filter(Boolean);
    await insertMany('taxClass', names.map((n) => ({ slug: n.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: n })));
  }
  const rates = await q(`SELECT * FROM ${T('woocommerce_tax_rates')}`);
  const locs = await q(`SELECT * FROM ${T('woocommerce_tax_rate_locations')}`);
  await insertMany('taxRate', rates.map((r) => ({
    id: r.tax_rate_id, country: r.tax_rate_country || '', state: r.tax_rate_state || '', rate: Number(r.tax_rate) || 0,
    name: r.tax_rate_name || '', priority: r.tax_rate_priority || 1, compound: r.tax_rate_compound === 1, shipping: r.tax_rate_shipping === 1,
    order: r.tax_rate_order || 0, class: r.tax_rate_class || 'standard',
    postcodes: locs.filter((l) => l.tax_rate_id === r.tax_rate_id && l.location_type === 'postcode').map((l) => l.location_code),
    cities: locs.filter((l) => l.tax_rate_id === r.tax_rate_id && l.location_type === 'city').map((l) => l.location_code),
  })));
  log(`  ${rates.length} tax rates`);

  const zones = await q(`SELECT * FROM ${T('woocommerce_shipping_zones')}`);
  await insertMany('shippingZone', zones.map((z) => ({ id: z.zone_id, name: z.zone_name, order: z.zone_order || 0 })));
  const zl = await q(`SELECT * FROM ${T('woocommerce_shipping_zone_locations')}`);
  if (await prisma.shippingZoneLocation.count() === 0) {
    await insertMany('shippingZoneLocation', zl.filter((l) => zones.some((z) => z.zone_id === l.zone_id)).map((l) => ({ zoneId: l.zone_id, code: l.location_code, type: l.location_type })));
  }
  const zm = await q(`SELECT * FROM ${T('woocommerce_shipping_zone_methods')}`);
  const settingRows = zm.length ? await q(`SELECT option_name AS n, option_value AS v FROM ${T('options')} WHERE option_name IN (?)`, [zm.map((m) => `woocommerce_${m.method_id}_${m.instance_id}_settings`)]) : [];
  const settingMap = new Map(settingRows.map((r) => [r.n, php(r.v) || {}]));
  await insertMany('shippingZoneMethod', zm.filter((m) => m.zone_id === 0 || zones.some((z) => z.zone_id === m.zone_id)).map((m) => ({
    instanceId: m.instance_id, zoneId: m.zone_id || null, methodId: m.method_id, order: m.method_order || 0, enabled: m.is_enabled === 1,
    settings: settingMap.get(`woocommerce_${m.method_id}_${m.instance_id}_settings`) || {},
  })));
  log(`  ${zones.length} shipping zones, ${zm.length} methods`);
}

// ───────── Orders (legacy posts or HPOS) ─────────
const ADDR = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country', 'email', 'phone'];

async function orderItemsFor(orderIds) {
  const items = [];
  for (const part of chunks(orderIds, 1000)) {
    const rows = await q(`SELECT order_item_id AS id, order_item_name AS name, order_item_type AS type, order_id FROM ${T('woocommerce_order_items')} WHERE order_id IN (?)`, [part]);
    const im = await metaFor('woocommerce_order_itemmeta', 'order_item_id', rows.map((r) => r.id));
    for (const r of rows) {
      const m = im.get(r.id) || new Map();
      const g = (k) => m.get(k);
      const taxData = (k) => { const v = php(g(k)) || {}; return v; };
      const vmeta = [];
      let mid = 1;
      for (const [k, v] of m) if (!k.startsWith('_') && !['method_id', 'instance_id', 'cost', 'total_tax', 'taxes', 'discount_amount', 'discount_amount_tax', 'rate_id', 'label', 'compound', 'tax_amount', 'shipping_tax_amount', 'rate_percent', 'coupon_data', 'coupon_info'].includes(k)) vmeta.push({ id: mid++, key: k, value: php(v) ?? v });
      const base = { id: r.id, orderId: r.order_id, name: r.name || '', meta: vmeta };
      if (r.type === 'line_item') {
        const td = taxData('_line_tax_data');
        const qty = parseInt(g('_qty'), 10) || 0;
        const subtotal = num(g('_line_subtotal')) || 0;
        items.push({
          ...base, type: 'line_item', productId: parseInt(g('_product_id'), 10) || null, variationId: parseInt(g('_variation_id'), 10) || null,
          quantity: qty, taxClass: g('_tax_class') || '', subtotal, subtotalTax: num(g('_line_subtotal_tax')) || 0,
          total: num(g('_line_total')) || 0, totalTax: num(g('_line_tax')) || 0, price: qty ? subtotal / qty : 0,
          taxes: Object.keys(td.total || {}).map((id) => ({ id: Number(id), total: String(td.total[id]), subtotal: String((td.subtotal || {})[id] ?? '') })),
        });
      } else if (r.type === 'shipping') {
        const tx = (php(g('taxes')) || {}).total || {};
        items.push({ ...base, type: 'shipping', methodId: g('method_id') || '', instanceId: String(g('instance_id') || ''), total: num(g('cost')) || 0, totalTax: num(g('total_tax')) || 0, taxes: Object.keys(tx).map((id) => ({ id: Number(id), total: String(tx[id]), subtotal: '' })) });
      } else if (r.type === 'fee') {
        const td = taxData('_line_tax_data');
        items.push({ ...base, type: 'fee', taxClass: g('_tax_class') || '', total: num(g('_line_total')) || 0, totalTax: num(g('_line_tax')) || 0, taxes: Object.keys(td.total || {}).map((id) => ({ id: Number(id), total: String(td.total[id]), subtotal: '' })), meta: [...vmeta, { id: mid++, key: '_tax_status', value: g('_tax_status') || 'taxable' }] });
      } else if (r.type === 'coupon') {
        items.push({ ...base, type: 'coupon', code: String(r.name || '').toLowerCase(), discount: num(g('discount_amount')) || 0, discountTax: num(g('discount_amount_tax')) || 0 });
      } else if (r.type === 'tax') {
        items.push({ ...base, type: 'tax', rateId: parseInt(g('rate_id'), 10) || null, rateCode: r.name || '', ratePercent: num(g('rate_percent')) || 0, compound: g('compound') === '1', total: num(g('tax_amount')) || 0, shippingTaxTotal: num(g('shipping_tax_amount')) || 0, meta: [{ id: 1, key: 'label', value: g('label') || '' }] });
      }
    }
  }
  return items;
}

async function migrateOrders() {
  log('Orders…');
  const hposOpt = await q(`SELECT option_value AS v FROM ${T('options')} WHERE option_name = 'woocommerce_custom_orders_table_enabled'`);
  const useHpos = (hposOpt[0] || {}).v === 'yes' && await tableExists('wc_orders');
  log(`  source: ${useHpos ? 'HPOS (wc_orders)' : 'legacy (wp_posts)'}`);
  const userIds = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
  const internal = (reduced, sales, coupons) => [
    ...(reduced ? [{ id: 9001, key: '_order_stock_reduced', value: 'yes' }] : []),
    ...(sales ? [{ id: 9002, key: '_recorded_sales', value: 'yes' }] : []),
    ...(coupons ? [{ id: 9003, key: '_recorded_coupon_usage_counts', value: 'yes' }] : []),
  ];
  const orders = [];
  const refunds = [];

  if (useHpos) {
    const rows = await q(`SELECT * FROM ${T('wc_orders')} WHERE type IN ('shop_order','shop_order_refund') AND status NOT IN ('auto-draft','trash')`);
    const ids = rows.map((r) => r.id);
    const addrs = new Map();
    const ops = new Map();
    for (const part of chunks(ids, 1000)) {
      for (const a of await q(`SELECT * FROM ${T('wc_order_addresses')} WHERE order_id IN (?)`, [part])) {
        if (!addrs.has(a.order_id)) addrs.set(a.order_id, {});
        addrs.get(a.order_id)[a.address_type] = Object.fromEntries(ADDR.filter((f) => a.address_type === 'billing' || f !== 'email').map((f) => [f, a[f] || '']));
      }
      for (const o of await q(`SELECT * FROM ${T('wc_order_operational_data')} WHERE order_id IN (?)`, [part])) ops.set(o.order_id, o);
    }
    const meta = await metaFor('wc_orders_meta', 'order_id', ids);
    for (const r of rows) {
      const m = meta.get(r.id) || new Map();
      if (r.type === 'shop_order_refund') {
        refunds.push({ id: r.id, orderId: r.parent_order_id, amount: Math.abs(num(m.get('_refund_amount')) ?? num(r.total_amount) ?? 0), reason: m.get('_refund_reason') || '', refundedBy: parseInt(m.get('_refunded_by'), 10) || 0, refundedPayment: yes(m.get('_refunded_payment')), createdAt: gmt(r.date_created_gmt) || new Date() });
        continue;
      }
      const op = ops.get(r.id) || {};
      const a = addrs.get(r.id) || {};
      orders.push({
        id: r.id, parentId: r.parent_order_id || 0, number: m.get('_order_number') || String(r.id), orderKey: op.order_key || '', createdVia: op.created_via || 'checkout',
        version: op.woocommerce_version || '', status: STATUS_MAP(r.status), currency: r.currency || 'USD', pricesIncludeTax: op.prices_include_tax === 1,
        discountTotal: num(op.discount_total_amount) || 0, discountTax: num(op.discount_tax_amount) || 0, shippingTotal: num(op.shipping_total_amount) || 0,
        shippingTax: num(op.shipping_tax_amount) || 0, cartTax: (num(r.tax_amount) || 0) - (num(op.shipping_tax_amount) || 0), total: num(r.total_amount) || 0, totalTax: num(r.tax_amount) || 0,
        customerId: userIds.has(r.customer_id) ? r.customer_id : null, customerIpAddress: r.ip_address || '', customerUserAgent: r.user_agent || '', customerNote: r.customer_note || '',
        billing: a.billing || Object.fromEntries(ADDR.map((f) => [f, ''])), shipping: a.shipping || Object.fromEntries(ADDR.filter((f) => f !== 'email').map((f) => [f, ''])),
        paymentMethod: r.payment_method || '', paymentMethodTitle: r.payment_method_title || '', transactionId: r.transaction_id || '',
        datePaid: gmt(op.date_paid_gmt), dateCompleted: gmt(op.date_completed_gmt), cartHash: op.cart_hash || '',
        meta: [...publicMeta(m), ...internal(op.order_stock_reduced === 1, op.recorded_sales === 1, op.coupon_usages_are_counted === 1)],
        createdAt: gmt(r.date_created_gmt) || new Date(), updatedAt: gmt(r.date_updated_gmt) || new Date(),
      });
    }
  } else {
    const rows = await q(`SELECT ID, post_status, post_parent, post_excerpt, post_type, post_date_gmt, post_modified_gmt FROM ${T('posts')} WHERE post_type IN ('shop_order','shop_order_refund') AND post_status NOT IN ('auto-draft','trash')`);
    const meta = await metaFor('postmeta', 'post_id', rows.map((r) => r.ID));
    for (const r of rows) {
      const m = meta.get(r.ID) || new Map();
      const g = (k) => m.get(k);
      if (r.post_type === 'shop_order_refund') {
        refunds.push({ id: r.ID, orderId: r.post_parent, amount: Math.abs(num(g('_refund_amount')) || 0), reason: g('_refund_reason') || r.post_excerpt || '', refundedBy: parseInt(g('_refunded_by'), 10) || 0, refundedPayment: yes(g('_refunded_payment')), createdAt: gmt(r.post_date_gmt) || new Date() });
        continue;
      }
      const addr = (type) => Object.fromEntries(ADDR.filter((f) => type === 'billing' || f !== 'email').map((f) => [f, g(`_${type}_${f}`) || '']));
      const cust = parseInt(g('_customer_user'), 10) || 0;
      const orderTax = num(g('_order_tax')) || 0;
      const shipTax = num(g('_order_shipping_tax')) || 0;
      orders.push({
        id: r.ID, parentId: r.post_parent || 0, number: g('_order_number') || String(r.ID), orderKey: g('_order_key') || '', createdVia: g('_created_via') || 'checkout',
        version: g('_order_version') || '', status: STATUS_MAP(r.post_status), currency: g('_order_currency') || 'USD', pricesIncludeTax: yes(g('_prices_include_tax')),
        discountTotal: num(g('_cart_discount')) || 0, discountTax: num(g('_cart_discount_tax')) || 0, shippingTotal: num(g('_order_shipping')) || 0, shippingTax: shipTax,
        cartTax: orderTax, total: num(g('_order_total')) || 0, totalTax: orderTax + shipTax,
        customerId: userIds.has(cust) ? cust : null, customerIpAddress: g('_customer_ip_address') || '', customerUserAgent: g('_customer_user_agent') || '', customerNote: r.post_excerpt || '',
        billing: addr('billing'), shipping: addr('shipping'), paymentMethod: g('_payment_method') || '', paymentMethodTitle: g('_payment_method_title') || '', transactionId: g('_transaction_id') || '',
        datePaid: ts(g('_date_paid')) || ts(g('_paid_date')), dateCompleted: ts(g('_date_completed')) || ts(g('_completed_date')), cartHash: g('_cart_hash') || '',
        meta: [...publicMeta(m), ...internal(yes(g('_order_stock_reduced')), yes(g('_recorded_sales')), yes(g('_recorded_coupon_usage_counts')))],
        createdAt: gmt(r.post_date_gmt) || new Date(), updatedAt: gmt(r.post_modified_gmt) || new Date(),
      });
    }
  }
  log(`  ${await insertMany('order', orders)} orders`);
  const orderIds = new Set(orders.map((o) => o.id));
  log(`  ${await insertMany('orderRefund', refunds.filter((r) => orderIds.has(r.orderId)))} refunds`);
  const items = await orderItemsFor([...orderIds]);
  log(`  ${await insertMany('orderItem', items)} order items`);

  // Order notes (comments of type order_note)
  const notes = await q(`SELECT comment_ID, comment_post_ID, comment_author, comment_content, comment_date_gmt FROM ${T('comments')} WHERE comment_type = 'order_note'`);
  const nm = await metaFor('commentmeta', 'comment_id', notes.map((n) => n.comment_ID));
  log(`  ${await insertMany('orderNote', notes.filter((n) => orderIds.has(n.comment_post_ID)).map((n) => ({
    id: n.comment_ID, orderId: n.comment_post_ID, note: n.comment_content || '', author: n.comment_author || 'system',
    customerNote: (nm.get(n.comment_ID) || new Map()).get('is_customer_note') === '1', createdAt: gmt(n.comment_date_gmt) || new Date(),
  })))} order notes`);
}

async function migrateContent() {
  log('Posts, pages, custom post types, categories, tags, comments, menus…');
  const { registry } = await loadAcfDefinitions();
  const customTypes = registry.types.map((t) => t.name).filter((n) => /^[a-z0-9_-]{1,20}$/.test(n));
  const customTaxes = registry.taxonomies.map((t) => t.name).filter((n) => !['category', 'post_tag', 'product_cat', 'product_tag', 'product_shipping_class'].includes(n) && !n.startsWith('pa_'));
  const userIds = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
  const cats = await termsOf('category');
  const tags = await termsOf('post_tag');
  const customTerms = [];
  for (const tx of customTaxes) customTerms.push(...(await termsOf(tx)).map((t) => ({ ...t, taxonomy: tx })));
  const customTermMeta = await metaFor('termmeta', 'term_id', customTerms.map((t) => t.id));
  const termRows = [...cats.map((t) => ({ id: t.id, taxonomy: 'category', name: t.name, slug: t.slug, description: t.description || '', parentId: t.parent || 0 })),
    ...tags.map((t) => ({ id: t.id, taxonomy: 'post_tag', name: t.name, slug: t.slug, description: t.description || '' }))];
  for (const t of customTerms) {
    termRows.push({ id: t.id, taxonomy: t.taxonomy, name: t.name, slug: t.slug, description: t.description || '', parentId: t.parent || 0, meta: await contentMeta(customTermMeta.get(t.id)) });
  }
  await insertMany('term', termRows);
  if (customTerms.length) log(`  ${customTerms.length} terms in custom taxonomies (${customTaxes.join(', ')})`);

  const stickyRow = await q(`SELECT option_value AS v FROM ${T('options')} WHERE option_name = 'sticky_posts'`);
  const sticky = new Set(toArr((stickyRow[0] || {}).v).map(Number));
  const postTypes = ['post', 'page', ...customTypes];
  const posts = await q(`SELECT ID, post_author, post_title, post_name, post_content, post_excerpt, post_status, post_parent, menu_order, comment_status, ping_status, post_password, post_type, post_date_gmt, post_date, post_modified_gmt FROM ${T('posts')} WHERE post_type IN (?) AND post_status NOT IN ('auto-draft','inherit')`, [postTypes]);
  const meta = await metaFor('postmeta', 'post_id', posts.map((p) => p.ID));
  const fmtTerms = await termsOf('post_format');
  const fmtRels = await relationships(fmtTerms.map((t) => t.ttid));
  const rows = [];
  for (const p of posts) {
    const m = meta.get(p.ID) || new Map();
    const fmt = fmtRels.find((r) => r.obj === p.ID);
    const fmtTerm = fmt ? fmtTerms.find((t) => t.ttid === fmt.ttid) : null;
    rows.push({
      id: p.ID, type: p.post_type, title: p.post_title || '', slug: p.post_name || String(p.ID), content: p.post_content || '', excerpt: p.post_excerpt || '',
      status: p.post_status, authorId: userIds.has(p.post_author) ? p.post_author : null, parentId: p.post_parent || 0, menuOrder: p.menu_order || 0,
      featuredMediaId: parseInt(m.get('_thumbnail_id'), 10) || 0, template: m.get('_wp_page_template') === 'default' ? '' : m.get('_wp_page_template') || '',
      commentStatus: p.comment_status || 'closed', pingStatus: p.ping_status || 'closed', sticky: sticky.has(p.ID),
      format: fmtTerm ? fmtTerm.slug.replace('post-format-', '') : 'standard', password: p.post_password || '',
      meta: await contentMeta(m), createdAt: gmt(p.post_date_gmt) || gmt(p.post_date) || new Date(), updatedAt: gmt(p.post_modified_gmt) || new Date(),
    });
  }
  const byType = rows.reduce((acc, r) => ({ ...acc, [r.type]: (acc[r.type] || 0) + 1 }), {});
  log(`  ${await insertMany('post', rows)} new posts (${Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})`);
  const rels = await relationships([...cats, ...tags, ...customTerms].map((t) => t.ttid));
  const ttid = new Map([...cats, ...tags, ...customTerms].map((t) => [t.ttid, t.id]));
  const postIds = new Set(rows.map((r) => r.id));
  log(`  ${await linkMany('_PostToTerm', 'Post', rels.filter((r) => postIds.has(r.obj)).map((r) => [r.obj, ttid.get(r.ttid)]))} term links`);

  const comments = await q(`SELECT * FROM ${T('comments')} WHERE comment_type IN ('','comment') AND comment_post_ID IN (SELECT ID FROM ${T('posts')} WHERE post_type IN ('post','page'))`);
  log(`  ${await insertMany('comment', comments.map((c) => ({
    id: c.comment_ID, postId: c.comment_post_ID, parentId: c.comment_parent || 0, authorId: c.user_id || 0, authorName: c.comment_author || '',
    authorEmail: c.comment_author_email || '', authorUrl: c.comment_author_url || '', content: c.comment_content || '',
    status: { 1: 'approved', 0: 'hold', spam: 'spam', trash: 'trash' }[String(c.comment_approved)] || 'hold', createdAt: gmt(c.comment_date_gmt) || new Date(),
  })))} comments`);

  // Menus
  const menus = await termsOf('nav_menu');
  const theme = await q(`SELECT option_value AS v FROM ${T('options')} WHERE option_name = 'stylesheet'`);
  const mods = theme[0] ? await q(`SELECT option_value AS v FROM ${T('options')} WHERE option_name = ?`, [`theme_mods_${theme[0].v}`]) : [];
  const locations = ((php((mods[0] || {}).v) || {}).nav_menu_locations) || {};
  await insertMany('menu', menus.map((mn) => ({ id: mn.id, name: mn.name, slug: mn.slug, locations: Object.keys(locations).filter((k) => Number(locations[k]) === mn.id) })));
  const menuRels = await relationships(menus.map((mn) => mn.ttid));
  const itemPosts = menuRels.length ? await q(`SELECT ID, post_title, menu_order FROM ${T('posts')} WHERE ID IN (?) AND post_type = 'nav_menu_item'`, [menuRels.map((r) => r.obj)]) : [];
  const im = await metaFor('postmeta', 'post_id', itemPosts.map((p) => p.ID));
  const menuOf = new Map(menuRels.map((r) => [r.obj, (menus.find((mn) => mn.ttid === r.ttid) || {}).id]));
  log(`  ${await insertMany('menuItem', itemPosts.map((p) => {
    const m = im.get(p.ID) || new Map();
    const classes = toArr(m.get('_menu_item_classes')).filter(Boolean).join(' ');
    return {
      id: p.ID, menuId: menuOf.get(p.ID), parentId: parseInt(m.get('_menu_item_menu_item_parent'), 10) || 0, title: p.post_title || '',
      url: m.get('_menu_item_url') || '', type: m.get('_menu_item_type') || 'custom', object: m.get('_menu_item_object') || 'custom',
      objectId: parseInt(m.get('_menu_item_object_id'), 10) || 0, target: m.get('_menu_item_target') || '', classes, menuOrder: p.menu_order || 0,
    };
  }).filter((x) => x.menuId))} menu items (${menus.length} menus)`);
}

// Wipes store/content data. Administrators (and their API keys) are kept, so whoever runs
// the import from the dashboard isn't logged out.
async function reset() {
  log('Resetting target tables (administrators are kept)…');
  const order = ['orderItem', 'orderNote', 'orderRefund', 'order', 'productReview', 'productImage', 'productAttribute', 'product', 'attributeTerm', 'attribute',
    'productCategory', 'productTag', 'shippingClass', 'coupon', 'taxRate', 'taxClass', 'shippingZoneMethod', 'shippingZoneLocation', 'shippingZone',
    'comment', 'menuItem', 'menu', 'post', 'term', 'media', 'paymentGateway', 'option'];
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const m of order) await prisma[m].deleteMany({});
  await prisma.user.deleteMany({ where: { role: { not: 'administrator' } } });
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  options.invalidate();
}

async function run(opts = {}, logFn = console.log) {
  logger = logFn;
  acfDefs = null;
  P = opts.prefix || 'wp_';
  ONLY = opts.only && opts.only.length ? opts.only : null;
  REMOTE_MEDIA = !!opts.remoteMedia;
  UPLOADS_URL = String(opts.uploadsUrl || '').replace(/\/$/, '');
  db = await mysql.createConnection({
    host: opts.host || 'localhost', port: parseInt(opts.port || '3306', 10),
    user: opts.user || 'root', password: opts.password || '', database: opts.database,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: false, charset: 'utf8mb4',
  });
  try {
    log(`Connected to WordPress DB "${opts.database}" (prefix ${P})`);
    if (opts.reset) await reset();
    const t0 = Date.now();
    if (should('options')) await migrateOptions();
    if (should('users')) await migrateUsers();
    if (should('media')) await migrateMedia();
    if (should('products')) { await migrateCatalogTerms(); await migrateProducts(); }
    if (should('coupons')) await migrateCoupons();
    if (should('taxes')) await migrateTaxesAndShipping();
    if (should('orders')) await migrateOrders();
    if (should('content')) await migrateContent();
    log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await db.end();
    require('../../lib/cache').clear();
  }
}

// Connectivity check used by the dashboard before starting an import
async function testConnection(opts) {
  const pfx = opts.prefix || 'wp_';
  const conn = await mysql.createConnection({
    host: opts.host || 'localhost', port: parseInt(opts.port || '3306', 10), user: opts.user || 'root', password: opts.password || '', database: opts.database,
  });
  try {
    const [rows] = await conn.query(`SELECT
      (SELECT COUNT(*) FROM \`${pfx}posts\` WHERE post_type = 'product') AS products,
      (SELECT COUNT(*) FROM \`${pfx}posts\` WHERE post_type IN ('shop_order')) AS orders_legacy,
      (SELECT COUNT(*) FROM \`${pfx}posts\` WHERE post_type IN ('post','page')) AS posts,
      (SELECT COUNT(*) FROM \`${pfx}users\`) AS users,
      (SELECT option_value FROM \`${pfx}options\` WHERE option_name = 'woocommerce_version') AS woocommerce_version,
      (SELECT option_value FROM \`${pfx}options\` WHERE option_name = 'siteurl') AS site_url`);
    return { ok: true, ...rows[0] };
  } finally { await conn.end(); }
}

module.exports = { run, testConnection };
