// Maintains the analytics lookup tables (OrderStats, OrderProductLookup, OrderCouponLookup)
// and the denormalised billing search columns on Order.
//   syncOrder(id)   — after any order create/update/status change/refund
//   rebuildAll(log) — after imports; processes orders in batches so memory stays flat
const prisma = require('../db');

const n = (v) => (v === null || v === undefined ? 0 : Number(v));
const billingCols = (b) => {
  const bill = b && typeof b === 'object' ? b : {};
  return {
    billingEmail: String(bill.email || '').toLowerCase().slice(0, 191),
    billingName: [bill.first_name, bill.last_name].filter(Boolean).join(' ').slice(0, 255),
    billingPhone: String(bill.phone || '').slice(0, 50),
  };
};

function rowsFor(order, returning) {
  const lines = order.items.filter((i) => i.type === 'line_item');
  const coupons = order.items.filter((i) => i.type === 'coupon' && i.code);
  return {
    stats: {
      orderId: order.id,
      status: order.status,
      createdAt: order.createdAt,
      customerId: order.customerId || null,
      numItemsSold: lines.reduce((a, l) => a + l.quantity, 0),
      netTotal: n(order.total) - n(order.totalTax) - n(order.shippingTotal),
      discountTotal: n(order.discountTotal),
      taxTotal: n(order.totalTax),
      shippingTotal: n(order.shippingTotal),
      total: n(order.total),
      returningCustomer: !!returning,
    },
    products: lines.filter((l) => l.productId).map((l) => ({
      orderItemId: l.id,
      orderId: order.id,
      productId: l.productId,
      variationId: l.variationId || 0,
      customerId: order.customerId || null,
      status: order.status,
      createdAt: order.createdAt,
      quantity: l.quantity,
      netRevenue: n(l.total),
      couponAmount: Math.max(0, n(l.subtotal) - n(l.total)),
    })),
    coupons: [...new Map(coupons.map((c) => [c.code, c])).values()].map((c) => ({
      orderId: order.id, code: c.code, status: order.status, createdAt: order.createdAt, discount: n(c.discount),
    })),
  };
}

const ITEM_SELECT = { select: { id: true, type: true, productId: true, variationId: true, quantity: true, subtotal: true, total: true, code: true, discount: true } };

// Has this customer (by ID, or billing email for guests) placed an earlier order?
async function isReturning(order, email) {
  if (order.customerId) {
    return !!(await prisma.order.findFirst({ where: { customerId: order.customerId, id: { lt: order.id }, status: { notIn: ['trash', 'checkout-draft'] } }, select: { id: true } }));
  }
  if (!email) return false;
  return !!(await prisma.order.findFirst({ where: { billingEmail: email, id: { lt: order.id }, status: { notIn: ['trash', 'checkout-draft'] } }, select: { id: true } }));
}

async function syncOrder(orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: ITEM_SELECT } });
  if (!order) return; // deleted → lookups cascade
  const cols = billingCols(order.billing);
  if (cols.billingEmail !== order.billingEmail || cols.billingName !== order.billingName || cols.billingPhone !== order.billingPhone) {
    await prisma.order.update({ where: { id: orderId }, data: cols });
  }
  const r = rowsFor(order, await isReturning(order, cols.billingEmail));
  await prisma.$transaction([
    prisma.orderStats.upsert({ where: { orderId }, create: r.stats, update: r.stats }),
    prisma.orderProductLookup.deleteMany({ where: { orderId } }),
    prisma.orderProductLookup.createMany({ data: r.products }),
    prisma.orderCouponLookup.deleteMany({ where: { orderId } }),
    prisma.orderCouponLookup.createMany({ data: r.coupons }),
  ]);
}

// Fire-and-forget wrapper: analytics must never break checkout/order saving
function syncOrderSafe(orderId) {
  return syncOrder(orderId).catch((e) => console.error(`order-stats sync failed for #${orderId}:`, e.message));
}

// Rebuild everything (or from a given order ID) in batches of `size`
async function rebuildAll(log = () => {}, { fromId = 0, size = 500 } = {}) {
  let lastId = fromId;
  let done = 0;
  // Full rebuild: "returning" is decided in ID order with in-memory sets of customer IDs/emails
  // (one small entry per customer). Partial rebuild (fromId > 0): ask the DB per order instead.
  const seenCustomers = new Set();
  const seenEmails = new Set();
  const partial = fromId > 0;
  for (;;) {
    const orders = await prisma.order.findMany({ where: { id: { gt: lastId } }, orderBy: { id: 'asc' }, take: size, include: { items: ITEM_SELECT } });
    if (!orders.length) break;
    const ids = orders.map((o) => o.id);
    const stats = [];
    const products = [];
    const coupons = [];
    const billingUpdates = [];
    for (const o of orders) {
      const cols = billingCols(o.billing);
      if (cols.billingEmail !== o.billingEmail || cols.billingName !== o.billingName || cols.billingPhone !== o.billingPhone) billingUpdates.push({ id: o.id, ...cols });
      const counted = !['trash', 'checkout-draft'].includes(o.status);
      let returning = false;
      if (partial) returning = await isReturning(o, cols.billingEmail);
      else if (o.customerId) { returning = seenCustomers.has(o.customerId); if (counted) seenCustomers.add(o.customerId); } else if (cols.billingEmail) { returning = seenEmails.has(cols.billingEmail); if (counted) seenEmails.add(cols.billingEmail); }
      const r = rowsFor(o, returning);
      stats.push(r.stats);
      products.push(...r.products);
      coupons.push(...r.coupons);
    }
    for (const b of billingUpdates) {
      const { id, ...data } = b;
      await prisma.order.update({ where: { id }, data });
    }
    await prisma.$transaction([
      prisma.orderStats.deleteMany({ where: { orderId: { in: ids } } }),
      prisma.orderStats.createMany({ data: stats }),
      prisma.orderProductLookup.deleteMany({ where: { orderId: { in: ids } } }),
      prisma.orderProductLookup.createMany({ data: products }),
      prisma.orderCouponLookup.deleteMany({ where: { orderId: { in: ids } } }),
      prisma.orderCouponLookup.createMany({ data: coupons }),
    ]);
    done += orders.length;
    lastId = ids[ids.length - 1];
    if (done % 5000 < size) log(`  analytics: ${done} orders indexed (up to #${lastId})`);
  }
  log(`  analytics: ${done} orders indexed`);
  return done;
}

module.exports = { syncOrder, syncOrderSafe, rebuildAll, billingCols };
