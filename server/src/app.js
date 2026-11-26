const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const config = require('./config');
const { authenticate } = require('./middleware/auth');
const { notFoundRoute, errorHandler } = require('./middleware/errors');
const { clearOnWrite } = require('./lib/cache');
const options = require('./lib/options');

const products = require('./routes/wc/products');
const terms = require('./routes/wc/terms');
const orders = require('./routes/wc/orders');
const customers = require('./routes/wc/customers');
const coupons = require('./routes/wc/coupons');
const storeRoutes = require('./routes/wc/store');
const wpPosts = require('./routes/wp/posts');
const wpMedia = require('./routes/wp/media');
const wpUsers = require('./routes/wp/users');
const site = require('./routes/wp/site');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors({
  origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
  credentials: true,
  exposedHeaders: ['X-WP-Total', 'X-WP-TotalPages', 'Link', 'X-Cache'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Content-Disposition', 'X-WP-Nonce', 'X-HTTP-Method-Override'],
}));
app.use(compression());
if (process.env.NODE_ENV !== 'test') app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Uploaded media (same public path as WordPress)
app.use('/wp-content/uploads', express.static(config.uploadsDir, { maxAge: '30d', immutable: true, fallthrough: false }));

// ?rest_route=/wc/v3/products → /wp-json/wc/v3/products (plain-permalink style URLs)
app.use((req, res, next) => {
  if (req.query.rest_route) {
    const route = String(req.query.rest_route);
    const rest = req.url.replace(/([?&])rest_route=[^&]*&?/, '$1').replace(/[?&]$/, '');
    const qs = rest.includes('?') ? rest.slice(rest.indexOf('?')) : '';
    req.url = `/wp-json${route.startsWith('/') ? route : `/${route}`}${qs}`;
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// _method / X-HTTP-Method-Override like WordPress
app.use((req, res, next) => {
  const override = req.query._method || req.get('X-HTTP-Method-Override');
  if (override && req.method === 'POST') req.method = String(override).toUpperCase();
  next();
});

// _fields=id,name,price → only those top-level keys (WP REST global param)
app.use('/wp-json', (req, res, next) => {
  if (!req.query._fields) return next();
  const fields = String(req.query._fields).split(',').map((f) => f.trim().split('.')[0]).filter(Boolean);
  if (has(req.query, '_embed')) fields.push('_embedded', '_links');
  const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]])) : o);
  const json = res.json.bind(res);
  res.json = (body) => json(res.statusCode < 400 ? (Array.isArray(body) ? body.map(pick) : pick(body)) : body);
  next();
});
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

app.use('/wp-json', authenticate, clearOnWrite());

// ── WooCommerce REST API ──
const wc = express.Router();
wc.use('/products/categories', terms.categories);
wc.use('/products/tags', terms.tags);
wc.use('/products/shipping_classes', terms.shippingClasses);
wc.use('/products/attributes', terms.attributes);
wc.use('/products/reviews', terms.reviews);
wc.use('/products', products);
wc.use('/orders', orders);
wc.use('/customers', customers.router);
wc.use('/coupons', coupons);
wc.use('/', storeRoutes);
app.use('/wp-json/wc/v3', wc);
app.use('/wp-json/wc/v2', wc); // v2 is a near-identical subset

// ── WordPress REST API ──
const wp = express.Router();
wp.use('/posts', wpPosts.posts);
wp.use('/pages', wpPosts.pages);
wp.use('/categories', wpPosts.categories);
wp.use('/tags', wpPosts.tags);
wp.use('/comments', wpPosts.comments);
wp.use('/media', wpMedia.router);
wp.use('/users', wpUsers.users);
wp.use('/menus', site.menus);
wp.use('/menu-items', site.menuItems);
wp.use('/settings', site.settings);
wp.use('/search', site.search);
wp.use('/:base', wpPosts.dynamicContentRouter()); // custom post types & taxonomies (CPT UI equivalent)
app.use('/wp-json/wp/v2', wp);

app.use('/wp-json/jwt-auth/v1', wpUsers.jwtAuth);
app.use('/wp-json/menus/v1', site.menusV1);
app.use('/wp-json/custom/v1/admin/analytics', require('./routes/analytics').router);
app.use('/wp-json/custom/v1/admin', require('./routes/admin'));
app.use('/wp-json/custom/v1', site.custom);

// Dashboard (React build from ../admin) at /wp-admin, with SPA fallback
const adminDist = require('path').resolve(__dirname, '..', '..', 'admin', 'dist');
app.use('/wp-admin', express.static(adminDist, { index: false, maxAge: '1h' }));
app.get(['/wp-admin', '/wp-admin/*'], (req, res, next) => {
  const index = require('path').join(adminDist, 'index.html');
  if (!require('fs').existsSync(index)) return res.status(404).send('Dashboard not built. Run: cd admin && npm install && npm run build');
  res.sendFile(index);
});
app.get('/', (req, res) => res.redirect('/wp-admin/'));

// API index (GET /wp-json)
app.get(['/wp-json', '/wp-json/'], async (req, res, next) => {
  try {
    const o = await options.getOptions(['blogname', 'blogdescription', 'gmt_offset', 'timezone_string']);
    res.json({
      name: o.blogname,
      description: o.blogdescription,
      url: config.frontendUrl,
      home: config.frontendUrl,
      gmt_offset: String(o.gmt_offset),
      timezone_string: o.timezone_string,
      namespaces: ['wp/v2', 'wc/v3', 'wc/v2', 'jwt-auth/v1', 'menus/v1', 'custom/v1'],
      authentication: { 'application-passwords': {}, jwt: { endpoint: `${config.siteUrl}/wp-json/jwt-auth/v1/token` } },
      routes: {},
    });
  } catch (e) { next(e); }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/wp-json', notFoundRoute);
app.use(errorHandler);

module.exports = app;
