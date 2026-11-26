# Custom Ecommerce

Node.js replacement for WordPress + WooCommerce.

| Folder | What |
|---|---|
| `server/` | API (Express + Prisma + MySQL). WooCommerce `wc/v3` and WordPress `wp/v2` compatible, JWT auth, importers. See [server/README.md](server/README.md). |
| `admin/` | Dashboard (React + Vite), WP-Admin style. Served by the API at `/wp-admin`. |
| `docs/` | `frontend-api-v1.md` — contract of the storefront's `frontend-api/v1` endpoints (next phase). |

## Run locally

```bash
# 1. API
cd server
cp .env.example .env            # set DATABASE_URL, JWT_SECRET, FRONTEND_URL
npm install
npx prisma db push
npm run seed -- --email you@example.com --password 'choose-one'   # first admin + API key
npm run dev                     # http://localhost:4000

# 2. Dashboard
cd ../admin
npm install
npm run build                   # then open http://localhost:4000/wp-admin
# or: npm run dev               # hot reload at http://localhost:5173/wp-admin (proxies the API)
```

Node 16.13+ works; Node 20/22 LTS recommended.

## Import from WordPress

Dashboard → **Tools → Import from WordPress**:
- **From database** (recommended): connects to the WordPress MySQL DB; keeps IDs, password hashes and API keys.
- **From live site**: uses WooCommerce REST keys (+ optional Application Password); can download media.

Both are re-runnable (existing IDs are skipped). CLI alternative: `cd server && npm run migrate:wp`.

## Dashboard sections

Dashboard (sales chart, recent orders, stock), Posts, Media, Pages, Comments, WooCommerce (Orders, Customers, Coupons, Reports, Settings: General/Products/Tax rates/Shipping zones/Payments/Accounts/Emails/Advanced), Products (editor with variations, attributes, categories, tags, shipping classes, reviews), Menus, Users, Tools (Import, REST API keys), Settings (General, Reading).
