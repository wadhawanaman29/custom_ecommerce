/* eslint-disable no-await-in-loop */
// Imports from a live WordPress + WooCommerce site over its REST API (when DB access isn't available).
//   - WooCommerce data via /wc/v3 with consumer key/secret
//   - WordPress content via /wp/v2 (public), or with a username + Application Password for drafts,
//     private content, users and menus
// Original IDs are preserved; existing rows are skipped, so it is safe to re-run.
// Limitation: the REST API never exposes password hashes — imported customers must reset their password.
const crypto = require('crypto');
const path = require('path');
const prisma = require('../../db');
const config = require('../../config');
const options = require('../../lib/options');
const registry = require('../../lib/settings-registry');
const { hashPassword } = require('../../lib/password');
const { getJson, download } = require('./http-client');

const PHASES = ['settings', 'media', 'products', 'coupons', 'taxes', 'customers', 'orders', 'content'];

function makeClient(opts) {
  const base = String(opts.siteUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Site URL must start with http:// or https://');
  const wcAuth = opts.consumerKey ? `Basic ${Buffer.from(`${opts.consumerKey}:${opts.consumerSecret}`).toString('base64')}` : null;
  const wpAuth = opts.wpUser && opts.wpAppPassword ? `Basic ${Buffer.from(`${opts.wpUser}:${String(opts.wpAppPassword).replace(/\s+/g, '')}`).toString('base64')}` : null;
  const url = (ns, route, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return `${base}/wp-json/${ns}/${route}${qs ? `?${qs}` : ''}`;
  };
  return {
    base,
    hasWpAuth: !!wpAuth,
    wc: (route, params) => getJson(url('wc/v3', route, params), { headers: wcAuth ? { Authorization: wcAuth } : {} }),
    wp: (route, params) => getJson(url('wp/v2', route, params), { headers: wpAuth ? { Authorization: wpAuth } : {} }),
    // Iterates every page of a collection, calling onPage(items) for each
    async each(kind, route, params, onPage) {
      let page = 1;
      let totalPages = 1;
      do {
        const { body, headers } = await this[kind](route, { per_page: 100, ...params, page });
        totalPages = parseInt(headers['x-wp-totalpages'], 10) || 1;
        if (Array.isArray(body) && body.length) await onPage(body, page, totalPages);
        page++;
      } while (page <= totalPages);
    },
  };
}

const dt = (local, gmtValue) => {
  const v = gmtValue || local;
  if (!v) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const meta = (list) => (Array.isArray(list) ? list.map((m, i) => ({ id: m.id || i + 1, key: m.key, value: m.value })) : []);
const rendered = (v) => (v && typeof v === 'object' ? (v.raw ?? v.rendered ?? '') : String(v ?? ''));

async function insert(model, rows) {
  if (!rows.length) return 0;
  return (await prisma[model].createMany({ data: rows, skipDuplicates: true })).count;
}

async function linkM2M(table, leftModel, pairs) {
  if (!pairs.length) return 0;
  const cols = await prisma.$queryRawUnsafe(
    'SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS ref FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?) AND REFERENCED_TABLE_NAME IS NOT NULL', table,
  );
  const left = cols.find((c) => c.ref.toLowerCase() === leftModel.toLowerCase());
  const right = cols.find((c) => c.col !== left.col);
  const values = pairs.map(() => '(?, ?)').join(',');
  return prisma.$executeRawUnsafe(`INSERT IGNORE INTO \`${left.tbl}\` (\`${left.col}\`, \`${right.col}\`) VALUES ${values}`, ...pairs.flat());
}

async function run(opts, log = console.log) {
  const api = makeClient(opts);
  const only = opts.only && opts.only.length ? opts.only : PHASES;
  const should = (p) => only.includes(p);
  const t0 = Date.now();
  const knownMedia = new Set((await prisma.media.findMany({ select: { id: true } })).map((m) => m.id));
  const adminId = (await prisma.user.findFirst({ where: { role: 'administrator' }, select: { id: true } }))?.id || null;

  // Ensure a media row exists for an image referenced by id/src (downloads it when enabled)
  async function ensureMedia(img, createdAt) {
    if (!img || !img.src) return null;
    const id = parseInt(img.id, 10) || null;
    if (id && knownMedia.has(id)) return id;
    const row = await mediaRow({ id, source_url: img.src, title: { rendered: img.name || '' }, alt_text: img.alt || '', date_gmt: createdAt, mime_type: '' });
    if (!row) return null;
    const created = id ? await prisma.media.upsert({ where: { id }, create: row, update: {} }) : await prisma.media.create({ data: row });
    knownMedia.add(created.id);
    return created.id;
  }

  async function mediaRow(m) {
    const src = m.source_url;
    if (!src) return null;
    const rel = decodeURIComponent((src.split('/wp-content/uploads/')[1] || `imported/${path.basename(new URL(src).pathname)}`).split('?')[0]);
    let storedPath = src;
    let size = (m.media_details && m.media_details.filesize) || 0;
    let mime = m.mime_type;
    if (opts.downloadMedia) {
      const dest = path.join(config.uploadsDir, rel);
      if (!dest.startsWith(config.uploadsDir)) return null;
      try {
        const r = await download(src, dest);
        storedPath = rel.replace(/\\/g, '/');
        size = r.size;
        mime = mime || r.contentType.split(';')[0];
      } catch (e) {
        log(`  ! media download failed (${src}): ${e.message} — keeping remote URL`);
      }
    }
    const ext = path.extname(rel).toLowerCase().slice(1);
    return {
      ...(m.id ? { id: m.id } : {}),
      title: rendered(m.title),
      slug: m.slug || path.basename(rel, path.extname(rel)),
      fileName: path.basename(rel),
      path: storedPath,
      mimeType: mime || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'application/octet-stream'),
      fileSize: size || 0,
      width: (m.media_details && m.media_details.width) || null,
      height: (m.media_details && m.media_details.height) || null,
      altText: m.alt_text || '',
      caption: rendered(m.caption).replace(/<\/?p>/g, '').trim(),
      sizes: opts.downloadMedia ? null : (m.media_details && m.media_details.sizes) ? Object.fromEntries(Object.entries(m.media_details.sizes).map(([k, v]) => [k, { file: v.source_url, width: v.width, height: v.height, 'mime-type': v.mime_type }])) : null,
      createdAt: dt(m.date, m.date_gmt) || new Date(),
      updatedAt: dt(m.modified, m.modified_gmt) || new Date(),
    };
  }

  log(`Importing from ${api.base} (${only.join(', ')})${opts.downloadMedia ? ' — downloading media' : ' — media stays on the old site'}`);

  // Probe credentials early
  if (opts.consumerKey) {
    await api.wc('system_status', {}).catch(async (e) => {
      if (e.status === 401 || e.status === 403) throw new Error(`WooCommerce keys rejected: ${e.message}`);
      await api.wc('products', { per_page: 1 });
    });
    log('WooCommerce API: connected');
  }

  // ── Settings & payment gateways ──
  if (should('settings') && opts.consumerKey) {
    log('Settings…');
    let n = 0;
    for (const g of [...new Set(registry.settings.map((s) => s.group_id))].filter((x) => x !== 'wp')) {
      try {
        const { body } = await api.wc(`settings/${g}`);
        for (const s of body) if (registry.byId.has(s.id)) { await options.setOption(s.id, s.value); n++; }
      } catch (e) { log(`  ! settings/${g}: ${e.message}`); }
    }
    try {
      const { body } = await api.wp('settings').catch(() => ({ body: null }));
      if (body) {
        const map = { title: 'blogname', description: 'blogdescription', timezone: 'timezone_string', date_format: 'date_format', time_format: 'time_format', posts_per_page: 'posts_per_page', show_on_front: 'show_on_front', page_on_front: 'page_on_front', page_for_posts: 'page_for_posts' };
        for (const [k, o] of Object.entries(map)) if (body[k] !== undefined) { await options.setOption(o, String(body[k])); n++; }
      } else {
        const { body: idx } = await getJson(`${api.base}/wp-json/`);
        await options.setOption('blogname', idx.name || ''); await options.setOption('blogdescription', idx.description || '');
        await options.setOption('gmt_offset', String(idx.gmt_offset ?? '0')); await options.setOption('timezone_string', idx.timezone_string || 'UTC');
        n += 4;
      }
    } catch (e) { log(`  ! site settings: ${e.message}`); }
    log(`  ${n} settings`);
    try {
      const { body } = await api.wc('payment_gateways');
      for (const g of body) {
        const settings = Object.fromEntries(Object.entries(g.settings || {}).filter(([k]) => !['title', 'description'].includes(k)).map(([k, v]) => [k, v.value]));
        await prisma.paymentGateway.upsert({
          where: { id: g.id },
          create: { id: g.id, title: g.title || g.id, description: g.description || '', order: parseInt(g.order, 10) || 0, enabled: !!g.enabled, methodTitle: g.method_title || '', methodDescription: g.method_description || '', settings },
          update: { title: g.title || g.id, description: g.description || '', enabled: !!g.enabled, order: parseInt(g.order, 10) || 0, settings },
        });
      }
      log(`  ${body.length} payment gateways`);
    } catch (e) { log(`  ! payment gateways: ${e.message}`); }
  }

  // ── Media library ──
  if (should('media')) {
    log('Media…');
    let n = 0;
    await api.each('wp', 'media', {}, async (items, page, pages) => {
      for (const m of items) {
        if (knownMedia.has(m.id)) continue;
        const row = await mediaRow(m);
        if (!row) continue;
        row.authorId = null;
        await insert('media', [row]);
        knownMedia.add(m.id);
        n++;
      }
      log(`  page ${page}/${pages} — ${n} media`);
    });
  }

  // ── Catalog ──
  if (should('products') && opts.consumerKey) {
    log('Categories, tags, shipping classes, attributes…');
    const cats = [];
    await api.each('wc', 'products/categories', {}, async (items) => { cats.push(...items); });
    for (const c of cats) {
      const imageId = c.image ? await ensureMedia(c.image) : null;
      await insert('productCategory', [{ id: c.id, name: c.name, slug: c.slug, description: c.description || '', display: c.display || 'default', imageId, menuOrder: c.menu_order || 0 }]);
    }
    for (const c of cats.filter((x) => x.parent)) await prisma.productCategory.updateMany({ where: { id: c.id }, data: { parentId: c.parent } });
    let tags = 0;
    await api.each('wc', 'products/tags', {}, async (items) => { tags += await insert('productTag', items.map((t) => ({ id: t.id, name: t.name, slug: t.slug, description: t.description || '' }))); });
    let classes = 0;
    await api.each('wc', 'products/shipping_classes', {}, async (items) => { classes += await insert('shippingClass', items.map((t) => ({ id: t.id, name: t.name, slug: t.slug, description: t.description || '' }))); });
    const { body: attrs } = await api.wc('products/attributes');
    await insert('attribute', attrs.map((a) => ({ id: a.id, name: a.name, slug: String(a.slug).replace(/^pa_/, ''), type: a.type || 'select', orderBy: a.order_by || 'menu_order', hasArchives: !!a.has_archives })));
    for (const a of attrs) {
      await api.each('wc', `products/attributes/${a.id}/terms`, {}, async (items) => {
        await insert('attributeTerm', items.map((t) => ({ id: t.id, attributeId: a.id, name: t.name, slug: t.slug, description: t.description || '', menuOrder: t.menu_order || 0 })));
      });
    }
    log(`  ${cats.length} categories, ${tags} tags, ${classes} shipping classes, ${attrs.length} attributes`);

    log('Products…');
    const existing = new Set((await prisma.product.findMany({ select: { id: true } })).map((p) => p.id));
    const shipClasses = new Map((await prisma.shippingClass.findMany()).map((c) => [c.slug, c.id]));
    const skus = new Set((await prisma.product.findMany({ where: { sku: { not: null } }, select: { sku: true } })).map((p) => p.sku));
    const mapProduct = (p, extra = {}) => {
      let sku = (p.sku || '').trim() || null;
      if (sku && skus.has(sku)) { log(`  ! duplicate SKU "${sku}" on #${p.id} — cleared`); sku = null; }
      if (sku) skus.add(sku);
      return {
        id: p.id, name: p.name || '', slug: p.slug || String(p.id), status: p.status || 'publish', featured: !!p.featured,
        catalogVisibility: p.catalog_visibility || 'visible', description: p.description || '', shortDescription: p.short_description || '', sku,
        price: num(p.price), regularPrice: num(p.regular_price), salePrice: num(p.sale_price),
        dateOnSaleFrom: dt(p.date_on_sale_from, p.date_on_sale_from_gmt), dateOnSaleTo: dt(p.date_on_sale_to, p.date_on_sale_to_gmt),
        virtual: !!p.virtual, downloadable: !!p.downloadable, downloads: p.downloads || [], downloadLimit: p.download_limit ?? -1, downloadExpiry: p.download_expiry ?? -1,
        externalUrl: p.external_url || '', buttonText: p.button_text || '', taxStatus: p.tax_status || 'taxable', taxClass: p.tax_class || '',
        manageStock: p.manage_stock === true, stockQuantity: p.stock_quantity ?? null, stockStatus: p.stock_status || 'instock', backorders: p.backorders || 'no',
        lowStockAmount: p.low_stock_amount ?? null, soldIndividually: !!p.sold_individually, weight: p.weight || '',
        length: (p.dimensions && p.dimensions.length) || '', width: (p.dimensions && p.dimensions.width) || '', height: (p.dimensions && p.dimensions.height) || '',
        shippingClassId: p.shipping_class ? shipClasses.get(p.shipping_class) || null : null,
        reviewsAllowed: p.reviews_allowed !== false, averageRating: num(p.average_rating) || 0, ratingCount: p.rating_count || 0, totalSales: parseInt(p.total_sales, 10) || 0,
        purchaseNote: p.purchase_note || '', menuOrder: p.menu_order || 0, upsellIds: p.upsell_ids || [], crossSellIds: p.cross_sell_ids || [],
        groupedProducts: p.grouped_products || [], defaultAttributes: p.default_attributes || null, meta: meta(p.meta_data),
        createdAt: dt(p.date_created, p.date_created_gmt) || new Date(), updatedAt: dt(p.date_modified, p.date_modified_gmt) || new Date(),
        ...extra,
      };
    };
    let nProducts = 0;
    let nVariations = 0;
    await api.each('wc', 'products', { status: 'any', orderby: 'id', order: 'asc' }, async (items, page, pages) => {
      for (const p of items) {
        if (existing.has(p.id)) continue;
        await insert('product', [mapProduct(p, { type: p.type || 'simple', parentId: null })]);
        existing.add(p.id);
        nProducts++;
        const imgs = [];
        for (const img of p.images || []) { const id = await ensureMedia(img, p.date_created_gmt); if (id) imgs.push(id); }
        await insert('productImage', [...new Set(imgs)].map((mediaId, position) => ({ productId: p.id, mediaId, position })));
        await insert('productAttribute', (p.attributes || []).map((a, i) => ({
          productId: p.id, attributeId: a.id || 0, name: a.name || '', position: a.position ?? i, visible: a.visible !== false, variation: !!a.variation, options: a.options || [],
        })));
        await linkM2M('_ProductToCategory', 'Product', (p.categories || []).map((c) => [p.id, c.id]));
        await linkM2M('_ProductToTag', 'Product', (p.tags || []).map((t) => [p.id, t.id]));
        if (p.type === 'variable') {
          await api.each('wc', `products/${p.id}/variations`, { status: 'any' }, async (vars) => {
            for (const v of vars) {
              if (existing.has(v.id)) continue;
              await insert('product', [mapProduct({ ...v, name: v.name || p.name, slug: `${p.slug}-${v.id}`, short_description: '' }, {
                type: 'variation', parentId: p.id, variationAttributes: (v.attributes || []).map((a) => ({ id: a.id || 0, name: a.name, option: a.option || '' })),
                description: v.description || '', defaultAttributes: null,
              })]);
              existing.add(v.id);
              nVariations++;
              if (v.image) { const id = await ensureMedia(v.image, v.date_created_gmt); if (id) await insert('productImage', [{ productId: v.id, mediaId: id, position: 0 }]); }
            }
          });
          await require('../product').syncVariableParent(p.id);
        }
      }
      log(`  page ${page}/${pages} — ${nProducts} products, ${nVariations} variations`);
    });

    log('Reviews…');
    let nReviews = 0;
    await api.each('wc', 'products/reviews', { status: 'all' }, async (items) => {
      nReviews += await insert('productReview', items.filter((r) => existing.has(r.product_id)).map((r) => ({
        id: r.id, productId: r.product_id, status: r.status === 'approved' ? 'approved' : r.status, reviewer: r.reviewer || '', reviewerEmail: r.reviewer_email || '',
        review: r.review || '', rating: r.rating || 0, verified: !!r.verified, createdAt: dt(r.date_created, r.date_created_gmt) || new Date(),
      })));
    }).catch((e) => log(`  ! reviews: ${e.message}`));
    log(`  ${nReviews} reviews`);
  }

  // ── Coupons ──
  if (should('coupons') && opts.consumerKey) {
    log('Coupons…');
    let n = 0;
    const seen = new Set((await prisma.coupon.findMany({ select: { code: true } })).map((c) => c.code));
    await api.each('wc', 'coupons', {}, async (items) => {
      const rows = items.filter((c) => c.code && !seen.has(c.code.toLowerCase())).map((c) => {
        seen.add(c.code.toLowerCase());
        return {
          id: c.id, code: c.code.toLowerCase(), amount: num(c.amount) || 0, status: c.status || 'publish', discountType: c.discount_type || 'fixed_cart',
          description: c.description || '', dateExpires: dt(c.date_expires, c.date_expires_gmt), usageCount: c.usage_count || 0, individualUse: !!c.individual_use,
          productIds: c.product_ids || [], excludedProductIds: c.excluded_product_ids || [], usageLimit: c.usage_limit || null, usageLimitPerUser: c.usage_limit_per_user || null,
          limitUsageToXItems: c.limit_usage_to_x_items || null, freeShipping: !!c.free_shipping, productCategories: c.product_categories || [],
          excludedProductCategories: c.excluded_product_categories || [], excludeSaleItems: !!c.exclude_sale_items,
          minimumAmount: num(c.minimum_amount) || null, maximumAmount: num(c.maximum_amount) || null, emailRestrictions: c.email_restrictions || [],
          usedBy: (c.used_by || []).map(String), meta: meta(c.meta_data),
          createdAt: dt(c.date_created, c.date_created_gmt) || new Date(), updatedAt: dt(c.date_modified, c.date_modified_gmt) || new Date(),
        };
      });
      n += await insert('coupon', rows);
    });
    log(`  ${n} coupons`);
  }

  // ── Taxes & shipping ──
  if (should('taxes') && opts.consumerKey) {
    log('Tax rates & shipping zones…');
    const { body: classes } = await api.wc('taxes/classes');
    await insert('taxClass', classes.filter((c) => c.slug !== 'standard').map((c) => ({ slug: c.slug, name: c.name })));
    let n = 0;
    await api.each('wc', 'taxes', {}, async (items) => {
      n += await insert('taxRate', items.map((r) => ({
        id: r.id, country: r.country || '', state: r.state || '', postcodes: r.postcodes || (r.postcode ? r.postcode.split(';') : []),
        cities: r.cities || (r.city ? r.city.split(';') : []), rate: num(r.rate) || 0, name: r.name || '', priority: r.priority || 1,
        compound: !!r.compound, shipping: r.shipping !== false, order: r.order || 0, class: r.class || 'standard',
      })));
    });
    const { body: zones } = await api.wc('shipping/zones');
    for (const z of zones) {
      if (z.id !== 0) await insert('shippingZone', [{ id: z.id, name: z.name, order: z.order || 0 }]);
      if (z.id !== 0 && !(await prisma.shippingZoneLocation.count({ where: { zoneId: z.id } }))) {
        const { body: locs } = await api.wc(`shipping/zones/${z.id}/locations`);
        await insert('shippingZoneLocation', locs.map((l) => ({ zoneId: z.id, code: l.code, type: l.type })));
      }
      const { body: methods } = await api.wc(`shipping/zones/${z.id}/methods`);
      await insert('shippingZoneMethod', methods.map((m) => ({
        instanceId: m.instance_id, zoneId: z.id || null, methodId: m.method_id, order: m.order || 0, enabled: !!m.enabled,
        settings: Object.fromEntries(Object.entries(m.settings || {}).map(([k, v]) => [k, v.value])),
      })));
    }
    log(`  ${n} tax rates, ${zones.length} shipping zones`);
  }

  // ── Customers ──
  if (should('customers') && opts.consumerKey) {
    log('Customers…');
    let n = 0;
    const emails = new Set((await prisma.user.findMany({ select: { email: true } })).map((u) => u.email));
    const logins = new Set((await prisma.user.findMany({ select: { login: true } })).map((u) => u.login));
    const placeholderHash = await hashPassword(crypto.randomBytes(24).toString('base64'));
    await api.each('wc', 'customers', { role: 'all', orderby: 'id', order: 'asc' }, async (items, page, pages) => {
      const rows = [];
      for (const c of items) {
        const email = String(c.email || `user${c.id}@invalid.local`).toLowerCase();
        if (emails.has(email)) continue;
        let login = c.username || email.split('@')[0];
        if (logins.has(login)) login = `${login}${c.id}`;
        emails.add(email); logins.add(login);
        rows.push({
          id: c.id, login, email, passwordHash: placeholderHash, firstName: c.first_name || '', lastName: c.last_name || '',
          displayName: [c.first_name, c.last_name].filter(Boolean).join(' ') || login, nicename: login.toLowerCase(),
          role: c.role || 'customer', billing: c.billing || {}, shipping: c.shipping || {}, isPayingCustomer: !!c.is_paying_customer,
          meta: meta(c.meta_data), createdAt: dt(c.date_created, c.date_created_gmt) || new Date(), updatedAt: dt(c.date_modified, c.date_modified_gmt) || new Date(),
        });
      }
      n += await insert('user', rows);
      log(`  page ${page}/${pages} — ${n} customers`);
    });
    log('  note: passwords are not available over the REST API — customers must use "forgot password" once');
  }

  // ── Orders ──
  if (should('orders') && opts.consumerKey) {
    log('Orders…');
    const users = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
    const existingOrders = new Set((await prisma.order.findMany({ select: { id: true } })).map((o) => o.id));
    let n = 0;
    const taxes = (list, sub) => (Array.isArray(list) ? list.map((t) => ({ id: t.id, total: String(t.total ?? ''), subtotal: sub ? String(t.subtotal ?? '') : '' })) : []);
    await api.each('wc', 'orders', { status: 'any', orderby: 'id', order: 'asc' }, async (items, page, pages) => {
      for (const o of items) {
        if (existingOrders.has(o.id)) continue;
        const total = (k) => num(o[k]) || 0;
        await insert('order', [{
          id: o.id, parentId: o.parent_id || 0, number: String(o.number || o.id), orderKey: o.order_key || '', createdVia: o.created_via || 'checkout', version: o.version || '',
          status: o.status, currency: o.currency || 'USD', pricesIncludeTax: !!o.prices_include_tax,
          discountTotal: total('discount_total'), discountTax: total('discount_tax'), shippingTotal: total('shipping_total'), shippingTax: total('shipping_tax'),
          cartTax: total('cart_tax'), total: total('total'), totalTax: total('total_tax'),
          customerId: users.has(o.customer_id) ? o.customer_id : null, customerIpAddress: o.customer_ip_address || '', customerUserAgent: o.customer_user_agent || '',
          customerNote: o.customer_note || '', billing: o.billing || {}, shipping: o.shipping || {}, paymentMethod: o.payment_method || '',
          paymentMethodTitle: o.payment_method_title || '', transactionId: o.transaction_id || '', datePaid: dt(o.date_paid, o.date_paid_gmt),
          dateCompleted: dt(o.date_completed, o.date_completed_gmt), cartHash: o.cart_hash || '',
          // Imported orders already affected stock/sales on the old site
          meta: [...meta(o.meta_data), ...(['processing', 'completed', 'on-hold'].includes(o.status) ? [{ id: 9001, key: '_order_stock_reduced', value: 'yes' }, { id: 9002, key: '_recorded_sales', value: 'yes' }, { id: 9003, key: '_recorded_coupon_usage_counts', value: 'yes' }] : [])],
          createdAt: dt(o.date_created, o.date_created_gmt) || new Date(), updatedAt: dt(o.date_modified, o.date_modified_gmt) || new Date(),
        }]);
        existingOrders.add(o.id);
        const rows = [];
        for (const l of o.line_items || []) {
          rows.push({
            id: l.id, orderId: o.id, type: 'line_item', name: l.name || '', productId: l.product_id || null, variationId: l.variation_id || null, quantity: l.quantity || 0,
            sku: l.sku || '', price: num(l.price) || 0, taxClass: l.tax_class || '', subtotal: num(l.subtotal) || 0, subtotalTax: num(l.subtotal_tax) || 0,
            total: num(l.total) || 0, totalTax: num(l.total_tax) || 0, taxes: taxes(l.taxes, true), meta: meta((l.meta_data || []).map((m) => ({ ...m, value: m.display_value ?? m.value }))),
          });
        }
        for (const s of o.shipping_lines || []) rows.push({ id: s.id, orderId: o.id, type: 'shipping', name: s.method_title || '', methodId: s.method_id || '', instanceId: String(s.instance_id || ''), total: num(s.total) || 0, totalTax: num(s.total_tax) || 0, taxes: taxes(s.taxes), meta: meta(s.meta_data) });
        for (const f of o.fee_lines || []) rows.push({ id: f.id, orderId: o.id, type: 'fee', name: f.name || '', taxClass: f.tax_class || '', total: num(f.total) || 0, totalTax: num(f.total_tax) || 0, taxes: taxes(f.taxes), meta: [...meta(f.meta_data), { id: 999, key: '_tax_status', value: f.tax_status || 'taxable' }] });
        for (const c of o.coupon_lines || []) rows.push({ id: c.id, orderId: o.id, type: 'coupon', name: c.code || '', code: String(c.code || '').toLowerCase(), discount: num(c.discount) || 0, discountTax: num(c.discount_tax) || 0, meta: [] });
        for (const t of o.tax_lines || []) rows.push({ id: t.id, orderId: o.id, type: 'tax', name: t.rate_code || '', rateId: t.rate_id || null, rateCode: t.rate_code || '', ratePercent: num(t.rate_percent) || 0, compound: !!t.compound, total: num(t.tax_total) || 0, shippingTaxTotal: num(t.shipping_tax_total) || 0, meta: [{ id: 1, key: 'label', value: t.label || '' }] });
        await insert('orderItem', rows);
        if (o.refunds && o.refunds.length) {
          await insert('orderRefund', o.refunds.map((r) => ({ id: r.id, orderId: o.id, amount: Math.abs(num(r.total) || 0), reason: r.reason || '' })));
        }
        if (opts.orderNotes) {
          const { body: notes } = await api.wc(`orders/${o.id}/notes`).catch(() => ({ body: [] }));
          await insert('orderNote', notes.map((x) => ({ id: x.id, orderId: o.id, note: x.note || '', author: x.author || 'system', customerNote: !!x.customer_note, createdAt: dt(x.date_created, x.date_created_gmt) || new Date() })));
        }
        n++;
      }
      log(`  page ${page}/${pages} — ${n} orders`);
    });
  }

  // ── WordPress content ──
  if (should('content')) {
    log('Posts, pages, categories, tags, comments, menus…');
    const ctx = api.hasWpAuth ? { context: 'edit' } : {};
    const status = api.hasWpAuth ? { status: 'publish,future,draft,pending,private' } : {};
    let terms = 0;
    for (const [route, taxonomy] of [['categories', 'category'], ['tags', 'post_tag']]) {
      await api.each('wp', route, {}, async (items) => {
        terms += await insert('term', items.map((t) => ({ id: t.id, taxonomy, name: t.name, slug: t.slug, description: t.description || '', parentId: t.parent || 0 })));
      });
    }
    const users = new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
    if (api.hasWpAuth) {
      // Staff users (authors/editors/admins) — customers came from wc/v3/customers
      await api.each('wp', 'users', { context: 'edit', roles: 'administrator,editor,author,contributor,shop_manager' }, async (items) => {
        const placeholderHash = await hashPassword(crypto.randomBytes(24).toString('base64'));
        for (const u of items) {
          if (users.has(u.id) || !u.email) continue;
          if (await prisma.user.findFirst({ where: { OR: [{ email: u.email.toLowerCase() }, { login: u.username }] } })) continue;
          await insert('user', [{ id: u.id, login: u.username, email: u.email.toLowerCase(), passwordHash: placeholderHash, displayName: u.name || u.username, firstName: u.first_name || '', lastName: u.last_name || '', nicename: u.slug || u.username, role: (u.roles || [])[0] || 'author', createdAt: dt(u.registered_date) || new Date() }]);
          users.add(u.id);
        }
      }).catch((e) => log(`  ! users: ${e.message}`));
    }
    let posts = 0;
    for (const type of ['posts', 'pages']) {
      await api.each('wp', type, { ...ctx, ...status, orderby: 'id', order: 'asc' }, async (items) => {
        for (const p of items) {
          const raw = p.content && p.content.raw !== undefined;
          const featured = p.featured_media || 0;
          posts += await insert('post', [{
            id: p.id, type: type === 'posts' ? 'post' : 'page', title: rendered(p.title), slug: p.slug || String(p.id), content: rendered(p.content),
            excerpt: p.excerpt && p.excerpt.raw !== undefined ? p.excerpt.raw : '', status: p.status || 'publish',
            authorId: users.has(p.author) ? p.author : adminId, parentId: p.parent || 0, menuOrder: p.menu_order || 0, featuredMediaId: featured,
            template: p.template || '', commentStatus: p.comment_status || 'closed', pingStatus: p.ping_status || 'closed', sticky: !!p.sticky, format: p.format || 'standard',
            // Without edit context we only get rendered HTML; flag it so it's not auto-paragraphed again
            meta: [...Object.entries(p.meta && !Array.isArray(p.meta) ? p.meta : {}).map(([key, value], i) => ({ id: i + 1, key, value })),
              ...Object.entries(p.acf && typeof p.acf === 'object' && !Array.isArray(p.acf) ? p.acf : {}).map(([key, value], i) => ({ id: 500 + i, key: `acf:${key}`, value })),
              ...(raw ? [] : [{ id: 999, key: '_rendered_html', value: true }])],
            createdAt: dt(p.date, p.date_gmt) || new Date(), updatedAt: dt(p.modified, p.modified_gmt) || new Date(),
          }]);
          if (type === 'posts') await linkM2M('_PostToTerm', 'Post', [...(p.categories || []), ...(p.tags || [])].map((t) => [p.id, t]));
        }
      });
    }
    let comments = 0;
    await api.each('wp', 'comments', api.hasWpAuth ? { status: 'all' } : {}, async (items) => {
      const ids = new Set((await prisma.post.findMany({ where: { id: { in: items.map((c) => c.post) } }, select: { id: true } })).map((p) => p.id));
      comments += await insert('comment', items.filter((c) => ids.has(c.post)).map((c) => ({
        id: c.id, postId: c.post, parentId: c.parent || 0, authorId: c.author || 0, authorName: c.author_name || '', authorEmail: c.author_email || '',
        authorUrl: c.author_url || '', content: rendered(c.content).replace(/<\/?p>/g, '').trim(), status: c.status === 'approved' ? 'approved' : c.status || 'hold',
        createdAt: dt(c.date, c.date_gmt) || new Date(),
      })));
    }).catch((e) => log(`  ! comments: ${e.message}`));
    let menus = 0;
    if (api.hasWpAuth) {
      try {
        const { body: list } = await api.wp('menus', { per_page: 100 });
        for (const m of list) {
          menus += await insert('menu', [{ id: m.id, name: m.name, slug: m.slug, locations: m.locations || [] }]);
          await api.each('wp', 'menu-items', { menus: m.id }, async (items) => {
            await insert('menuItem', items.map((i) => ({
              id: i.id, menuId: m.id, parentId: i.parent || 0, title: rendered(i.title), url: i.url || '', type: i.type || 'custom', object: i.object || 'custom',
              objectId: i.object_id || 0, target: i.target || '', classes: (i.classes || []).filter(Boolean).join(' '), menuOrder: i.menu_order || 0,
            })));
          });
        }
      } catch (e) { log(`  ! menus: ${e.message}`); }
    }
    log(`  ${posts} posts/pages, ${terms} terms, ${comments} comments, ${menus} menus${api.hasWpAuth ? '' : ' (add an Application Password to import drafts, users and menus)'}`);
  }

  require('../../lib/cache').clear();
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function testConnection(opts) {
  const api = makeClient(opts);
  const out = { ok: true };
  const { body: idx } = await getJson(`${api.base}/wp-json/`);
  out.site_name = idx.name;
  out.namespaces = (idx.namespaces || []).filter((n) => /^(wc\/v3|wp\/v2|frontend-api)/.test(n));
  if (opts.consumerKey) {
    const r = await api.wc('products', { per_page: 1 });
    out.products = parseInt(r.headers['x-wp-total'], 10) || 0;
    const o = await api.wc('orders', { per_page: 1 }).catch(() => null);
    out.orders = o ? parseInt(o.headers['x-wp-total'], 10) || 0 : null;
    const c = await api.wc('customers', { per_page: 1, role: 'all' }).catch(() => null);
    out.customers = c ? parseInt(c.headers['x-wp-total'], 10) || 0 : null;
  }
  const p = await api.wp('posts', { per_page: 1 });
  out.posts = parseInt(p.headers['x-wp-total'], 10) || 0;
  const m = await api.wp('media', { per_page: 1 });
  out.media = parseInt(m.headers['x-wp-total'], 10) || 0;
  if (api.hasWpAuth) {
    const me = await api.wp('users/me', { context: 'edit' });
    out.wp_user = `${me.body.name} (${(me.body.roles || []).join(', ')})`;
  }
  return out;
}

module.exports = { run, testConnection, PHASES };
