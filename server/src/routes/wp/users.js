// /wp-json/wp/v2/users (+ /me) and JWT auth (/wp-json/jwt-auth/v1/token, /token/validate)
const express = require('express');
const prisma = require('../../db');
const config = require('../../config');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { parseCollection, setPaginationHeaders, strList } = require('../../lib/pagination');
const { wpDate, bool } = require('../../lib/format');
const { slugify } = require('../../lib/slug');
const { store } = require('../../lib/options');
const { verifyPassword, hashPassword, needsRehash } = require('../../lib/password');
const {
  can, requireUser, signToken, ROLE_CAPS,
} = require('../../middleware/auth');
const { userPublic } = require('./posts');

const users = express.Router();
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);

function userFull(u, s) {
  const caps = ROLE_CAPS[u.role] || [];
  return {
    ...userPublic(u),
    username: u.login,
    first_name: u.firstName,
    last_name: u.lastName,
    email: u.email,
    locale: 'en_US',
    nickname: u.login,
    registered_date: `${wpDate(u.createdAt, 0)}+00:00`,
    roles: [u.role],
    capabilities: Object.fromEntries([[u.role, true], ...caps.map((c) => [c, true])]),
    extra_capabilities: { [u.role]: true },
  };
}

users.get('/', ah(async (req, res) => {
  const s = await store();
  const q = req.query;
  const c = parseCollection(q, { defaultOrder: 'asc' });
  const canList = req.can('list_users');
  const where = {};
  // Public listing only exposes users who authored published posts (WP behaviour)
  if (!canList) where.posts = { some: { status: 'publish' } };
  if (q.roles && canList) where.role = { in: strList(q.roles) };
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  if (q.slug) where.nicename = { in: strList(q.slug) };
  if (c.search) where.OR = [{ displayName: { contains: c.search } }, { login: { contains: c.search } }, ...(canList ? [{ email: { contains: c.search } }] : [])];
  const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'registered_date' ? { createdAt: c.order } : c.orderby === 'email' && canList ? { email: c.order } : { displayName: c.order };
  const [total, rows] = await Promise.all([prisma.user.count({ where }), prisma.user.findMany({ where, orderBy, skip: c.skip, take: c.take })]);
  setPaginationHeaders(req, res, total, c);
  const full = canList && q.context === 'edit';
  res.json(rows.map((u) => (full ? userFull(u, s) : userPublic(u))));
}));

async function saveUser(body, existing, req) {
  const d = {};
  if (has(body, 'email')) {
    const email = String(body.email).trim().toLowerCase();
    if (await prisma.user.findFirst({ where: { email, NOT: existing ? { id: existing.id } : undefined } })) throw badRequest('existing_user_email', 'Sorry, that email address is already used!');
    d.email = email;
  }
  if (has(body, 'name')) d.displayName = String(body.name);
  if (has(body, 'first_name')) d.firstName = String(body.first_name);
  if (has(body, 'last_name')) d.lastName = String(body.last_name);
  if (has(body, 'url')) d.url = String(body.url);
  if (has(body, 'description')) d.description = String(body.description);
  if (has(body, 'slug')) d.nicename = slugify(body.slug);
  if (has(body, 'password') && body.password) d.passwordHash = await hashPassword(String(body.password));
  if (has(body, 'roles') && req.can('edit_users')) {
    const role = (Array.isArray(body.roles) ? body.roles : [body.roles])[0];
    if (!ROLE_CAPS[role]) throw badRequest('rest_user_invalid_role', 'Role is invalid.');
    if (role === 'administrator' && !req.can('*') && req.user.role !== 'administrator') throw new ApiError(403, 'rest_cannot_edit_roles', 'Sorry, you are not allowed to give users that role.');
    d.role = role;
  }
  if (existing) return prisma.user.update({ where: { id: existing.id }, data: d });
  if (!body.username || !d.email || !body.password) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): username, email, password');
  if (await prisma.user.findUnique({ where: { login: String(body.username) } })) throw badRequest('existing_user_login', 'Sorry, that username already exists!');
  d.login = String(body.username);
  d.nicename = d.nicename || slugify(d.login);
  d.displayName = d.displayName || d.login;
  d.role = d.role || 'subscriber';
  return prisma.user.create({ data: d });
}

users.post('/', can('create_users'), ah(async (req, res) => res.status(201).json(userFull(await saveUser(req.body || {}, null, req), await store()))));

users.get('/me', requireUser, ah(async (req, res) => res.json(userFull(req.user, await store()))));
const updateMe = ah(async (req, res) => {
  const body = { ...(req.body || {}) };
  delete body.roles;
  res.json(userFull(await saveUser(body, req.user, req), await store()));
});
users.post('/me', requireUser, updateMe);
users.put('/me', requireUser, updateMe);
users.patch('/me', requireUser, updateMe);

