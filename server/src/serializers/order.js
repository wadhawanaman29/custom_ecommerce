const prisma = require('../db');
const config = require('../config');
const { money, wpDate, wpDateGmt, metaOut, mediaUrl } = require('../lib/format');
const { symbol } = require('../lib/currency');

const API = `${config.siteUrl}/wp-json/wc/v3`;
const INTERNAL = ['_order_stock_reduced', '_recorded_sales', '_recorded_coupon_usage_counts', '_tax_status', 'coupon_info'];
const publicMeta = (meta) => metaOut((meta || []).filter((m) => !INTERNAL.includes(m.key)));

const orderInclude = {
  items: { orderBy: { id: 'asc' } },
  refunds: { orderBy: { id: 'desc' } },
};

// One query for line-item thumbnails + parent names across many orders
async function lineItemExtras(orders) {
  const ids = new Set();
  for (const o of orders) for (const it of o.items) if (it.type === 'line_item') { if (it.variationId) ids.add(it.variationId); if (it.productId) ids.add(it.productId); }
  if (!ids.size) return new Map();
  const products = await prisma.product.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, images: { include: { media: true }, orderBy: { position: 'asc' }, take: 1 } },
  });
  return new Map(products.map((p) => [p.id, p]));
}

function serializeOrder(o, s, extras = new Map()) {
  const dp = s.dp;
  const by = (t) => o.items.filter((i) => i.type === t);
  const taxesOut = (taxes, withSubtotal) => (Array.isArray(taxes) ? taxes.map((t) => (withSubtotal ? { id: t.id, total: t.total, subtotal: t.subtotal } : { id: t.id, total: t.total, subtotal: '' })) : []);
  const imageFor = (it) => {
    const p = extras.get(it.variationId) || extras.get(it.productId);
    let m = p && p.images[0] ? p.images[0].media : null;
    if (!m && it.variationId) { const parent = extras.get(it.productId); m = parent && parent.images[0] ? parent.images[0].media : null; }
    return { id: m ? m.id : '', src: m ? mediaUrl(m.path) : '' };
  };
  const needsPayment = ['pending', 'failed'].includes(o.status) && Number(o.total) > 0;

  return {
    id: o.id,
    parent_id: o.parentId,
    status: o.status,
    currency: o.currency,
    version: o.version,
    prices_include_tax: o.pricesIncludeTax,
    date_created: wpDate(o.createdAt, s.gmtOffset),
    date_created_gmt: wpDateGmt(o.createdAt),
    date_modified: wpDate(o.updatedAt, s.gmtOffset),
    date_modified_gmt: wpDateGmt(o.updatedAt),
    discount_total: money(o.discountTotal, dp),
    discount_tax: money(o.discountTax, dp),
    shipping_total: money(o.shippingTotal, dp),
    shipping_tax: money(o.shippingTax, dp),
    cart_tax: money(o.cartTax, dp),
    total: money(o.total, dp),
    total_tax: money(o.totalTax, dp),
    customer_id: o.customerId || 0,
    order_key: o.orderKey,
    billing: o.billing,
    shipping: o.shipping,
    payment_method: o.paymentMethod,
    payment_method_title: o.paymentMethodTitle,
    transaction_id: o.transactionId,
    customer_ip_address: o.customerIpAddress,
    customer_user_agent: o.customerUserAgent,
    created_via: o.createdVia,
    customer_note: o.customerNote,
    date_completed: wpDate(o.dateCompleted, s.gmtOffset),
    date_completed_gmt: wpDateGmt(o.dateCompleted),
    date_paid: wpDate(o.datePaid, s.gmtOffset),
    date_paid_gmt: wpDateGmt(o.datePaid),
    cart_hash: o.cartHash,
    number: o.number || String(o.id),
    meta_data: publicMeta(o.meta),
    line_items: by('line_item').map((it) => ({
      id: it.id,
      name: it.name,
      product_id: it.productId || 0,
      variation_id: it.variationId || 0,
      quantity: it.quantity,
      tax_class: it.taxClass,
      subtotal: money(it.subtotal, dp),
      subtotal_tax: money(it.subtotalTax, dp),
      total: money(it.total, dp),
      total_tax: money(it.totalTax, dp),
      taxes: taxesOut(it.taxes, true),
      meta_data: publicMeta(it.meta),
      sku: it.sku || null,
      price: Number(it.price),
      image: imageFor(it),
      parent_name: it.variationId && extras.get(it.productId) ? extras.get(it.productId).name : null,
    })),
    tax_lines: by('tax').map((it) => ({
      id: it.id,
      rate_code: it.rateCode,
      rate_id: it.rateId,
      label: ((it.meta || []).find((m) => m.key === 'label') || {}).value || it.name,
      compound: it.compound,
      tax_total: money(it.total, dp),
      shipping_tax_total: money(it.shippingTaxTotal, dp),
      rate_percent: Number(it.ratePercent),
      meta_data: [],
    })),
    shipping_lines: by('shipping').map((it) => ({
      id: it.id,
      method_title: it.name,
      method_id: it.methodId,
      instance_id: it.instanceId,
      total: money(it.total, dp),
      total_tax: money(it.totalTax, dp),
      taxes: taxesOut(it.taxes, false),
      meta_data: publicMeta(it.meta),
    })),
    fee_lines: by('fee').map((it) => ({
      id: it.id,
      name: it.name,
      tax_class: it.taxClass,
      tax_status: ((it.meta || []).find((m) => m.key === '_tax_status') || {}).value || 'taxable',
      amount: String(Number(it.total)),
      total: money(it.total, dp),
      total_tax: money(it.totalTax, dp),
      taxes: taxesOut(it.taxes, false),
      meta_data: publicMeta(it.meta),
    })),
    coupon_lines: by('coupon').map((it) => {
      const info = ((it.meta || []).find((m) => m.key === 'coupon_info') || {}).value || [];
      return {
        id: it.id,
        code: it.code,
        discount: money(it.discount, dp),
        discount_tax: money(it.discountTax, dp),
        meta_data: publicMeta(it.meta),
        discount_type: info[2] || 'fixed_cart',
        nominal_amount: Number(info[3] || 0),
        free_shipping: !!info[4],
      };
    }),
    refunds: (o.refunds || []).map((r) => ({ id: r.id, reason: r.reason, total: `-${money(r.amount, dp)}` })),
    payment_url: `${config.frontendUrl}/checkout/order-pay/${o.id}/?pay_for_order=true&key=${o.orderKey}`,
    is_editable: ['pending', 'on-hold', 'auto-draft', 'checkout-draft'].includes(o.status),
    needs_payment: needsPayment,
    needs_processing: true,
    currency_symbol: symbol(o.currency),
    _links: {
      self: [{ href: `${API}/orders/${o.id}` }],
      collection: [{ href: `${API}/orders` }],
      ...(o.customerId ? { customer: [{ href: `${API}/customers/${o.customerId}` }] } : {}),
    },
  };
}

