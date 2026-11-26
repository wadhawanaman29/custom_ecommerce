// CLI: import a WordPress + WooCommerce database (connection from WP_DB_* in .env).
//   npm run migrate:wp
//   npm run migrate:wp -- --only=products,orders --remote-media --reset
// The same importer is available in the dashboard under Tools → Import.
require('dotenv').config();
const prisma = require('../src/db');
const { run } = require('../src/services/import/wp-db');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const only = ((argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '').split(',').filter(Boolean);

run({
  host: process.env.WP_DB_HOST,
  port: process.env.WP_DB_PORT,
  user: process.env.WP_DB_USER,
  password: process.env.WP_DB_PASSWORD,
  database: process.env.WP_DB_NAME,
  prefix: process.env.WP_TABLE_PREFIX || 'wp_',
  only,
  remoteMedia: flag('remote-media'),
  uploadsUrl: process.env.WP_UPLOADS_URL,
  reset: flag('reset'),
}, (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`))
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
