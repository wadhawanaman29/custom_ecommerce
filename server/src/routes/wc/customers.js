// /wp-json/wc/v3/customers
const express = require('express');
const crypto = require('crypto');
const prisma = require('../../db');
const config = require('../../config');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { parseCollection, setPaginationHeaders } = require('../../lib/pagination');
const { wpDate, wpDateGmt, metaOut, metaMerge, bool } = require('../../lib/format');
const { store } = require('../../lib/options');
const { runBatch } = require('../../lib/batch');
const { hashPassword } = require('../../lib/password');
const { can } = require('../../middleware/auth');
const { searchWhere } = require('../../lib/search');
const { countOf } = require('../../lib/cache');

const router = express.Router();
const API = `${config.siteUrl}/wp-json/wc/v3`;
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);

const BILLING = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'postcode', 'country', 'state', 'email', 'phone'];
const SHIPPING = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'postcode', 'country', 'state', 'phone'];
const addr = (fields, src, existing) => Object.fromEntries(fields.map((f) => [f, src && has(src, f) ? String(src[f] ?? '') : (existing && existing[f]) || '']));

function avatar(email) {
  const h = crypto.createHash('md5').update(String(email || '').trim().toLowerCase()).digest('hex');
  return `https://secure.gravatar.com/avatar/${h}?s=96&d=mm&r=g`;
}

function serializeCustomer(u, s) {
  return {
    id: u.id,
    date_created: wpDate(u.createdAt, s.gmtOffset),
    date_created_gmt: wpDateGmt(u.createdAt),
    date_modified: wpDate(u.updatedAt, s.gmtOffset),
    date_modified_gmt: wpDateGmt(u.updatedAt),
    email: u.email,
    first_name: u.firstName,
    last_name: u.lastName,
    role: u.role,
    username: u.login,
    billing: addr(BILLING, u.billing),
    shipping: addr(SHIPPING, u.shipping),
    is_paying_customer: u.isPayingCustomer,
    avatar_url: avatar(u.email),
    meta_data: metaOut(u.meta),
    _links: { self: [{ href: `${API}/customers/${u.id}` }], collection: [{ href: `${API}/customers` }] },
  };
}

async function generateUsername(email) {
  const base = String(email).split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase() || 'customer';
  let login = base;
  let n = 1;
  while (await prisma.user.findUnique({ where: { login } })) login = `${base}${n++}`;
  return login;
}

async function saveCustomer(body, existing) {
  const d = {};
  if (has(body, 'email')) {
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('registration-error-invalid-email', 'Please provide a valid email address.');
    const dupe = await prisma.user.findFirst({ where: { email, NOT: existing ? { id: existing.id } : undefined } });
    if (dupe) throw badRequest('registration-error-email-exists', 'An account is already registered with your email address. Please log in.');
    d.email = email;
  }
  if (!existing && !d.email) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): email');
  if (has(body, 'first_name')) d.firstName = String(body.first_name);
  if (has(body, 'last_name')) d.lastName = String(body.last_name);
  if (has(body, 'billing')) d.billing = addr(BILLING, body.billing, existing?.billing);
  if (has(body, 'shipping')) d.shipping = addr(SHIPPING, body.shipping, existing?.shipping);
  if (has(body, 'meta_data')) d.meta = metaMerge(existing?.meta, body.meta_data);
  if (has(body, 'password') && body.password) d.passwordHash = await hashPassword(String(body.password));

  if (!existing) {
    if (body.username) {
      const login = String(body.username).trim();
      if (await prisma.user.findUnique({ where: { login } })) throw badRequest('registration-error-username-exists', 'An account is already registered with that username. Please choose another.');
      d.login = login;
    } else d.login = await generateUsername(d.email);
    if (!d.passwordHash) d.passwordHash = await hashPassword(crypto.randomBytes(18).toString('base64'));
    d.role = 'customer';
    d.nicename = d.login.toLowerCase();
    d.displayName = [d.firstName, d.lastName].filter(Boolean).join(' ') || d.login;
    // WooCommerce copies the email into the billing address
    d.billing = { ...(d.billing || addr(BILLING, {})), email: (d.billing && d.billing.email) || d.email };
    d.shipping = d.shipping || addr(SHIPPING, {});
    return prisma.user.create({ data: d });
  }
  return prisma.user.update({ where: { id: existing.id }, data: d });
}

