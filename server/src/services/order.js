// Order creation/update with WooCommerce semantics:
// line items / shipping / fees / coupons → calculate_totals(), stock reduction, sales counts,
// coupon usage, status transition notes.
const crypto = require('crypto');
const prisma = require('../db');
const { ApiError, badRequest } = require('../lib/http');
const { round, bool, metaMerge, parseWpDate } = require('../lib/format');
const { isOnSale } = require('../serializers/product');
const tax = require('./tax');
const couponSvc = require('./coupon');

const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

const STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed', 'checkout-draft'];
const STATUS_LABELS = {
  pending: 'Pending payment', processing: 'Processing', 'on-hold': 'On hold', completed: 'Completed',
  cancelled: 'Cancelled', refunded: 'Refunded', failed: 'Failed', 'checkout-draft': 'Draft',
};
const PAID_STATUSES = ['processing', 'completed', 'on-hold'];
// Internal meta keys hidden from REST meta_data
const INTERNAL_META = ['_order_stock_reduced', '_recorded_sales', '_recorded_coupon_usage_counts'];

const ADDRESS_FIELDS = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country', 'email', 'phone'];
function normalizeAddress(input, existing, withEmail) {
  const out = {};
  for (const f of ADDRESS_FIELDS) {
    if (f === 'email' && !withEmail) continue;
    out[f] = input && has(input, f) ? String(input[f] ?? '') : (existing && existing[f]) || '';
  }
  return out;
}

const randomKey = (len) => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.randomBytes(len), (b) => chars[b % chars.length]).join('');
};

function getMeta(meta, key) {
  const m = Array.isArray(meta) ? meta.find((x) => x.key === key) : null;
  return m ? m.value : undefined;
}
function setMeta(meta, key, value) {
  const list = Array.isArray(meta) ? meta.filter((x) => x.key !== key) : [];
  if (value !== null && value !== undefined) list.push({ id: list.reduce((n, x) => Math.max(n, x.id || 0), 0) + 1, key, value });
  return list;
}

// ───────── Load products for line items ─────────
async function loadProductInfo(productId, variationId) {
  const id = variationId || productId;
  if (!id) return null;
  const p = await prisma.product.findUnique({
    where: { id },
    include: {
      parent: { include: { categories: { select: { id: true } } } },
      categories: { select: { id: true } },
      images: { include: { media: true }, orderBy: { position: 'asc' }, take: 1 },
    },
  });
  if (!p) return null;
  if (variationId && p.parentId !== productId && productId) {
    // tolerate mismatched parent like WC (it trusts variation_id)
  }
  return p;
}

// ───────── Build in-memory state from DB order ─────────
function stateFromOrder(order) {
  const st = { lines: [], shipping: [], fees: [], coupons: [], removed: [] };
  for (const it of order.items || []) {
    const base = { id: it.id, meta: it.meta || [], name: it.name };
    if (it.type === 'line_item') {
      st.lines.push({
        ...base, productId: it.productId || 0, variationId: it.variationId || 0, quantity: it.quantity, sku: it.sku,
        taxClass: it.taxClass, subtotal: num(it.subtotal), total: num(it.total), explicitSubtotal: true, explicitTotal: true,
      });
    } else if (it.type === 'shipping') {
      st.shipping.push({ ...base, methodId: it.methodId, instanceId: it.instanceId, total: num(it.total) });
    } else if (it.type === 'fee') {
      st.fees.push({ ...base, taxClass: it.taxClass, taxStatus: getMeta(it.meta, '_tax_status') || 'taxable', total: num(it.total) });
    } else if (it.type === 'coupon') {
      st.coupons.push({ ...base, code: it.code });
    }
  }
  return st;
}

