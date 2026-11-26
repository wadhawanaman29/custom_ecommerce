// WooCommerce transactional emails: same IDs, default subjects/headings, placeholders and settings
// (option "woocommerce_<id>_settings": enabled, recipient, subject, heading, additional_content).
const prisma = require('../../db');
const options = require('../../lib/options');
const config = require('../../config');
const { formatAmount, symbol } = require('../../lib/currency');

const EMAILS = {
  new_order: { title: 'New order', admin: true, subject: '[{site_title}]: New order #{order_number}', heading: 'New Order: #{order_number}', description: 'Sent to the store when a new order is received (paid or on hold).' },
  cancelled_order: { title: 'Cancelled order', admin: true, subject: '[{site_title}]: Order #{order_number} has been cancelled', heading: 'Order Cancelled: #{order_number}', description: 'Sent to the store when a processing/on-hold order is cancelled.' },
  failed_order: { title: 'Failed order', admin: true, subject: '[{site_title}]: Order #{order_number} has failed', heading: 'Order Failed: #{order_number}', description: 'Sent to the store when a payment fails.' },
  customer_on_hold_order: { title: 'Order on-hold', subject: 'Your {site_title} order has been received!', heading: 'Thank you for your order', description: 'Sent to customers when their order is placed on hold.' },
  customer_processing_order: { title: 'Processing order', subject: 'Your {site_title} order has been received!', heading: 'Thank you for your order', description: 'Sent to customers after payment (order processing).' },
  customer_completed_order: { title: 'Completed order', subject: 'Your {site_title} order is now complete', heading: 'Thanks for shopping with us', description: 'Sent to customers when the order is marked completed.' },
  customer_refunded_order: { title: 'Refunded order', subject: 'Your {site_title} order #{order_number} has been refunded', heading: 'Order Refunded: {order_number}', description: 'Sent to customers when an order is (partially) refunded.' },
  customer_invoice: { title: 'Customer invoice / Order details', manual: true, subject: 'Invoice for order #{order_number} on {site_title}', heading: 'Invoice for order #{order_number}', description: 'Sent manually from the order screen.' },
  customer_note: { title: 'Customer note', subject: 'Note added to your {site_title} order from {order_date}', heading: 'A note has been added to your order', description: 'Sent when you add a note to the customer on an order.' },
  customer_reset_password: { title: 'Reset password', subject: 'Password Reset Request for {site_title}', heading: 'Password Reset Request', description: 'Sent when a customer requests a password reset.' },
  customer_new_account: { title: 'New account', subject: 'Your {site_title} account has been created!', heading: 'Welcome to {site_title}', description: 'Sent when a customer account is created.' },
};

async function emailSettings(id) {
  const def = EMAILS[id];
  const raw = (await options.getOption(`woocommerce_${id}_settings`, null)) || {};
  const adminEmail = await options.getOption('admin_email');
  return {
    id,
    title: def.title,
    description: def.description,
    manual: !!def.manual,
    is_customer_email: !def.admin,
    enabled: def.manual ? true : (raw.enabled || 'yes') === 'yes',
    recipient: def.admin ? (raw.recipient || adminEmail || '') : '',
    subject: raw.subject || '',
    heading: raw.heading || '',
    additional_content: raw.additional_content ?? '',
    default_subject: def.subject,
    default_heading: def.heading,
  };
}

async function saveEmailSettings(id, body) {
  const current = (await options.getOption(`woocommerce_${id}_settings`, null)) || {};
  const next = { ...current, email_type: 'html' };
  if (body.enabled !== undefined) next.enabled = body.enabled === true || body.enabled === 'yes' ? 'yes' : 'no';
  for (const k of ['recipient', 'subject', 'heading', 'additional_content']) if (body[k] !== undefined) next[k] = String(body[k]);
  await options.setOption(`woocommerce_${id}_settings`, next);
  return emailSettings(id);
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = (s) => String(s || '').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&euro;/g, '€').replace(/&pound;/g, '£').replace(/&yen;/g, '¥').replace(/&nbsp;/g, ' ');

