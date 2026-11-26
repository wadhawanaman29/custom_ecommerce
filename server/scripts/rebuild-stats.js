// Rebuilds the analytics lookup tables (OrderStats, OrderProductLookup, OrderCouponLookup)
// and the billing search columns, in batches. Safe to run any time; the importers run it automatically.
//   npm run stats:rebuild
//   npm run stats:rebuild -- --from=150000     (only orders with ID > 150000)
require('dotenv').config();
const prisma = require('../src/db');
const { rebuildAll } = require('../src/services/order-stats');

const from = parseInt(((process.argv.find((a) => a.startsWith('--from=')) || '').split('=')[1]) || '0', 10);
const t0 = Date.now();
rebuildAll((l) => console.log(l), { fromId: from })
  .then((n) => console.log(`Done: ${n} orders in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