// Apply REST payload arrays onto the state (WC semantics: id → update, no id → add, quantity 0 / product_id null → remove)
async function applyItems(st, body) {
  if (Array.isArray(body.line_items)) {
    for (const li of body.line_items) {
      const existing = li.id ? st.lines.find((l) => l.id === parseInt(li.id, 10)) : null;
      if (li.id && !existing) throw badRequest('woocommerce_rest_invalid_item_id', 'Order item ID provided is not associated with order.');
      const remove = existing && ((has(li, 'quantity') && parseInt(li.quantity, 10) === 0) || (has(li, 'product_id') && li.product_id === null));
      if (remove) {
        st.removed.push(existing.id);
        st.lines = st.lines.filter((l) => l !== existing);
        continue;
      }
      const line = existing || { productId: 0, variationId: 0, quantity: 1, meta: [], explicitSubtotal: false, explicitTotal: false };
      const productChanged = has(li, 'product_id') || has(li, 'variation_id') || has(li, 'sku');
      if (has(li, 'product_id')) line.productId = parseInt(li.product_id, 10) || 0;
      if (has(li, 'variation_id')) line.variationId = parseInt(li.variation_id, 10) || 0;
      if (!line.productId && !line.variationId && li.sku) {
        const bySku = await prisma.product.findFirst({ where: { sku: String(li.sku) } });
        if (bySku) {
          if (bySku.type === 'variation') { line.productId = bySku.parentId; line.variationId = bySku.id; } else line.productId = bySku.id;
        }
      }
      if (has(li, 'quantity')) line.quantity = Math.max(1, parseInt(li.quantity, 10) || 1);
      if (has(li, 'name')) { line.name = String(li.name); line.explicitName = true; }
      if (has(li, 'tax_class')) { line.taxClass = String(li.tax_class); line.explicitTaxClass = true; }
      if (has(li, 'subtotal')) { line.subtotal = num(li.subtotal); line.explicitSubtotal = true; } else if (!existing || productChanged || has(li, 'quantity')) line.explicitSubtotal = false;
      if (has(li, 'total')) { line.total = num(li.total); line.explicitTotal = true; } else if (!existing || productChanged || has(li, 'quantity')) line.explicitTotal = false;
      if (has(li, 'meta_data')) line.meta = metaMerge(line.meta, li.meta_data);
      if (!existing || productChanged) line.reload = true;
      if (!existing) st.lines.push(line);
    }
  }
  const simpleLines = (key, list, map) => {
    if (!Array.isArray(body[key])) return;
    for (const raw of body[key]) {
      const existing = raw.id ? list.find((l) => l.id === parseInt(raw.id, 10)) : null;
      if (raw.id && !existing) throw badRequest('woocommerce_rest_invalid_item_id', 'Order item ID provided is not associated with order.');
      const removeKey = key === 'shipping_lines' ? 'method_id' : key === 'fee_lines' ? 'name' : 'code';
      if (existing && has(raw, removeKey) && raw[removeKey] === null) {
        st.removed.push(existing.id);
        list.splice(list.indexOf(existing), 1);
        continue;
      }
      const line = existing || { meta: [] };
      map(line, raw);
      if (has(raw, 'meta_data')) line.meta = metaMerge(line.meta, raw.meta_data);
      if (!existing) list.push(line);
    }
  };
  simpleLines('shipping_lines', st.shipping, (l, r) => {
    if (has(r, 'method_id')) l.methodId = String(r.method_id);
    if (has(r, 'instance_id')) l.instanceId = String(r.instance_id);
    if (has(r, 'method_title')) l.name = String(r.method_title);
    if (has(r, 'total')) l.total = num(r.total);
    if (l.total === undefined) l.total = 0;
  });
  simpleLines('fee_lines', st.fees, (l, r) => {
    if (has(r, 'name')) l.name = String(r.name);
    if (has(r, 'tax_class')) l.taxClass = String(r.tax_class);
    if (has(r, 'tax_status')) l.taxStatus = String(r.tax_status);
    if (has(r, 'total')) l.total = num(r.total);
    if (l.total === undefined) l.total = 0;
    if (!l.taxStatus) l.taxStatus = 'taxable';
  });
  simpleLines('coupon_lines', st.coupons, (l, r) => {
    if (has(r, 'code')) l.code = String(r.code).trim().toLowerCase();
  });
}

function taxLocation(s, billing, shipping) {
  if (s.taxBasedOn === 'base') return s.base;
  const a = s.taxBasedOn === 'billing' || !shipping.country ? billing : shipping;
  return { country: a.country, state: a.state, postcode: a.postcode, city: a.city };
}