async function findCustomer(id) {
  const u = await prisma.user.findUnique({ where: { id: intParam(id, 'woocommerce_rest_invalid_id') } });
  if (!u) throw new ApiError(404, 'woocommerce_rest_invalid_id', 'Invalid resource ID.');
  return u;
}

// Customers may read/update themselves with a JWT; staff can manage everyone.
function selfOr(cap) {
  return (req, res, next) => {
    if (req.user && !req.apiKey && String(req.user.id) === String(req.params.id)) return next();
    return can(cap)(req, res, next);
  };
}

router.get('/', can('list_users'), ah(async (req, res) => {
  const s = await store();
  const q = req.query;
  const c = parseCollection(q, { defaultOrder: 'asc' });
  const where = {};
  const role = q.role || 'customer';
  if (role !== 'all') where.role = role;
  if (q.email) where.email = String(q.email).toLowerCase();
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  if (c.search) {
    const sw = await searchWhere('User', ['email', 'login', 'firstName', 'lastName', 'displayName'], c.search, ['email', 'login']);
    if (sw) where.AND = [sw];
  }
  const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'registered_date' ? { createdAt: c.order } : { displayName: c.order };
  const [total, rows] = await Promise.all([
    countOf('user', where),
    prisma.user.findMany({ where, orderBy, skip: c.skip, take: c.take }),
  ]);
  setPaginationHeaders(req, res, total, c);
  res.json(rows.map((u) => serializeCustomer(u, s)));
}));

router.post('/', can('create_users'), ah(async (req, res) => {
  const user = await saveCustomer(req.body || {}, null);
  await require('../../services/email/triggers').newAccount(user);
  res.status(201).json(serializeCustomer(user, await store()));
}));

router.post('/batch', can('edit_users'), ah(async (req, res) => {
  const s = await store();
  res.json(await runBatch(req.body || {}, {
    create: async (item) => serializeCustomer(await saveCustomer(item, null), s),
    update: async (id, item) => serializeCustomer(await saveCustomer(item, await findCustomer(id)), s),
    remove: async (id) => { const u = await findCustomer(id); await prisma.user.delete({ where: { id: u.id } }); return serializeCustomer(u, s); },
  }));
}));

router.get('/:id(\\d+)', selfOr('list_users'), ah(async (req, res) => res.json(serializeCustomer(await findCustomer(req.params.id), await store()))));

const update = ah(async (req, res) => {
  const existing = await findCustomer(req.params.id);
  const body = { ...(req.body || {}) };
  if (!req.can('edit_users')) { delete body.role; delete body.username; }
  res.json(serializeCustomer(await saveCustomer(body, existing), await store()));
});
router.put('/:id(\\d+)', selfOr('edit_users'), update);
router.patch('/:id(\\d+)', selfOr('edit_users'), update);

router.delete('/:id(\\d+)', can('edit_users'), ah(async (req, res) => {
  if (!bool(req.query.force ?? req.body?.force)) throw new ApiError(501, 'woocommerce_rest_trash_not_supported', 'Customers do not support trashing.');
  const s = await store();
  const u = await findCustomer(req.params.id);
  const reassign = parseInt(req.query.reassign ?? req.body?.reassign, 10);
  if (reassign) await prisma.order.updateMany({ where: { customerId: u.id }, data: { customerId: reassign } });
  await prisma.user.delete({ where: { id: u.id } });
  res.json(serializeCustomer(u, s));
}));

router.get('/:id(\\d+)/downloads', selfOr('list_users'), ah(async (req, res) => {
  // Downloadable products from paid orders
  const s = await store();
  const u = await findCustomer(req.params.id);
  const orders = await prisma.order.findMany({ where: { customerId: u.id, status: { in: ['processing', 'completed'] } }, include: { items: { where: { type: 'line_item' } } } });
  const out = [];
  for (const o of orders) {
    for (const it of o.items) {
      const p = await prisma.product.findUnique({ where: { id: it.variationId || it.productId || 0 } });
      if (!p || !p.downloadable || !Array.isArray(p.downloads)) continue;
      for (const f of p.downloads) {
        out.push({
          download_id: f.id, download_url: f.file, product_id: it.productId, product_name: it.name, download_name: f.name,
          order_id: o.id, order_key: o.orderKey, downloads_remaining: p.downloadLimit < 0 ? 'unlimited' : String(p.downloadLimit),
          access_expires: 'never', access_expires_gmt: 'never', file: { name: f.name, file: f.file },
        });
      }
    }
  }
  res.json(out);
}));

module.exports = { router, serializeCustomer, saveCustomer };
