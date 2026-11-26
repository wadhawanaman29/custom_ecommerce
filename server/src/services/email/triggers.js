// Which status changes send which WooCommerce email (mirrors WC_Emails hooks).
const prisma = require('../../db');
const { queue } = require('./mailer');

const PENDING_LIKE = ['pending', 'failed', 'cancelled', 'checkout-draft'];

async function orderStatusChanged(orderId, from, to) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, billing: true, billingEmail: true, meta: true } });
  if (!order) return;
  const email = order.billingEmail || (order.billing && order.billing.email) || '';
  const meta = Array.isArray(order.meta) ? order.meta : [];
  const jobs = [];
  // Admin "New order" — once per order, when it first becomes paid/on-hold
  if (['processing', 'completed', 'on-hold'].includes(to) && PENDING_LIKE.includes(from) && !meta.some((m) => m.key === '_new_order_email_sent')) {
    jobs.push(['new_order', {}]);
    await prisma.order.update({ where: { id: orderId }, data: { meta: [...meta, { id: 9010, key: '_new_order_email_sent', value: 'yes' }] } });
  }
  if (to === 'processing' && [...PENDING_LIKE, 'on-hold'].includes(from)) jobs.push(['customer_processing_order', { to: email }]);
  if (to === 'on-hold' && PENDING_LIKE.includes(from)) jobs.push(['customer_on_hold_order', { to: email }]);
  if (to === 'completed') jobs.push(['customer_completed_order', { to: email }]);
  if (to === 'cancelled' && ['processing', 'on-hold'].includes(from)) jobs.push(['cancelled_order', {}]);
  if (to === 'failed' && ['pending', 'on-hold'].includes(from)) jobs.push(['failed_order', {}]);
  if (to === 'refunded') jobs.push(['customer_refunded_order', { to: email, data: { partial: false } }]);
  for (const [template, opts] of jobs) {
    if (template.startsWith('customer_') && !opts.to) continue;
    await queue(template, { ...opts, orderId });
  }
}

async function partialRefund(orderId, refundId) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { billingEmail: true, billing: true } });
  const email = order && (order.billingEmail || (order.billing && order.billing.email));
  if (email) await queue('customer_refunded_order', { to: email, orderId, data: { partial: true, refund_id: refundId } });
}

async function customerNote(orderId, note) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { billingEmail: true, billing: true } });
  const email = order && (order.billingEmail || (order.billing && order.billing.email));
  if (email) await queue('customer_note', { to: email, orderId, data: { note } });
}

async function newAccount(user) {
  if (user && user.email) await queue('customer_new_account', { to: user.email, userId: user.id });
}

// Never let email problems break order flows
const safe = (fn) => (...args) => fn(...args).catch((e) => console.error('email trigger failed:', e.message));

module.exports = {
  orderStatusChanged: safe(orderStatusChanged), partialRefund: safe(partialRefund), customerNote: safe(customerNote), newAccount: safe(newAccount),
};