// ───────── calculate_totals() ─────────
async function calculate(st, ctx, s) {
  const loc = taxLocation(s, ctx.billing, ctx.shipping);
  const items = [];

  for (const line of st.lines) {
    if (line.reload || !line.product) {
      line.product = await loadProductInfo(line.productId, line.variationId);
      if (line.reload && !line.product && (line.productId || line.variationId)) {
        throw badRequest('woocommerce_rest_invalid_product_id', `Product ID ${line.variationId || line.productId} is invalid.`);
      }
    }
    const p = line.product;
    if (p && line.reload) {
      if (p.type === 'variation') { line.variationId = p.id; line.productId = p.parentId; } else line.productId = p.id;
      if (!line.explicitName) line.name = p.name;
      line.sku = p.sku || '';
      if (!line.explicitTaxClass) line.taxClass = p.taxClass;
      line.reload = false;
    }
    if (p && (p.type === 'variable' || p.type === 'grouped')) {
      throw badRequest('woocommerce_rest_invalid_product_id', `Product ID ${p.id} is a ${p.type} product. Use a variation ID.`);
    }
    const taxable = s.calcTaxes && (!p || p.taxStatus === 'taxable');
    const rates = taxable ? await tax.findRates(loc, line.taxClass) : [];
    if (!line.explicitSubtotal) {
      let sub = num(p ? p.price : 0) * line.quantity;
      if (ctx.pricesIncludeTax && rates.length) sub -= tax.sumTaxes(tax.calcTax(sub, rates, true));
      line.subtotal = round(sub, s.dp + 2);
    }
    const categoryIds = p ? [...(p.categories || []), ...((p.parent && p.parent.categories) || [])].map((c) => c.id) : [];
    items.push({
      line, rates, quantity: line.quantity, subtotal: line.subtotal, discount: 0,
      productId: line.productId, variationId: line.variationId, categoryIds, onSale: p ? isOnSale(p) : false,
    });
  }

  // Coupons
  const couponRows = [];
  for (const c of st.coupons) {
    const coupon = await couponSvc.getCouponByCode(c.code);
    if (c.isNew !== false && !c.id) {
      await couponSvc.validateCoupon(coupon, {
        items, subtotal: items.reduce((n, i) => n + i.subtotal, 0), customerId: ctx.customerId, email: ctx.billing.email, enabled: s.couponsEnabled, code: c.code,
      });
    }
    couponRows.push({ state: c, coupon });
  }
  const hasCoupons = couponRows.some((r) => r.coupon);
  const couponTotals = hasCoupons
    ? couponSvc.applyCoupons(couponRows.filter((r) => r.coupon).map((r) => r.coupon), items, { dp: s.dp, sequential: s.sequentialDiscounts })
    : {};

  const taxTotals = {}; // rateId → { item, shipping }
  const addTax = (taxes, kind) => {
    for (const [id, amt] of Object.entries(taxes)) {
      taxTotals[id] = taxTotals[id] || { item: 0, shipping: 0 };
      taxTotals[id][kind] += amt;
    }
  };

  for (const it of items) {
    const { line } = it;
    if (hasCoupons || !line.explicitTotal) line.total = round(Math.max(0, line.subtotal - it.discount), s.dp + 2);
    const subTaxes = tax.calcTax(line.subtotal, it.rates);
    const totTaxes = tax.calcTax(line.total, it.rates);
    line.subtotalTax = round(tax.sumTaxes(subTaxes), s.dp);
    line.totalTax = round(tax.sumTaxes(totTaxes), s.dp);
    line.taxes = Object.keys(totTaxes).map((id) => ({ id: Number(id), total: String(round(totTaxes[id], s.dp + 2)), subtotal: String(round(subTaxes[id] || 0, s.dp + 2)) }));
    line.price = line.quantity ? line.subtotal / line.quantity : 0;
    addTax(totTaxes, 'item');
  }

  for (const f of st.fees) {
    const rates = s.calcTaxes && f.taxStatus === 'taxable' ? await tax.findRates(loc, f.taxClass) : [];
    const taxes = tax.calcTax(f.total, rates);
    f.totalTax = round(tax.sumTaxes(taxes), s.dp);
    f.taxes = Object.keys(taxes).map((id) => ({ id: Number(id), total: String(round(taxes[id], s.dp + 2)), subtotal: '' }));
    addTax(taxes, 'item');
  }

  const shipRates = s.calcTaxes ? await tax.findShippingRates(loc, s.shippingTaxClass, items.map((i) => i.line.taxClass)) : [];
  for (const sh of st.shipping) {
    const taxes = tax.calcTax(sh.total, shipRates);
    sh.totalTax = round(tax.sumTaxes(taxes), s.dp);
    sh.taxes = Object.keys(taxes).map((id) => ({ id: Number(id), total: String(round(taxes[id], s.dp + 2)), subtotal: '' }));
    addTax(taxes, 'shipping');
  }

  // Coupon lines
  const discountTaxTotal = items.reduce((n, i) => n + (i.line.subtotalTax - i.line.totalTax), 0);
  const discountTotal = items.reduce((n, i) => n + (i.line.subtotal - i.line.total), 0);
  for (const r of couponRows) {
    const d = r.coupon ? couponTotals[r.coupon.code] || 0 : 0;
    r.state.discount = round(d, s.dp);
    r.state.discountTax = discountTotal > 0 ? round((d / discountTotal) * discountTaxTotal, s.dp) : 0;
    r.state.couponId = r.coupon ? r.coupon.id : null;
    r.state.discountType = r.coupon ? r.coupon.discountType : 'fixed_cart';
    r.state.nominalAmount = r.coupon ? Number(r.coupon.amount) : 0;
    r.state.freeShipping = r.coupon ? r.coupon.freeShipping : false;
  }

  // Tax lines
  const rateRows = Object.keys(taxTotals).length
    ? await prisma.taxRate.findMany({ where: { id: { in: Object.keys(taxTotals).map(Number) } } })
    : [];
  const taxLines = rateRows.map((r) => ({
    rateId: r.id,
    rateCode: [r.country, r.state, r.name || 'TAX', r.priority].filter((x) => x !== '').join('-').toUpperCase(),
    label: r.name || 'Tax',
    compound: r.compound,
    ratePercent: Number(r.rate),
    taxTotal: round(taxTotals[r.id].item, s.dp),
    shippingTaxTotal: round(taxTotals[r.id].shipping, s.dp),
  }));

  const sumLines = items.reduce((n, i) => n + i.line.total, 0);
  const fees = st.fees.reduce((n, f) => n + f.total, 0);
  const shippingTotal = st.shipping.reduce((n, sh) => n + sh.total, 0);
  const cartTax = round(taxLines.reduce((n, t) => n + t.taxTotal, 0), s.dp);
  const shippingTax = round(taxLines.reduce((n, t) => n + t.shippingTaxTotal, 0), s.dp);

  return {
    taxLines,
    totals: {
      discountTotal: round(discountTotal, s.dp),
      discountTax: round(discountTaxTotal, s.dp),
      shippingTotal: round(shippingTotal, s.dp),
      shippingTax,
      cartTax,
      totalTax: round(cartTax + shippingTax, s.dp),
      total: round(Math.max(0, sumLines + fees + shippingTotal + cartTax + shippingTax), s.dp),
    },
  };
}

