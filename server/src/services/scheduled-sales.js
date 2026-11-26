// Scheduled sales (WooCommerce's wc_scheduled_sales cron): the stored "price" column must switch to the
// sale price when a sale window opens and back to the regular price when it closes, so sorting,
// price filters, feeds and the cart all agree. Runs every few minutes; works in ID batches.
const prisma = require('../db');
const { syncVariableParent } = require('./product');

const ACTIVE = `salePrice IS NOT NULL AND (regularPrice IS NULL OR salePrice < regularPrice)
  AND (dateOnSaleFrom IS NULL OR dateOnSaleFrom <= UTC_TIMESTAMP(3))
  AND (dateOnSaleTo IS NULL OR dateOnSaleTo > UTC_TIMESTAMP(3))`;

async function flip(condition, setExpr) {
  let changed = 0;
  const parents = new Set();
  for (;;) {
    const rows = await prisma.$queryRawUnsafe(`SELECT id, parentId FROM Product WHERE ${condition} LIMIT 1000`);
    if (!rows.length) break;
    const ids = rows.map((r) => Number(r.id));
    await prisma.$executeRawUnsafe(`UPDATE Product SET price = ${setExpr} WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    rows.forEach((r) => { if (r.parentId) parents.add(Number(r.parentId)); });
    changed += ids.length;
    if (rows.length < 1000) break;
  }
  for (const id of parents) await syncVariableParent(id);
  return changed;
}

async function runScheduledSales() {
  const started = await flip(`${ACTIVE.replace(/\n/g, ' ')} AND (price IS NULL OR price <> salePrice)`, 'salePrice');
  const ended = await flip(`salePrice IS NOT NULL AND regularPrice IS NOT NULL AND NOT (${ACTIVE.replace(/\n/g, ' ')}) AND (price IS NULL OR price <> regularPrice) AND type <> 'variable'`, 'regularPrice');
  if (started || ended) require('../lib/cache').clear();
  return { started, ended };
}

module.exports = { runScheduledSales };
