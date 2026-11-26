const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const config = require('../config');
const { ApiError } = require('../lib/http');

// ── Roles → capabilities (subset of WordPress/WooCommerce caps actually used by the API) ──
const ROLE_CAPS = {
  administrator: ['*'],
  shop_manager: [
    'manage_woocommerce', 'view_woocommerce_reports', 'edit_products', 'edit_shop_orders', 'edit_shop_coupons',
    'list_users', 'edit_users', 'create_users', 'edit_posts', 'edit_others_posts', 'publish_posts',
    'edit_pages', 'edit_others_pages', 'publish_pages', 'upload_files', 'manage_categories', 'moderate_comments', 'read',
  ],
  editor: ['edit_posts', 'edit_others_posts', 'publish_posts', 'edit_pages', 'edit_others_pages', 'publish_pages',
    'upload_files', 'manage_categories', 'moderate_comments', 'read'],
  author: ['edit_posts', 'publish_posts', 'upload_files', 'read'],
  contributor: ['edit_posts', 'read'],
  customer: ['read'],
  subscriber: ['read'],
};

function userCan(user, cap) {
  if (!user) return false;
  const caps = ROLE_CAPS[user.role] || [];
  return caps.includes('*') || caps.includes(cap);
}

// WooCommerce stores consumer keys as hash_hmac('sha256', $key, 'wc-api')
const hashConsumerKey = (ck) => crypto.createHmac('sha256', 'wc-api').update(ck).digest('hex');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const lastAccessWrites = new Map();

async function authenticateApiKey(ck, cs) {
  const key = await prisma.apiKey.findUnique({ where: { consumerKey: hashConsumerKey(ck) }, include: { user: true } });
  if (!key || !safeEqual(key.consumerSecret, cs)) {
    throw new ApiError(401, 'woocommerce_rest_authentication_error', 'Consumer key is invalid.');
  }
  // Throttle last_access updates to once a minute per key
  const now = Date.now();
  if ((lastAccessWrites.get(key.id) || 0) < now - 60000) {
    lastAccessWrites.set(key.id, now);
    prisma.apiKey.update({ where: { id: key.id }, data: { lastAccess: new Date() } }).catch(() => {});
  }
  return key;
}

function signToken(user) {
  const now = Math.floor(Date.now() / 1000);
  // Same payload shape as the "JWT Authentication for WP REST API" plugin
  return jwt.sign({ iss: config.siteUrl, iat: now, nbf: now, data: { user: { id: String(user.id) } } },
    config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (e) {
    throw new ApiError(403, 'jwt_auth_invalid_token', e.message);
  }
}

// Resolves req.user / req.apiKey from the request. Never rejects anonymous requests;
// use can() / requireUser() on routes to enforce access.
async function authenticate(req, res, next) {
  try {
    req.user = null;
    req.apiKey = null;
    const header = req.headers.authorization || '';
    let ck;
    let cs;

    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      const u = decoded.slice(0, i);
      const p = decoded.slice(i + 1);
      if (u.startsWith('ck_')) { ck = u; cs = p; }
    } else if (header.startsWith('Bearer ')) {
      const payload = verifyToken(header.slice(7).trim());
      const id = parseInt(payload?.data?.user?.id, 10);
      const user = id ? await prisma.user.findUnique({ where: { id } }) : null;
      if (!user) throw new ApiError(403, 'jwt_auth_bad_request', 'User ID not found in the token');
      req.user = user;
    }

    if (!ck && req.query.consumer_key && req.query.consumer_secret) {
      ck = String(req.query.consumer_key);
      cs = String(req.query.consumer_secret);
    }

    if (ck) {
      const key = await authenticateApiKey(ck, cs);
      req.apiKey = key;
      req.user = key.user;
    }

    req.can = (cap) => userCan(req.user, cap);
    next();
  } catch (e) {
    next(e);
  }
}

function checkKeyPermission(req) {
  if (!req.apiKey) return;
  const p = req.apiKey.permissions;
  const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (isRead && p === 'write') throw new ApiError(401, 'woocommerce_rest_authentication_error', 'The API key provided does not have read permissions.');
  if (!isRead && p === 'read') throw new ApiError(401, 'woocommerce_rest_authentication_error', 'The API key provided does not have write permissions.');
}

function deniedCode(req) {
  switch (req.method) {
    case 'GET': return ['woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.'];
    case 'POST': return ['woocommerce_rest_cannot_create', 'Sorry, you are not allowed to create resources.'];
    case 'DELETE': return ['woocommerce_rest_cannot_delete', 'Sorry, you are not allowed to delete this resource.'];
    default: return ['woocommerce_rest_cannot_edit', 'Sorry, you are not allowed to edit this resource.'];
  }
}

// Route guard: requires a capability. Unauthenticated → 401, insufficient → 403 (like WP).
function can(cap) {
  return (req, res, next) => {
    try {
      checkKeyPermission(req);
      if (userCan(req.user, cap)) return next();
      const [code, message] = deniedCode(req);
      throw new ApiError(req.user ? 403 : 401, code, message);
    } catch (e) { next(e); }
  };
}

// Catalog reads: anonymous allowed when PUBLIC_CATALOG=true; handlers must restrict anonymous
// users to published content via req.can('manage_woocommerce').
function publicRead(cap) {
  const guard = can(cap);
  return (req, res, next) => {
    if (req.method === 'GET' && config.publicCatalog && !req.user) return next();
    return guard(req, res, next);
  };
}

function requireUser(req, res, next) {
  if (req.user) return next();
  next(new ApiError(401, 'rest_not_logged_in', 'You are not currently logged in.'));
}

module.exports = { authenticate, can, publicRead, requireUser, userCan, signToken, hashConsumerKey, ROLE_CAPS };