// ───────── Persist ─────────
function itemRows(st, taxLines) {
  const lines = st.lines.map((l) => ({
    id: l.id, type: 'line_item', name: l.name || '', productId: l.productId || null, variationId: l.variationId || null,
    quantity: l.quantity, sku: l.sku || '', price: l.price || 0, taxClass: l.taxClass || '',
    subtotal: l.subtotal, subtotalTax: l.subtotalTax || 0, total: l.total, totalTax: l.totalTax || 0, taxes: l.taxes || [], meta: l.meta || [],
  }));
  const shipping = st.shipping.map((sh) => ({
    id: sh.id, type: 'shipping', name: sh.name || '', methodId: sh.methodId || '', instanceId: sh.instanceId || '',
    total: sh.total, totalTax: sh.totalTax || 0, taxes: sh.taxes || [], meta: sh.meta || [],
  }));
  const fees = st.fees.map((f) => ({
    id: f.id, type: 'fee', name: f.name || '', taxClass: f.taxClass || '', total: f.total, totalTax: f.totalTax || 0,
    taxes: f.taxes || [], meta: setMeta(f.meta, '_tax_status', f.taxStatus || 'taxable'),
  }));
  const coupons = st.coupons.map((c) => ({
    id: c.id, type: 'coupon', name: c.code, code: c.code, discount: c.discount || 0, discountTax: c.discountTax || 0,
    meta: setMeta(c.meta, 'coupon_info', [c.couponId || 0, c.code, c.discountType || 'fixed_cart', c.nominalAmount || 0, !!c.freeShipping]),
  }));
  const taxes = taxLines.map((t) => ({
    type: 'tax', name: t.rateCode, rateId: t.rateId, rateCode: t.rateCode, ratePercent: t.ratePercent, compound: t.compound,
    total: t.taxTotal, shippingTaxTotal: t.shippingTaxTotal, meta: [{ id: 1, key: 'label', value: t.label }],
  }));
  return [...lines, ...shipping, ...fees, ...coupons, ...taxes];
}