async function serializeOrders(orders, s) {
  const extras = await lineItemExtras(orders);
  return orders.map((o) => serializeOrder(o, s, extras));
}

function serializeNote(n, s, orderId) {
  return {
    id: n.id,
    author: n.author,
    date_created: wpDate(n.createdAt, s.gmtOffset),
    date_created_gmt: wpDateGmt(n.createdAt),
    note: n.note,
    customer_note: n.customerNote,
    _links: {
      self: [{ href: `${API}/orders/${orderId}/notes/${n.id}` }],
      collection: [{ href: `${API}/orders/${orderId}/notes` }],
      up: [{ href: `${API}/orders/${orderId}` }],
    },
  };
}

function serializeRefund(r, s, orderId) {
  return {
    id: r.id,
    date_created: wpDate(r.createdAt, s.gmtOffset),
    date_created_gmt: wpDateGmt(r.createdAt),
    amount: money(r.amount, s.dp),
    reason: r.reason,
    refunded_by: r.refundedBy,
    refunded_payment: r.refundedPayment,
    meta_data: [],
    line_items: Array.isArray(r.lineItems) ? r.lineItems : [],
    _links: {
      self: [{ href: `${API}/orders/${orderId}/refunds/${r.id}` }],
      collection: [{ href: `${API}/orders/${orderId}/refunds` }],
      up: [{ href: `${API}/orders/${orderId}` }],
    },
  };
}

module.exports = { orderInclude, serializeOrders, serializeNote, serializeRefund };
