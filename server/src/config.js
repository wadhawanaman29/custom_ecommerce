require('dotenv').config();

const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

module.exports = {
  port: parseInt(process.env.PORT || '4000', 10),
  siteUrl: (process.env.SITE_URL || 'http://localhost:4000').replace(/\/$/, ''),
  // Public storefront URL (React app), used to build product/post permalinks
  frontendUrl: (process.env.FRONTEND_URL || process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  cacheTtl: parseInt(process.env.CACHE_TTL || '60', 10),
  // Allow unauthenticated GET on catalog endpoints (products, categories, tags, attributes, reviews).
  // Lets the React frontend stop shipping consumer keys to the browser.
  publicCatalog: bool(process.env.PUBLIC_CATALOG, true),
  // Allow POST /jwt-auth/v1/register even if the WooCommerce "My account" registration setting is off
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, false),
  uploadsDir: require('path').resolve(__dirname, '..', 'uploads'),
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '20', 10),
};