async function addNote(orderId, note, { customerNote = false, author = 'system', tx = prisma } = {}) {
  return tx.orderNote.create({ data: { orderId, note, customerNote, author } });
}

// Reduce stock for paid orders (wc_maybe_reduce_stock_levels)
async function reduceStock(tx, order, parents) {
  const changes = [];
  for (const it of order.items.filter((i) => i.type === 'line_item')) {
    let target = it.variationId ? await tx.product.findUnique({ where: { id: it.variationId } }) : null;
    if (target && !target.manageStock) target = null; // variation inherits parent stock
    if (!target && it.productId) target = await tx.product.findUnique({ where: { id: it.productId } });
    if (!target || !target.manageStock) continue;
    const newQty = (target.stockQuantity || 0) - it.quantity;
    await tx.product.update({
      where: { id: target.id },
      data: { stockQuantity: { decrement: it.quantity }, stockStatus: newQty > 0 ? 'instock' : target.backorders !== 'no' ? 'onbackorder' : 'outofstock' },
    });
    changes.push(`${it.name}${it.sku ? ` (${it.sku})` : ''} ${target.stockQuantity}&rarr;${newQty}`);
    if (target.parentId) parents.add(target.parentId);
  }
  if (changes.length) await addNote(order.id, `Stock levels reduced: ${changes.join(', ')}`, { tx });
}

async function restoreStock(tx, order, parents) {
  const changes = [];
  for (const it of order.items.filter((i) => i.type === 'line_item')) {
    let target = it.variationId ? await tx.product.findUnique({ where: { id: it.variationId } }) : null;
    if (target && !target.manageStock) target = null;
    if (!target && it.productId) target = await tx.product.findUnique({ where: { id: it.productId } });
    if (!target || !target.manageStock) continue;
    const newQty = (target.stockQuantity || 0) + it.quantity;
    await tx.product.update({
      where: { id: target.id },
      data: { stockQuantity: { increment: it.quantity }, stockStatus: newQty > 0 ? 'instock' : target.backorders !== 'no' ? 'onbackorder' : 'outofstock' },
    });
    changes.push(`${it.name}${it.sku ? ` (${it.sku})` : ''} ${target.stockQuantity}&rarr;${newQty}`);
    if (target.parentId) parents.add(target.parentId);
  }
  if (changes.length) await addNote(order.id, `Stock levels increased: ${changes.join(', ')}`, { tx });
}

// Side effects when status changes (stock, total_sales, coupon usage, dates, notes)
async function onStatusChange(orderId, from, to, { note = '', silent = false } = {}) {
  const parents = new Set();
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    let meta = order.meta || [];
    const data = {};

    if (PAID_STATUSES.includes(to)) {
      if (!getMeta(meta, '_order_stock_reduced')) {
        await reduceStock(tx, order, parents);
        meta = setMeta(meta, '_order_stock_reduced', 'yes');
      }
      if (!getMeta(meta, '_recorded_sales')) {
        for (const it of order.items.filter((i) => i.type === 'line_item' && i.productId)) {
          await tx.product.updateMany({ where: { id: it.productId }, data: { totalSales: { increment: it.quantity } } });
        }
        meta = setMeta(meta, '_recorded_sales', 'yes');
      }
      if (!getMeta(meta, '_recorded_coupon_usage_counts')) {
        await changeCouponUsage(tx, order, +1);
        meta = setMeta(meta, '_recorded_coupon_usage_counts', 'yes');
      }
      if (order.customerId) await tx.user.updateMany({ where: { id: order.customerId }, data: { isPayingCustomer: true } });
      if (!order.datePaid && to !== 'on-hold') data.datePaid = new Date();
    }
    if (['cancelled', 'pending', 'failed'].includes(to)) {
      if (getMeta(meta, '_order_stock_reduced')) {
        await restoreStock(tx, order, parents);
        meta = setMeta(meta, '_order_stock_reduced', null);
      }
      if (to === 'cancelled' && getMeta(meta, '_recorded_coupon_usage_counts')) {
        await changeCouponUsage(tx, order, -1);
        meta = setMeta(meta, '_recorded_coupon_usage_counts', null);
      }
    }
    if (to === 'completed' && !order.dateCompleted) data.dateCompleted = new Date();

    await tx.order.update({ where: { id: orderId }, data: { ...data, meta } });
    if (!silent && from !== to) {
      await addNote(orderId, `${note ? `${note} ` : ''}Order status changed from ${STATUS_LABELS[from] || from} to ${STATUS_LABELS[to] || to}.`, { tx });
    }
  });
  // Variable parents' stock status must reflect variation stock (after commit)
  const { syncVariableParent } = require('./product');
  for (const id of parents) await syncVariableParent(id);
  await require('./order-stats').syncOrderSafe(orderId);
  // WooCommerce emails for this transition (queued, sent in the background)
  if (!silent && from !== to) await require('./email/triggers').orderStatusChanged(orderId, from, to);
}

