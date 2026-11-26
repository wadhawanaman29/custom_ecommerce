# Custom Ecommerce API (WordPress + WooCommerce replacement)

A Node.js API that serves the **same endpoints and JSON shapes** as WooCommerce (`/wp-json/wc/v3`) and WordPress (`/wp-json/wp/v2`), backed by a clean, indexed MySQL schema (no `wp_postmeta`).
A headless React frontend only needs its base URL changed.

## Setup
```bash
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, FRONTEND_URL, WP_DB_* (old site)
npm install
npx prisma db push            # create tables in the new database
npm run migrate:wp            # import everything from the WordPress DB (IDs preserved)
npm run seed -- --key-only    # create a new ck_/cs_ API key (migrated keys also keep working)
npm run dev
```
Copy the old `wp-content/uploads/*` into `server/uploads/` (or migrate with `-- --remote-media` to keep loading images from the old site).

## Migration flags
`--only=options,users,media,products,coupons,taxes,orders,content` · `--remote-media` · `--reset` (wipes the new DB first).
Re-runnable: existing IDs are skipped, so you can run it again just before switching DNS to pick up new orders.

## Compatibility
| Area | Endpoints |
|---|---|
| WooCommerce | products (+variations, batch), categories, tags, attributes (+terms), shipping_classes, reviews, orders (+notes, refunds, batch), customers, coupons, taxes, tax classes, shipping zones/locations/methods, payment_gateways, settings, data, reports |
| WordPress | posts, pages, categories, tags, comments, media (upload), users (+me), menus, menu-items, settings, search |
| Auth | Consumer key/secret (Basic or query string), JWT `/wp-json/jwt-auth/v1/token` (same response as the JWT Auth plugin) |
| Menus plugin | `/wp-json/menus/v1/menus/:slug`, `/locations/:location` |
| Extras | `POST /wp-json/custom/v1/cart/calculate` (totals + shipping rates preview), `/coupons/validate`, `GET /custom/v1/store`, `/orders/:id/received?key=` , `POST /orders/:id/payment-complete` |

Supports `_fields`, `_embed`, `X-WP-Total`/`X-WP-TotalPages`, `?rest_route=`, `_method` override.
Existing WordPress passwords (phpass and WP 6.8 bcrypt) work and are upgraded on first login.

## Business rules implemented
Sale prices and schedules, variable product price/stock sync, stock reduce/restore on status changes, total_sales, coupon rules (percent / fixed_cart / fixed_product, limits, min/max, emails, categories, exclusions), tax rates (priority, compound, postcode/city, shipping tax), shipping zones (flat rate formulas with `[qty]`/`[cost]`/`[fee]`, class costs, free shipping rules, local pickup), status-change order notes, refunds.

## Performance
- Indexed columns instead of meta key/value lookups
- In-memory response cache for catalog/CMS reads (`CACHE_TTL`), cleared on every write
- `PUBLIC_CATALOG=true` lets the storefront read products without exposing API keys in the browser

## Not yet done
Transactional emails, payment-gateway SDK integrations (Razorpay/Stripe refunds via API), image thumbnail generation, webhooks, admin panel UI (next phase, needs Node 18+).