async function look() {
  const o = await options.getOptions(['blogname', 'woocommerce_email_header_image', 'woocommerce_email_footer_text', 'woocommerce_email_base_color', 'woocommerce_email_background_color', 'woocommerce_email_body_background_color', 'woocommerce_email_text_color']);
  const s = await options.store();
  return { ...o, store: s };
}

function placeholders(text, ctx) {
  return String(text || '')
    .replace(/\{site_title\}/g, ctx.siteTitle)
    .replace(/\{site_address\}/g, config.frontendUrl.replace(/^https?:\/\//, ''))
    .replace(/\{site_url\}/g, config.frontendUrl)
    .replace(/\{order_number\}/g, ctx.order ? ctx.order.number || String(ctx.order.id) : '')
    .replace(/\{order_date\}/g, ctx.order ? new Date(ctx.order.createdAt).toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' }) : '')
    .replace(/\{WooCommerce\}/g, 'WooCommerce')
    .replace(/\{store_email\}/g, ctx.storeEmail || '');
}

function money(v, s) {
  const sym = decode(symbol(s.currency));
  const num = formatAmount(v, s);
  return { left: `${sym}${num}`, right: `${num}${sym}`, left_space: `${sym} ${num}`, right_space: `${num} ${sym}` }[s.currencyPos || 'left'];
}

function addressHtml(a) {
  if (!a) return '';
  const lines = [[a.first_name, a.last_name].filter(Boolean).join(' '), a.company, a.address_1, a.address_2, [a.city, a.state, a.postcode].filter(Boolean).join(' '), a.country].filter(Boolean);
  return lines.map(esc).join('<br>') + (a.phone ? `<br>${esc(a.phone)}` : '') + (a.email ? `<br><a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : '');
}

function orderTable(order, s, colors, { showPrices = true } = {}) {
  const items = order.items.filter((i) => i.type === 'line_item');
  const th = `style="text-align:left;border:1px solid #e5e5e5;padding:12px;color:${colors.text}"`;
  const td = `style="text-align:left;border:1px solid #e5e5e5;padding:12px;vertical-align:middle;color:${colors.text}"`;
  const rows = items.map((i) => {
    const meta = (i.meta || []).filter((m) => m.key && !m.key.startsWith('_')).map((m) => `<br><small>${esc(m.display_key || m.key)}: ${esc(typeof m.value === 'object' ? JSON.stringify(m.value) : m.value)}</small>`).join('');
    return `<tr><td ${td}>${esc(i.name)}${i.sku ? ` <small>(#${esc(i.sku)})</small>` : ''}${meta}</td><td ${td}>${i.quantity}</td>${showPrices ? `<td ${td}>${money(Number(i.subtotal), s)}</td>` : ''}</tr>`;
  }).join('');
  const subtotal = items.reduce((n, i) => n + Number(i.subtotal), 0);
  const totals = [['Subtotal:', money(subtotal, s)]];
  if (Number(order.discountTotal) > 0) totals.push(['Discount:', `-${money(order.discountTotal, s)}`]);
  for (const f of order.items.filter((i) => i.type === 'fee')) totals.push([`${esc(f.name)}:`, money(f.total, s)]);
  const shipping = order.items.filter((i) => i.type === 'shipping');
  if (shipping.length) totals.push(['Shipping:', `${money(order.shippingTotal, s)} <small>via ${esc(shipping.map((x) => x.name).join(', '))}</small>`]);
  if (Number(order.totalTax) > 0) totals.push(['Tax:', money(order.totalTax, s)]);
  if (order.paymentMethodTitle) totals.push(['Payment method:', esc(order.paymentMethodTitle)]);
  const refunded = (order.refunds || []).reduce((n, r) => n + Number(r.amount), 0);
  totals.push(['Total:', refunded > 0 ? `<del>${money(order.total, s)}</del> ${money(Number(order.total) - refunded, s)}` : money(order.total, s)]);
  if (refunded > 0) totals.push(['Refund:', `-${money(refunded, s)}`]);
  return `
<h2 style="color:${colors.base};font-size:18px;font-weight:bold;margin:0 0 18px">[Order #${esc(order.number || order.id)}] (${new Date(order.createdAt).toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' })})</h2>
<table cellspacing="0" cellpadding="6" border="1" style="width:100%;border:1px solid #e5e5e5;border-collapse:collapse;margin-bottom:24px">
  <thead><tr><th ${th}>Product</th><th ${th}>Quantity</th>${showPrices ? `<th ${th}>Price</th>` : ''}</tr></thead>
  <tbody>${rows}</tbody>
  ${showPrices ? `<tfoot>${totals.map(([l, v], idx) => `<tr><th colspan="2" ${th.replace('padding:12px', `padding:12px;${idx === 0 ? 'border-top-width:4px;' : ''}`)}>${l}</th><td ${td}>${v}</td></tr>`).join('')}</tfoot>` : ''}
</table>
${order.customerNote ? `<p><strong>Note:</strong> ${esc(order.customerNote)}</p>` : ''}
<table cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-bottom:24px"><tr>
  <td style="vertical-align:top;width:50%;padding:0 12px 0 0"><h2 style="color:${colors.base};font-size:18px;margin:0 0 12px">Billing address</h2><address style="padding:12px;border:1px solid #e5e5e5;font-style:normal">${addressHtml(order.billing)}</address></td>
  ${order.shipping && order.shipping.address_1 ? `<td style="vertical-align:top;width:50%;padding:0"><h2 style="color:${colors.base};font-size:18px;margin:0 0 12px">Shipping address</h2><address style="padding:12px;border:1px solid #e5e5e5;font-style:normal">${addressHtml(order.shipping)}</address></td>` : ''}
</tr></table>`;
}

function layout(heading, body, footer, colors, headerImage) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:${colors.bg}">
<div style="background:${colors.bg};padding:70px 0;width:100%">
<table border="0" cellpadding="0" cellspacing="0" width="600" align="center" style="background:${colors.body};border:1px solid #dedede;border-radius:3px;max-width:100%">
${headerImage ? `<tr><td align="center" style="padding:20px"><img src="${esc(headerImage)}" alt="" style="max-width:100%;height:auto"></td></tr>` : ''}
<tr><td style="background:${colors.base};border-radius:3px 3px 0 0;padding:36px 48px;color:#ffffff;font-family:'Helvetica Neue',Helvetica,Roboto,Arial,sans-serif"><h1 style="font-size:30px;font-weight:300;line-height:150%;margin:0;color:#ffffff">${esc(heading)}</h1></td></tr>
<tr><td style="padding:48px 48px 32px;color:${colors.text};font-family:'Helvetica Neue',Helvetica,Roboto,Arial,sans-serif;font-size:14px;line-height:150%">${body}</td></tr>
</table>
<table border="0" cellpadding="10" cellspacing="0" width="600" align="center" style="max-width:100%"><tr><td style="text-align:center;color:#8a8a8a;font-family:Arial,sans-serif;font-size:12px;padding:24px 0">${footer}</td></tr></table>
</div></body></html>`;
}

const INTROS = {
  new_order: (o) => `<p>You’ve received the following order from ${esc([o.billing.first_name, o.billing.last_name].filter(Boolean).join(' ') || o.billing.email)}:</p>`,
  cancelled_order: (o) => `<p>Notification to let you know — order #${esc(o.number)} belonging to ${esc([o.billing.first_name, o.billing.last_name].filter(Boolean).join(' '))} has been cancelled:</p>`,
  failed_order: (o) => `<p>Payment for order #${esc(o.number)} from ${esc([o.billing.first_name, o.billing.last_name].filter(Boolean).join(' '))} has failed. The order was as follows:</p>`,
  customer_on_hold_order: (o) => `<p>Hi ${esc(o.billing.first_name || '')},</p><p>Thanks for your order. It’s on-hold until we confirm that payment has been received. In the meantime, here’s a reminder of what you ordered:</p>`,
  customer_processing_order: (o) => `<p>Hi ${esc(o.billing.first_name || '')},</p><p>Just to let you know — we’ve received your order #${esc(o.number)}, and it is now being processed:</p>`,
  customer_completed_order: (o) => `<p>Hi ${esc(o.billing.first_name || '')},</p><p>We have finished processing your order.</p>`,
  customer_refunded_order: (o, d) => `<p>Hi ${esc(o.billing.first_name || '')},</p><p>Your order on {site_title} has been ${d && d.partial ? 'partially refunded' : 'refunded'}. There are more details below for your reference:</p>`,
  customer_invoice: (o) => `<p>Hi ${esc(o.billing.first_name || '')},</p><p>Here are the details of your order placed on ${new Date(o.createdAt).toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' })}:</p>`,
  customer_note: (o, d) => `<p>Hi ${esc(o.billing.first_name || '')},</p><p>The following note has been added to your order:</p><blockquote style="margin:0 0 16px;padding:12px;border-left:4px solid #e5e5e5">${esc((d && d.note) || '').replace(/\n/g, '<br>')}</blockquote><p>As a reminder, here are your order details:</p>`,
};

// Renders an EmailLog row → { to, subject, html }
async function render(row) {
  const id = row.template;
  const def = EMAILS[id];
  const l = await look();
  const s = l.store;
  const colors = { base: l.woocommerce_email_base_color || '#7f54b3', bg: l.woocommerce_email_background_color || '#f7f7f7', body: l.woocommerce_email_body_background_color || '#ffffff', text: l.woocommerce_email_text_color || '#3c3c3c' };
  const siteTitle = decode(l.blogname || s.siteName || 'Store');
  const storeEmail = await options.getOption('woocommerce_email_from_address') || await options.getOption('admin_email') || '';
  const data = row.data || {};

  if (id === 'test') {
    const heading = 'Test email';
    return { to: row.to, subject: `[${siteTitle}] Test email`, html: layout(heading, `<p>This is a test email from ${esc(siteTitle)}. If you can read this, sending works.</p><p>${new Date().toISOString()}</p>`, esc(siteTitle), colors, l.woocommerce_email_header_image) };
  }
  if (!def) throw new Error(`Unknown email "${id}"`);
  const cfg = await emailSettings(id);
  const order = row.orderId ? await prisma.order.findUnique({ where: { id: row.orderId }, include: { items: true, refunds: true } }) : null;
  if (row.orderId && !order) throw new Error(`Order #${row.orderId} no longer exists`);
  const user = row.userId ? await prisma.user.findUnique({ where: { id: row.userId } }) : null;
  const ctx = { siteTitle, order, storeEmail };
  const subject = placeholders(cfg.subject || def.subject, ctx);
  const heading = placeholders(cfg.heading || def.heading, ctx);
  let body = '';
  if (order) {
    body = placeholders((INTROS[id] || (() => ''))(order, data), ctx) + orderTable(order, s, colors, { showPrices: true });
  } else if (id === 'customer_new_account' && user) {
    body = `<p>Hi ${esc(user.firstName || user.login)},</p><p>Thanks for creating an account on ${esc(siteTitle)}. Your username is <strong>${esc(user.login)}</strong>. You can access your account area to view orders, change your password, and more at: <a href="${config.frontendUrl}/account">${config.frontendUrl}/account</a></p>`;
  } else if (id === 'customer_reset_password' && user) {
    body = `<p>Hi ${esc(user.firstName || user.login)},</p><p>Someone has requested a new password for the following account on ${esc(siteTitle)}:</p><p>Username: ${esc(user.login)}</p><p>If you didn't make this request, just ignore this email. If you'd like to proceed:</p><p><a href="${esc(data.reset_url || '#')}">Click here to reset your password</a></p>`;
  }
  if (cfg.additional_content) body += `<p>${placeholders(esc(cfg.additional_content), ctx).replace(/\n/g, '<br>')}</p>`;
  const footer = placeholders(l.woocommerce_email_footer_text || '{site_title}', ctx).replace(/\{WooCommerce\}/g, '');
  const to = def.admin ? (row.to || cfg.recipient) : row.to;
  return { to, subject, html: layout(heading, body, footer, colors, l.woocommerce_email_header_image) };
}

module.exports = { EMAILS, emailSettings, saveEmailSettings, render };