// Coupon usage is one CouponUsage row per use (indexed), plus an atomic counter on the coupon
async function changeCouponUsage(tx, order, delta) {
  const who = order.customerId ? String(order.customerId) : String((order.billing && order.billing.email) || '').toLowerCase();
  for (const it of order.items.filter((i) => i.type === 'coupon')) {
    const coupon = await tx.coupon.findUnique({ where: { code: it.code }, select: { id: true, usageCount: true } });
    if (!coupon) continue;
    if (delta > 0) {
      await tx.couponUsage.create({ data: { couponId: coupon.id, usedBy: who, orderId: order.id } });
      await tx.coupon.update({ where: { id: coupon.id }, data: { usageCount: { increment: 1 } } });
    } else {
      const row = await tx.couponUsage.findFirst({ where: { couponId: coupon.id, orderId: order.id } })
        || await tx.couponUsage.findFirst({ where: { couponId: coupon.id, usedBy: who } });
      if (row) await tx.couponUsage.delete({ where: { id: row.id } });
      if (coupon.usageCount > 0) await tx.coupon.update({ where: { id: coupon.id }, data: { usageCount: { decrement: 1 } } });
    }
  }
}

// ───────── Public: create / update ─────────
async function saveOrder(body, s, existing = null, req = null) {
  const isNew = !existing;
  if (has(body, 'status') && !STATUSES.includes(body.status)) throw badRequest('rest_invalid_param', 'Invalid parameter(s): status');

  const billing = normalizeAddress(body.billing, existing?.billing, true);
  const shipping = normalizeAddress(body.shipping, existing?.shipping, false);
  if (billing.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(billing.email)) throw badRequest('rest_invalid_param', 'Invalid billing email address.');

  let customerId = existing ? existing.customerId : null;
  if (has(body, 'customer_id')) {
    const cid = parseInt(body.customer_id, 10) || 0;
    if (cid) {
      const u = await prisma.user.findUnique({ where: { id: cid } });
      if (!u) throw badRequest('woocommerce_rest_invalid_customer_id', 'Customer ID is invalid.');
    }
    customerId = cid || null;
  }

  const st = existing ? stateFromOrder(existing) : { lines: [], shipping: [], fees: [], coupons: [], removed: [] };
  await applyItems(st, body);
  for (const c of st.coupons) if (c.id) c.isNew = false;

  const itemsChanged = isNew || ['line_items', 'shipping_lines', 'fee_lines', 'coupon_lines'].some((k) => Array.isArray(body[k]));
  const pricesIncludeTax = existing ? existing.pricesIncludeTax : s.pricesIncludeTax;
  let calc = null;
  if (itemsChanged || has(body, 'billing') || has(body, 'shipping')) {
    calc = await calculate(st, { billing, shipping, customerId, pricesIncludeTax }, s);
  }

  const data = {
    billing, shipping, customerId,
  };
  const str = (k, f) => { if (has(body, k)) data[f] = String(body[k] ?? ''); };
  str('payment_method', 'paymentMethod');
  str('payment_method_title', 'paymentMethodTitle');
  str('transaction_id', 'transactionId');
  str('customer_note', 'customerNote');
  str('currency', 'currency');
  str('created_via', 'createdVia');
  str('customer_ip_address', 'customerIpAddress');
  str('customer_user_agent', 'customerUserAgent');
  if (has(body, 'parent_id')) data.parentId = parseInt(body.parent_id, 10) || 0;
  if (has(body, 'meta_data')) data.meta = metaMerge(existing?.meta, body.meta_data.filter((m) => !INTERNAL_META.includes(m.key)));
  if (has(body, 'date_created_gmt')) data.createdAt = parseWpDate(body.date_created_gmt, true) || undefined;
  else if (has(body, 'date_created')) data.createdAt = parseWpDate(body.date_created, false, s.gmtOffset) || undefined;
  if (has(body, 'date_paid_gmt')) data.datePaid = parseWpDate(body.date_paid_gmt, true);
  if (has(body, 'date_completed_gmt')) data.dateCompleted = parseWpDate(body.date_completed_gmt, true);
  if (calc) Object.assign(data, calc.totals);

  if (isNew) {
    data.orderKey = `wc_order_${randomKey(13)}`;
    data.status = 'pending';
    data.currency = data.currency || s.currency;
    data.pricesIncludeTax = pricesIncludeTax;
    data.version = '9.0.0';
    if (!data.customerIpAddress && req) data.customerIpAddress = req.ip || '';
    if (!data.customerUserAgent && req) data.customerUserAgent = req.get('user-agent') || '';
  }

  const orderId = await prisma.$transaction(async (tx) => {
    const order = isNew ? await tx.order.create({ data }) : await tx.order.update({ where: { id: existing.id }, data });
    if (isNew) {
      // Order number: order ID, or the configured format/counter (Plugins → Order Numbers)
      const number = await require('./ordernumbers').assignNumber(tx, order);
      await tx.order.update({ where: { id: order.id }, data: { number } });
    }
    if (calc) {
      const rows = itemRows(st, calc.taxLines);
      // Tax lines are always rebuilt; removed items deleted; others updated or created.
      await tx.orderItem.deleteMany({ where: { orderId: order.id, OR: [{ type: 'tax' }, { id: { in: st.removed } }] } });
      for (const r of rows) {
        const { id, ...rest } = r;
        if (id) await tx.orderItem.update({ where: { id }, data: rest });
        else await tx.orderItem.create({ data: { ...rest, orderId: order.id } });
      }
    }
    return order.id;
  });

  // Status / payment handling
  const fromStatus = existing ? existing.status : 'pending';
  let toStatus = has(body, 'status') ? body.status : fromStatus;
  if (bool(body.set_paid)) {
    const needsProcessing = st.lines.some((l) => !l.product || !(l.product.virtual && l.product.downloadable));
    toStatus = needsProcessing ? 'processing' : 'completed';
    await prisma.order.update({ where: { id: orderId }, data: { datePaid: new Date() } });
  }
  if (toStatus !== fromStatus) {
    await prisma.order.update({ where: { id: orderId }, data: { status: toStatus } });
    await onStatusChange(orderId, fromStatus, toStatus); // also refreshes analytics
  } else {
    await require('./order-stats').syncOrderSafe(orderId);
  }
  return orderId;
}

