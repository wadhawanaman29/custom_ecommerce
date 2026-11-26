// Email sending (replaces "SMTP for AmazonSES – YaySMTP") + queue.
// Emails are queued as EmailLog rows and sent in the background with retries, so a slow or failing
// mail server never slows checkout or order updates. Mailer "log" records without sending.
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const prisma = require('../../db');
const options = require('../../lib/options');
const templates = require('./templates');

const MAX_ATTEMPTS = 5;
let transport = null;
let transportKey = '';

async function smtpSettings() {
  const o = await options.getOptions(['smtp_mailer', 'smtp_ses_region', 'smtp_host', 'smtp_port', 'smtp_encryption', 'smtp_username', 'smtp_password', 'smtp_force_from', 'woocommerce_email_from_name', 'woocommerce_email_from_address', 'blogname', 'admin_email']);
  const mailer = o.smtp_mailer || 'log';
  const host = mailer === 'ses' ? `email-smtp.${o.smtp_ses_region || 'ap-southeast-2'}.amazonaws.com` : String(o.smtp_host || '');
  return {
    mailer,
    host,
    port: parseInt(o.smtp_port, 10) || (o.smtp_encryption === 'ssl' ? 465 : 587),
    encryption: o.smtp_encryption || 'tls',
    user: String(o.smtp_username || ''),
    pass: String(o.smtp_password || ''),
    fromName: String(o.woocommerce_email_from_name || o.blogname || ''),
    fromEmail: String(o.woocommerce_email_from_address || o.admin_email || ''),
  };
}

async function getTransport(s) {
  const key = crypto.createHash('sha1').update(JSON.stringify([s.host, s.port, s.encryption, s.user, s.pass])).digest('hex');
  if (transport && key === transportKey) return transport;
  if (!s.host) throw new Error('No SMTP host configured (Plugins → Email / SMTP).');
  transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.encryption === 'ssl',
    requireTLS: s.encryption === 'tls',
    ignoreTLS: s.encryption === 'none',
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });
  transportKey = key;
  return transport;
}

async function deliver({ to, subject, html }) {
  const s = await smtpSettings();
  if (s.mailer === 'log') return { skipped: true };
  if (!s.fromEmail) throw new Error('Set the "From" address in WooCommerce → Settings → Emails.');
  const t = await getTransport(s);
  const info = await t.sendMail({ from: { name: s.fromName, address: s.fromEmail }, to, subject, html, text: html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim() });
  return { messageId: info.messageId };
}

// ── Queue ──
let processing = false;
let again = false;

async function queue(template, { to = '', orderId = null, userId = null, data = null } = {}) {
  if (template !== 'test') {
    const cfg = await templates.emailSettings(template);
    if (!cfg.enabled) return null;
    if (!cfg.is_customer_email && !to) to = cfg.recipient;
  }
  if (!to) return null;
  const row = await prisma.emailLog.create({ data: { template, to: String(to).slice(0, 500), orderId, userId, data } });
  setImmediate(processQueue);
  return row;
}

async function sendRow(row) {
  try {
    const msg = await templates.render(row);
    const r = await deliver(msg);
    await prisma.emailLog.update({
      where: { id: row.id },
      data: r.skipped
        ? { status: 'skipped', subject: msg.subject.slice(0, 500), attempts: row.attempts + 1, error: 'Mailer is set to "log only" — not sent.', sentAt: new Date() }
        : { status: 'sent', subject: msg.subject.slice(0, 500), attempts: row.attempts + 1, error: null, sentAt: new Date() },
    });
    return true;
  } catch (e) {
    const attempts = row.attempts + 1;
    await prisma.emailLog.update({ where: { id: row.id }, data: { attempts, error: String(e.message).slice(0, 2000), status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued' } });
    return false;
  }
}

async function processQueue() {
  if (processing) { again = true; return; }
  processing = true;
  try {
    do {
      again = false;
      // Retry backoff: attempt n waits ~n² minutes
      const rows = await prisma.emailLog.findMany({ where: { status: 'queued' }, orderBy: { id: 'asc' }, take: 25 });
      const due = rows.filter((r) => r.attempts === 0 || Date.now() - new Date(r.createdAt).getTime() > r.attempts * r.attempts * 60000);
      for (const r of due) await sendRow(r);
      if (due.length === 25) again = true;
    } while (again);
  } catch (e) {
    console.error('email queue error:', e.message);
  } finally {
    processing = false;
  }
}

// Direct test send (not queued) — returns the real SMTP result or error
async function sendTest(to) {
  const s = await smtpSettings();
  const row = await prisma.emailLog.create({ data: { template: 'test', to } });
  const msg = await templates.render(row);
  try {
    if (s.mailer === 'log') {
      await prisma.emailLog.update({ where: { id: row.id }, data: { status: 'skipped', subject: msg.subject, attempts: 1, error: 'Mailer is set to "log only" — not sent.', sentAt: new Date() } });
      return { ok: true, skipped: true, message: 'Mailer is "log only": the email was logged but not sent. Choose Amazon SES or SMTP to send for real.' };
    }
    const r = await deliver(msg);
    await prisma.emailLog.update({ where: { id: row.id }, data: { status: 'sent', subject: msg.subject, attempts: 1, sentAt: new Date() } });
    return { ok: true, message: `Sent to ${to} via ${s.host}.`, message_id: r.messageId };
  } catch (e) {
    await prisma.emailLog.update({ where: { id: row.id }, data: { status: 'failed', subject: msg.subject, attempts: 1, error: e.message } });
    return { ok: false, message: e.message };
  }
}

module.exports = { queue, processQueue, sendTest, smtpSettings };