async function findUser(id) {
  const u = await prisma.user.findUnique({ where: { id: intParam(id, 'rest_user_invalid_id') } });
  if (!u) throw new ApiError(404, 'rest_user_invalid_id', 'Invalid user ID.');
  return u;
}
users.get('/:id(\\d+)', ah(async (req, res) => {
  const s = await store();
  const u = await findUser(req.params.id);
  const self = req.user && req.user.id === u.id;
  if (!self && !req.can('list_users')) {
    const hasPosts = await prisma.post.count({ where: { authorId: u.id, status: 'publish' } });
    if (!hasPosts) throw new ApiError(401, 'rest_user_cannot_view', 'Sorry, you are not allowed to list users.');
  }
  res.json(self || (req.can('list_users') && req.query.context === 'edit') ? userFull(u, s) : userPublic(u));
}));
const updUser = ah(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!(req.user && req.user.id === u.id) && !req.can('edit_users')) throw new ApiError(403, 'rest_cannot_edit', 'Sorry, you are not allowed to edit this user.');
  res.json(userFull(await saveUser(req.body || {}, u, req), await store()));
});
users.post('/:id(\\d+)', requireUser, updUser);
users.put('/:id(\\d+)', requireUser, updUser);
users.patch('/:id(\\d+)', requireUser, updUser);
users.delete('/:id(\\d+)', can('edit_users'), ah(async (req, res) => {
  if (!bool(req.query.force ?? req.body?.force)) throw new ApiError(501, 'rest_trash_not_supported', "Users do not support trashing. Set 'force=true' to delete.");
  const s = await store();
  const u = await findUser(req.params.id);
  const reassign = parseInt(req.query.reassign ?? req.body?.reassign, 10) || null;
  if (reassign) await prisma.post.updateMany({ where: { authorId: u.id }, data: { authorId: reassign } });
  await prisma.user.delete({ where: { id: u.id } });
  res.json({ deleted: true, previous: userFull(u, s) });
}));

// ── JWT auth (same endpoints/response as the "JWT Authentication for WP REST API" plugin) ──
const jwtAuth = express.Router();
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => t > now - 15 * 60 * 1000);
  if (list.length >= 10) throw new ApiError(429, 'too_many_attempts', 'Too many failed login attempts. Please try again in 15 minutes.');
  return list;
}
jwtAuth.post('/token', ah(async (req, res) => {
  const { username, password } = req.body || {};
  const key = `${req.ip}:${String(username || '').toLowerCase()}`;
  const list = throttle(key);
  const login = String(username || '').trim();
  const user = login.includes('@')
    ? await prisma.user.findUnique({ where: { email: login.toLowerCase() } })
    : await prisma.user.findUnique({ where: { login } });
  if (!user || !(await verifyPassword(String(password || ''), user.passwordHash))) {
    list.push(Date.now());
    attempts.set(key, list);
    throw new ApiError(403, user ? '[jwt_auth] incorrect_password' : '[jwt_auth] invalid_username',
      user ? `<strong>Error:</strong> The password you entered for the username <strong>${login}</strong> is incorrect.` : 'Unknown username. Check again or try your email address.');
  }
  attempts.delete(key);
  if (needsRehash(user.passwordHash)) {
    // Upgrade legacy WordPress hash to bcrypt transparently
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(String(password)) } });
  }
  res.json({
    token: signToken(user),
    user_email: user.email,
    user_nicename: user.nicename || user.login,
    user_display_name: user.displayName || user.login,
    // extras (not in the plugin, handy for the frontend)
    user_id: user.id,
    user_role: user.role,
  });
}));
jwtAuth.post('/token/validate', (req, res, next) => {
  if (!req.user) return next(new ApiError(403, 'jwt_auth_no_auth_header', 'Authorization header not found.'));
  res.json({ code: 'jwt_auth_valid_token', data: { status: 200 } });
});

// Customer self-registration for the storefront (WooCommerce "My account" registration)
jwtAuth.post('/register', ah(async (req, res) => {
  const { getOption } = require('../../lib/options');
  const enabled = await getOption('woocommerce_enable_myaccount_registration');
  if (enabled !== 'yes' && !config.allowRegistration) throw new ApiError(403, 'registration_disabled', 'Registration is disabled.');
  const { saveCustomer, serializeCustomer } = require('../wc/customers');
  const b = req.body || {};
  if (!b.password || String(b.password).length < 6) throw badRequest('registration-error-missing-password', 'Please enter an account password (min. 6 characters).');
  const user = await saveCustomer({ email: b.email, username: b.username, password: b.password, first_name: b.first_name, last_name: b.last_name, billing: b.billing, shipping: b.shipping }, null);
  res.status(201).json({ token: signToken(user), customer: serializeCustomer(user, await store()) });
}));

module.exports = { users, jwtAuth };