async function refundOrder(order, body, s, req) {
  const amount = num(body.amount);
  const refunded = (order.refunds || []).reduce((n, r) => n + num(r.amount), 0);
  const remaining = round(num(order.total) - refunded, s.dp);
  if (amount <= 0) throw badRequest('woocommerce_rest_invalid_order_refund', 'Refund amount must be greater than zero.');
  if (amount > remaining) throw badRequest('woocommerce_rest_invalid_order_refund', 'Invalid refund amount.');
  if (bool(body.api_refund)) {
    // Gateway refunds are not automated yet — record only.
  }
  const refund = await prisma.orderRefund.create({
    data: {
      orderId: order.id, amount, reason: String(body.reason || ''), refundedBy: req && req.user ? req.user.id : 0,
      refundedPayment: false, lineItems: Array.isArray(body.line_items) ? body.line_items : [],
    },
  });
  // Restock refunded line items if requested
  if (bool(body.api_restock ?? true) && Array.isArray(body.line_items)) {
    for (const li of body.line_items) {
      const item = order.items.find((i) => i.id === parseInt(li.id, 10));
      const qty = parseInt(li.quantity, 10) || 0;
      if (!item || qty <= 0) continue;
      const target = await prisma.product.findUnique({ where: { id: item.variationId || item.productId || 0 } });
      if (target && target.manageStock) {
        await prisma.product.update({ where: { id: target.id }, data: { stockQuantity: { increment: qty } } });
      }
    }
  }
  await addNote(order.id, `Refunded ${amount.toFixed(s.dp)}${body.reason ? ` – ${body.reason}` : ''}`);
  if (round(remaining - amount, s.dp) <= 0 && order.status !== 'refunded') {
    await prisma.order.update({ where: { id: order.id }, data: { status: 'refunded' } });
    await onStatusChange(order.id, order.status, 'refunded', { note: 'Order fully refunded.' });
  } else {
    await require('./email/triggers').partialRefund(order.id, refund.id);
  }
  return refund;
}

