const app = require('./app');
const config = require('./config');
const prisma = require('./db');

const server = app.listen(config.port, () => {
  console.log(`API listening on ${config.siteUrl} (port ${config.port})`);
  console.log(`  WooCommerce: ${config.siteUrl}/wp-json/wc/v3`);
  console.log(`  WordPress:   ${config.siteUrl}/wp-json/wp/v2`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
