# Database design for large stores (10 GB+)

**Engine:** MySQL 8.0 (or MariaDB 10.11 LTS) via Prisma. Local development uses XAMPP MariaDB.
Production settings: [`mysql-production.cnf`](mysql-production.cnf).

## Why WordPress slows down — and what this schema does instead

| WordPress / WooCommerce | This system |
|---|---|
| Every product/order field is a row in `wp_postmeta` (EAV, millions of rows, string comparisons, no useful indexes) | Real typed columns with indexes (price, SKU, status, dates, customer…) |
| `wp_options` autoload loaded on every request; transients pile up | Small `Option` table, cached in memory |
| Search = `LIKE '%term%'` over posts/meta (full table scans) | FULLTEXT indexes + indexed prefix matches |
| Reports scan orders and order item meta | Narrow analytics lookup tables, aggregated in SQL |
| Coupon `_used_by` grows forever | `CouponUsage` rows with an index; atomic usage counter |
| Sessions/carts in DB | Stateless JWT (no session rows) |
| Plugins add unbounded queries | Every list is paginated (max 100 rows) and indexed |

## Rules the code follows

1. **Every list query is index-backed and paginated** (`per_page` ≤ 100). Filters map to composite indexes:
   - `Order(status, createdAt)`, `Order(customerId, createdAt)`, `Order(billingEmail)`, `Order(billingPhone)`
   - `Product(type, status)`, `Product(price)`, `Product(totalSales)`, `Product(salePrice)`, `Product(slug)`, unique `sku`
   - `Post(type, status, createdAt)`, `Post(type, menuOrder)`, `User(role, createdAt)`, `OrderItem(orderId, type)`…
2. **No `LIKE '%…%'`.** Search uses FULLTEXT (`lib/search.js`, boolean mode with prefix matching) on:
   `Product(name, sku)`, `Post(title, content)`, `User(email, login, firstName, lastName, displayName)`,
   `Order(billingName, billingEmail, billingPhone)` — plus `startsWith` on indexed columns (SKU, email, slug, order number).
3. **No searching inside JSON.** Billing email/name/phone are copied into indexed columns on every save.
4. **Reports never scan orders.** On every order change, `services/order-stats.js` updates:
   - `OrderStats` — one narrow row per order (status, date, totals, items, returning customer)
   - `OrderProductLookup` — one row per line item (product, variation, qty, revenue)
   - `OrderCouponLookup` — one row per coupon used
   Analytics aggregate these with `GROUP BY` in SQL; result size depends on days/products, not on order count.
5. **Counts are cached** for 30 s (`lib/cache.js → countOf`) and cleared on writes, so pagination headers don't
   re-count millions of rows on every request.
6. **Imports stream in batches of 1 000 by ID** (keyset pagination) — memory stays flat for any source size,
   and re-running skips existing IDs (resumable).

## Operations

```bash
npx prisma db push          # create/update tables & indexes (use `prisma migrate deploy` once migrations are adopted)
npm run stats:rebuild       # rebuild analytics tables (after manual SQL changes); --from=<orderId> for a partial rebuild
```

- **Backups:** nightly `mysqldump --single-transaction --quick` (or Percona XtraBackup for large DBs) + binlogs for point-in-time recovery.
- **Table stats:** MySQL updates them automatically; after a big import run `ANALYZE TABLE \`Order\`, OrderItem, Product, OrderStats, OrderProductLookup;`.
- **Monitoring:** watch the slow query log (`long_query_time = 0.5`); every slow query should get an index or a lookup table.

## Growing further (100 GB+)

- **Read replica:** point reporting/analytics at a replica (second Prisma client with a read-only `DATABASE_URL`).
- **Partitioning:** `OrderItem` / `OrderProductLookup` can be range-partitioned by year when they reach hundreds of millions of rows.
- **Archiving:** orders older than N years can move to an archive table; lookup tables keep the totals.
- **Search engine:** for typo-tolerant storefront search, sync products to Meilisearch/Algolia (FULLTEXT stays for admin search).
- **Cache:** the in-memory response cache is per process; with several Node processes, switch `lib/cache.js` to Redis.