// Computes totals without saving (for headless cart/checkout pages). Accepts the same body as POST /orders.
async function previewOrder(body, s) {
  const billing = normalizeAddress(body.billing, null, true);
  const shippingAddr = normalizeAddress(body.shipping, null, false);
  const st = { lines: [], shipping: [], fees: [], coupons: [], removed: [] };
  await applyItems(st, body);
  const customerId = parseInt(body.customer_id, 10) || null;
  const ctx = { billing, shipping: shippingAddr, customerId, pricesIncludeTax: s.pricesIncludeTax };

  // Shipping rates for the destination (before choosing a method)
  const { calculateRates } = require('./shipping');
  await calculate(st, ctx, s); // loads products + coupon discounts
  const dest = shippingAddr.country ? shippingAddr : billing;
  const subtotal = st.lines.reduce((n, l) => n + l.subtotal, 0);
  const discounted = st.lines.reduce((n, l) => n + l.total, 0);
  const freeShippingCoupon = (await Promise.all(st.coupons.map((c) => couponSvc.getCouponByCode(c.code)))).some((c) => c && c.freeShipping);
  const shippingRates = await calculateRates({
    destination: dest,
    items: st.lines.filter((l) => l.product && !l.product.virtual).map((l) => ({ product: l.product, quantity: l.quantity, lineTotal: l.subtotal })),
    subtotal,
    discountedSubtotal: discounted,
    freeShippingCoupon,
  });

  // If the client picked a rate_id, apply it as the shipping line
  if (body.shipping_rate_id) {
    const r = shippingRates.rates.find((x) => x.rate_id === body.shipping_rate_id);
    if (!r) throw badRequest('invalid_shipping_rate', 'The selected shipping method is not available for this address.');
    st.shipping = [{ methodId: r.method_id, instanceId: String(r.instance_id), name: r.label, total: r.cost, meta: [] }];
  }
  const calc = await calculate(st, ctx, s);
  const m = (v) => Number(v || 0).toFixed(s.dp);
  return {
    currency: s.currency,
    line_items: st.lines.map((l) => ({
      product_id: l.productId, variation_id: l.variationId, name: l.name, sku: l.sku, quantity: l.quantity,
      price: m(l.price), subtotal: m(l.subtotal), subtotal_tax: m(l.subtotalTax), total: m(l.total), total_tax: m(l.totalTax),
      in_stock: !l.product || l.product.stockStatus !== 'outofstock',
      stock_quantity: l.product && l.product.manageStock ? l.product.stockQuantity : null,
    })),
    coupon_lines: st.coupons.map((c) => ({ code: c.code, discount: m(c.discount), discount_tax: m(c.discountTax), free_shipping: !!c.freeShipping })),
    shipping_lines: st.shipping.map((sh) => ({ method_id: sh.methodId, instance_id: sh.instanceId, method_title: sh.name, total: m(sh.total), total_tax: m(sh.totalTax) })),
    fee_lines: st.fees.map((f) => ({ name: f.name, total: m(f.total), total_tax: m(f.totalTax) })),
    tax_lines: calc.taxLines.map((t) => ({ rate_id: t.rateId, rate_code: t.rateCode, label: t.label, tax_total: m(t.taxTotal), shipping_tax_total: m(t.shippingTaxTotal) })),
    shipping_zone: shippingRates.zone,
    shipping_rates: shippingRates.rates.map((r) => ({ ...r, cost: m(r.cost) })),
    totals: {
      subtotal: m(subtotal),
      discount_total: m(calc.totals.discountTotal),
      discount_tax: m(calc.totals.discountTax),
      shipping_total: m(calc.totals.shippingTotal),
      shipping_tax: m(calc.totals.shippingTax),
      fee_total: m(st.fees.reduce((n, f) => n + f.total, 0)),
      cart_tax: m(calc.totals.cartTax),
      total_tax: m(calc.totals.totalTax),
      total: m(calc.totals.total),
    },
  };
}

module.exports = { previewOrder, saveOrder, onStatusChange, addNote, refundOrder, STATUSES, STATUS_LABELS, INTERNAL_META, ApiError };
