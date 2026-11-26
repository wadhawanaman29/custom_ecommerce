# `frontend-api/v1` API contract (reverse-engineered from the Next.js frontend)

Source analysed: `E:\xampp\htdocs\CustomEcommerce\New folder` (Next.js 11) — `pages/`, `src/`, `utils/`, `next.config.js` only.
Purpose: let a Node.js re-implementation of the WordPress plugin `frontend-api/v1` serve the existing frontend unchanged.

Conventions used below

- **Upstream** = the WordPress plugin route being replaced: `${API_PATH}/<path>`, `API_PATH = https://content.gr8health.com.au/wp-json/frontend-api/v1`.
- **Next route** = the proxy in `pages/api/*.js` the browser/SSR actually calls.
- Types are inferred from usage (`number` when used arithmetically or with `toFixed`, `html` when rendered with `dangerouslySetInnerHTML`, etc.).
- Field names are exactly as written in the code, typos included (`_auht_token`, `singup`, `secert`, `subsciber`, `reedem`, `gallary`, `shot_description`, `momenu`, `relativeProduct`, `Deatil`, ...). **Do not "fix" them on the server.**
- No secret values are reproduced here; secrets are referred to by env-var name or file location.

---

## 1. Overview, transport and auth

### 1.1 Server-to-server auth (all upstream calls)

Every upstream call carries

```
Authorization: Basic base64(API_AUTH_USER_ID_KEY + ":" + API_AUTH_USER_SECRET_KEY)
```

This is a fixed site key (not a user credential). The new server must validate it on every route.

Two transports reach upstream:

| Transport | Where | Content-Type | Body |
|---|---|---|---|
| Next API routes (`pages/api/*.js`) using `fetch` | ~64 routes + SSR in `pages/index.js` | `application/json` | `JSON.stringify(req.body)` for "pass-through" routes; custom bodies noted per endpoint |
| `src/api.js` axios helper, **called directly from the browser** | forgot/reset password, profile, password change, address book, product review | `application/x-www-form-urlencoded` (axios default set in `src/api.js`) | `api.buildURI(obj)` — see 1.4 |

Note: because `src/api.js` runs in the browser, the Basic key (`API_AUTH_USER_*`) is shipped to clients via `next.config.js env`. The key is therefore not really secret; treat it as an API identifier and rely on the user token for anything user-specific.

### 1.2 Standard response envelope and the generic proxy

Upstream must answer **HTTP 200 with JSON**:

```jsonc
{ "success": true,  "data": <payload> }
{ "success": false, "data": { "message": "Human readable error", ... } }
```

The generic "pass-through" Next route (used by most endpoints, marked **[PT]** below) does:

```js
if (data.success) res.status(200).json({ success: true, data: data.data })
else              res.status(200).json({ success: false, message: data.data.message, data: data.data })
// any method other than POST -> 405
```

Consequences for the Node implementation:

1. On failure `data` **must be an object** (the proxy dereferences `data.data.message`; a missing `data` crashes the route with a 500).
2. Put the user-facing error text in `data.message`. Most UI code reads `resData.data.message`; a few read the top-level `message` the proxy copies (noted per endpoint). One endpoint reads `data.Message` (capital M) — see `validate-coupon-new`.
3. Non-JSON or HTML error pages from upstream crash the proxy (`response.json()` throws).
4. Routes that ignore `req.body` and send no body are noted (**[PT, no body]**).
5. `footer-menu-info` and `top-nav-bar-menu-info` responses are cached by the Next route (`Cache-Control: s-maxage=120, stale-while-revalidate=600`).

### 1.3 User token (`token` cookie, `_auht_token`, `authToken`, `token`)

- Returned by `user-login` as `data` (a **string**). Stored by the frontend in cookie `token` (30 min, or 5 days when "remember me").
- The frontend **decrypts the token client-side** (`decrypt_open__ssl_token` in `src/functions.js`) with CryptoJS AES using a passphrase and fixed salt hard-coded in that file. The token value is only the base64 ciphertext (`ct`); the frontend wraps it as `{"ct": token, "iv": <fixed>, "s": <fixed salt>}` and calls `CryptoJS.AES.decrypt(json, passphrase)`. With a passphrase, CryptoJS derives key **and IV** from passphrase + salt (OpenSSL `EVP_BytesToKey`, MD5, AES-256-CBC), so the fixed IV in the JSON is effectively ignored. The Node server must issue ciphertext that decrypts this way (or the frontend must change).
- Decrypted payload (JSON) fields read by the frontend:

  | field | type | use |
  |---|---|---|
  | `id` | number/string | user id; also cart-merge marker (`localStorage.cartMerged`) |
  | `email` | string | prefill, Klaviyo |
  | `fname` | string | Klaviyo identify |
  | `user_access_level` | string[] | e.g. `["access_level_1"]`, `["all_access"]`; gates practitioner products |

  A token without `id` is treated as logged-out.
- The same token string is sent back under different names depending on endpoint: `token`, `_auht_token` (typo, intentional), `authToken` (Next route converts to `_auht_token`), and in checkout `_auht_token` = **`JSON.stringify(token)`**, i.e. the token wrapped in literal double quotes. The server must strip surrounding quotes before decrypting.
- `manage-product-access-request` returns a **new token** (with updated `user_access_level`) that the frontend writes over the cookie.

### 1.4 `api.buildURI` (form-urlencoded) quirks

```js
Object.keys(data).filter(k => data[k] && data[k] != undefined).map(k => enc(k) + '=' + enc(data[k])).join('&')
```

- Falsy values (`''`, `0`, `false`, `null`) are **dropped** — the server must treat a missing field as empty/false.
- Arrays are encoded via `String(array)` → comma-joined (`"Sleep & Relaxation,Energy & Focus"`). Booleans become `"true"`.

### 1.5 Pagination shapes (three different ones)

| Shape | Consumer | Fields |
|---|---|---|
| A (`utils/pagination.js`, `pagination-brand.js`) | blog lists, author blogs, brand products | `currentPage`, `currentPageCount`, `totalPages`, `totalResults` |
| B (`src/components/product/ProductsPagination.js`) | category products | `currentPage`, `productCount`, `totalPages`, `totalProducts` |
| C (`OrderPagination.js`) | order history | `orderCount`, `currentPage`, `totalOrders`, `totalPages` |
| D (`utils/review-pagination.js`) | product reviews | `currentPage`, `reviewCount`, `totalPages`, `totalResults` |

`paged` request params arrive as strings, often `''` (meaning page 1).

### 1.6 Frontend constants (`next.config.js env`) that encode business rules

| Env | Value | Meaning |
|---|---|---|
| `TAX_RATE` | `9.09` | GST is **included** in prices; tax = `round2(TAX_RATE * amount / 100)` (≈ 1/11) |
| `STANDARD_SHIPPING_CHARGES` | `9.95` | standard shipping; free when cart subtotal > 99 |
| `EXPRESS_SHIPPING_CHARGES` | `19.95` | express |
| `AUS_POST_STANDARD_SHIPPING_CHARGES` | `10.95` | Australia Post standard |
| `EXPRESS_COLD_PRODUCT_SHIPPING_CHARGES` | `19.95` | cold-packed express when (subtotal − redeemed points $) < 100 |
| `EXPRESS_COLD_PRODUCT_SHIPPING_CHARGES_DISCOUNTED` | `9.95` | cold-packed express when ≥ 100 |
| `PAYPAL_CHECKOUT_URL` | `https://www.paypal.com/checkoutnow` | redirect `?token=<payPalApproveToken>` |
| `AFTERPAY_CHECKOUT_URL` | `https://portal.afterpay.com/au/checkout` | redirect `/?token=<afterPayApproveToken>` |
| `HOME_URL` | site origin | SSR calls Next routes via `HOME_URL + 'api/...'` |
| `NEXT_PUBLIC_CAPTCHA_KEY` / `NEXT_PUBLIC_CAPTCHA_SECRET_KEY` | — | reCAPTCHA v2 (client only; see 10.1) |

---

## 2. Endpoint index

70 distinct upstream paths (64 via Next routes + 6 via direct browser axios). Method is `POST` unless stated.

| # | Upstream path | Next route | Domain |
|---|---|---|---|
| 1 | `user-login` | `user-login-api` | auth |
| 2 | `user-singup` | `user-singup-api` | auth |
| 3 | `verify-user` | `verify-user-api` | auth |
| 4 | `forget-password-initiate/` | direct (form) | auth |
| 5 | `validate-secert-key` | `validate-secert-key-api` | auth |
| 6 | `generate-new-password/` | direct (form) | auth |
| 7 | `user-info/` | `auth` (custom) | user |
| 8 | `update-user-profile/` | direct (form) | user |
| 9 | `change-user-password/` | direct (form) | user |
| 10 | `update-addressbook/` | direct (form) | user |
| 11 | `home-page-info` | `home-page-info-api` + direct SSR in `pages/index.js` | content |
| 12 | `product-exist` | `product-exist-api` | catalog |
| 13 | `category-exist` | `category-exist-api` | catalog |
| 14 | `breadcrumbs` | `breadcrumb` | catalog |
| 15 | `searchbybrand` | `searchbybrand-api` | catalog |
| 16 | `get-product-by-brand` | `get-product-by-brand-api` | catalog |
| 17 | `get-brandfilter-options` | `brandfilter-options` | catalog |
| 18 | `get-condition-specific-categories` | `get-condition-specific-categories-api` | catalog |
| 19 | `shop-by-offer-page` | `api-shop-by-offer-page` | catalog/offers |
| 20 | `get-product-reviewlist` | `get-product-reviewlist-api` | catalog |
| 21 | `add-product-review/` | direct (form) | catalog |
| 22 | `handle-stock-notify-me` | `handle-stock-notify-me-api` | catalog |
| 23 | `manage-product-access-request` | `handle-product-access-request` | catalog/access |
| 24 | `klaviyo-practitioner/` | `klaviyo-list` | catalog/access |
| 25 | `get-all-categories-for-sitemap` | `get-all-categories-for-sitemap-api` | misc |
| 26 | `get-all-products-for-sitemap` | `get-all-products-for-sitemap-api` | misc |
| 27 | `user-cart-detail` | `user-cart-detail-api` | cart |
| 28 | `update-user-cart` | `manage-cart` (custom) | cart |
| 29 | `delete-cart-item` | `manage-cart` (custom) | cart |
| 30 | `validate-stock/` | `validate_stock` (custom) | cart |
| 31 | `cart-rewards` | `cart-rewards` | cart/offers |
| 32 | `check-offer-checkout/` | `validate-offer-api` | cart/offers |
| 33 | `free-gift-offer-api` | `api-free-gift-offer` | cart/offers |
| 34 | `get-otheroffers/` | `get-other-offers` | cart |
| 35 | `cart-page-you-may-like-products-api` | `cart-page-you-may-like-products` | cart |
| 36 | `get-last-minute-items` | `last-minute-items` | checkout |
| 37 | `get-special-product` | `special-product` | checkout |
| 38 | `validate-coupon-new` | `validate-coupon-new-api` | checkout |
| 39 | `create-order-latest` | `handle-checkout` | checkout |
| 40 | `handle-order-payment-paypal` | `handle-order-payment-paypal-api` | payment |
| 41 | `handle-order-payment-afterpay` | `handle-order-payment-afterpay-api` | payment |
| 42 | `get-success-order-info` | `order-status-success-order-info-api` | orders |
| 43 | `order-history` (also `order-history/`, commented-out direct call) | `order-history-api` | orders |
| 44 | `order-detail` | `order-detail-api` | orders |
| 45 | `complete-order` | `complete-order-api` | orders |
| 46 | `update-order` | `complete-order` | orders/payment |
| 47 | `get-user-points/` | `get-user-point` | rewards |
| 48 | `user-points` | `redeem-point` | rewards |
| 49 | `get-rewards-info` | `rewards-info` | rewards |
| 50 | `social-follow/` | `social-follow` | rewards |
| 51 | `get-user-wishlist-api` | `get-user-wishlist-info` | wishlist |
| 52 | `add-item-to-wishlist-api` | `wishlist` (custom) | wishlist |
| 53 | `remove-item-from-wishlist-api` | `wishlist` (custom) | wishlist |
| 54 | `get-bloglist` | `get-bloglist-api` | blog |
| 55 | `get-author-bloglist` | `get-author-bloglist-api` | blog |
| 56 | `single-blog` | `single-blog-api` | blog |
| 57 | `get-post-categories` | `post-categories` | blog |
| 58 | `authors` | `authors` | blog |
| 59 | `get-wellness-method-blogs-api` | `get-wellness-method-blogs-info` | blog |
| 60 | `single-page` | `single-page-api` | pages |
| 61 | `top-nav-bar-menu-info` | `top-nav-bar-menu-info-api` | menus |
| 62 | `top-nav-bar-momenu-info` | `top-nav-bar-momenu-info-api` | menus |
| 63 | `footer-menu-info` | `footer-menu-info-api` | menus |
| 64 | `announcement` | `announcement` | content |
| 65 | `home-banners-info` | `home-banners` | content (route exists, **no caller**) |
| 66 | `get-greviews` | `getgreviews` | misc |
| 67 | `get-feeds` (**GET**) | `instagramfeed` | misc |
| 68 | `contact-submit` | `contact-submit-api` | misc |
| 69 | `subsciber-newsletter` | `subsciber-newsletter-api` (and duplicate unused `subsciber-newsletter`) | misc |
| 70 | `send-download-notification` | `send-download-notification-api` | misc |

Next routes that do **not** call upstream: `3d-auth` (Westpac PayWay), `get-ip-data` (ipify; unused), `hello` (Next sample).
No `wc/v3` or `wp/v2` calls are live: `utils/WooCommerce/*` (WooCommerce REST client using `WOCOM_WS_URL`, `CONS_KEY`, `CONS_SECRET_KEY`, `WOCOM_VER`) is not imported anywhere.

---

## 3. Auth / user

### 3.1 `POST user-login` [PT]
Callers: `pages/account/login.js`, `src/components/forms/LoginForm.js` (header/checkout popup, `LoggedOutUserView`).

Request (JSON):

| field | type | source |
|---|---|---|
| `email` | string | form |
| `password` | string | form |
| `isHuman` | boolean | reCAPTCHA ticked (only from `pages/account/login.js`) |
| `rememberPassword` | boolean | only from `pages/account/login.js` (default `true`) |
| `cartProductInfo` | string (JSON of `[{id:number, qty:number}]`) | only from `LoginForm` when `updateLoginUserCart === true` (checkout) and local cart non-empty |
| `update_cart` | boolean `true` | same condition |

Response success: `data` = **encrypted token string** (see 1.3).
Failure: `data.message` (shown with an appended "once only password reset" hint).

Behaviour: when `update_cart` is set, the server should merge the guest cart into the user's stored cart (items `{id, qty}`). Independently, the frontend also merges local and server carts after login (see `user-cart-detail`).

### 3.2 `POST user-singup` [PT]
Caller: `pages/account/create.js`.

Request: `first_name`, `last_name`, `email`, `password`, `confirmpassword`, `referral_code` (string, from `?ref=` query), `isHuman` (boolean).
Response: success → `data.message` (shown); failure → `data.message`.
Behaviour inferable: account requires e-mail verification (`verify-user` link with `ac` and `key`); referral code credits the referrer (`referral` points) and gives the new user signup points (marketing copy: "100 points ($5 voucher)"; referrer "5 points"; referrer bonus `referral_after_first_order` when referee spends over $49).

### 3.3 `POST verify-user` [PT]
Caller: `pages/account/verify.js` (SSR). Request: `ac` (string), `key` (string) from the e-mail link query.
Response: success → `data.message`; failure → `data.message` (page shows error state).

### 3.4 `POST forget-password-initiate/` (direct, form-urlencoded)
Caller: `pages/account/forgotpassword.js`. Body: `email`.
Response: `success`, `data.message` both ways. Server should e-mail a link to `/account/resetpassword?token=<token>&key=<key>`.

### 3.5 `POST validate-secert-key` [PT]
Caller: `pages/account/resetpassword.js` (SSR). Request: `token`, `key` (from query).
Response: success → page renders form (data unused); failure → `data.message`.

### 3.6 `POST generate-new-password/` (direct, form-urlencoded)
Caller: `pages/account/resetpassword.js`. Body: `new_password`, `token` (the reset token, not the auth token).
Response: `data.message` both ways.

### 3.7 `POST user-info/` — via custom Next route `/api/auth`
Callers: every dashboard page `getInitialProps` (`pages/account/dashboard/{index,orders,wishlist,account-information,address-book,changepassword,rewards,reward-all}.js`), `src/functions.js#getUserInformation` (checkout prefill), `src/components/rewards/loginuser-reward.js`.

Next route contract: browser sends header `Authorization: {"token":"<token>"}` (a JSON string, not Basic). Route posts upstream `{ "token": <token> }`.

- Upstream 2xx → route returns `{ data: js.data }` (note: **no `success` key**, and it does not check `js.success`).
- Upstream non-2xx → route returns 4xx and the page redirects to `/account/login`.
- **Therefore an invalid/expired token must produce a non-2xx HTTP status** (unlike every other endpoint), otherwise the dashboard renders with garbage.

Response `data` (user object) fields read:

| field | type | notes |
|---|---|---|
| `user_email` | string | |
| `user_meta.first_name`, `user_meta.last_name` | string | |
| `user_meta.billing_first_name`, `billing_last_name`, `billing_company`, `billing_address_1`, `billing_address_2`, `billing_city`, `billing_postcode`, `billing_country` (e.g. `AU`), `billing_state` (e.g. `QLD`), `billing_phone`, `billing_email` | string | |
| `user_meta.shipping_first_name`, `shipping_last_name`, `shipping_company`, `shipping_address_1`, `shipping_address_2`, `shipping_city`, `shipping_postcode`, `shipping_country`, `shipping_state`, `shipping_phone` | string | |
| `user_meta.referral_code` | string | referral link = `HOME_URL + 'account/create?ref=' + code` |
| `user_meta.gr8_user_points` | number | current balance |
| `user_meta.gr8_user_tier` | `"gold"`\|`"sapphire"`\|`"platinum"`\|`""` | tier key |
| `user_meta.gr8_followed_facebook`, `gr8_followed_instagram`, `gr8_followed_tiktok`, `gr8_followed_google_review` | boolean-ish | already claimed social reward |
| `dobc` | string `YYYY-MM-DD` or `""` | date of birth; once set it is locked in UI |
| `gender` | `"male"`\|`"female"`\|`"other"`\|`""` | |
| `custom_fields.dietary_preferences` | string[] | |
| `custom_fields.primary_health_goals` | string[] | |
| `custom_fields.current_lifestyle_focus` | string | |
| `custom_fields.weight_and_body_goals` | `"Yes"`\|`"No"` | |
| `custom_fields.naturopathic_support` | `"Yes"`\|`"No"` | |
| `custom_fields.consult_with_naturopath` | `"Yes"`\|`"No"` | |
| `custom_fields.personalisation_preference` | string[] | |
| `gr8_points_history_unser` | array of `{ action: string, points: number\|null, note: string, date: string (Date-parsable) }` | points ledger |
| `tier_name` | string | display name of tier |

Known `action` values used by the UI: `signup`, `profile complete`, `happy_birthday`, `Follow facebook`, `Follow instagram`, `referral`, `referral_first_order`, `order`, `redeem`/`reedem`, and `"<Tier> tier bonus"` (contains "tier bonus"). Order notes look like `"Points for <...> (Tier: N)"` (UI strips `points for` and `(Tier: N)`).

### 3.8 `POST update-user-profile/` (direct, form)
Caller: `pages/account/dashboard/account-information.js`. Body: `first_name`, `last_name`, `token`. Response `data.message`.

### 3.9 `POST change-user-password/` (direct, form)
Caller: `pages/account/dashboard/changepassword.js`. Body: `old_password`, `new_password`, `token`. Response `data.message`.

### 3.10 `POST update-addressbook/` (direct, form)
Caller: `pages/account/dashboard/address-book.js`. Body (all strings; arrays comma-joined; empty values omitted — see 1.4):

`billing_first_name, billing_last_name, billing_company, billing_address_1, billing_address_2, billing_city, billing_postcode, billing_country, billing_state, billing_phone, shipping_first_name, shipping_last_name, shipping_company, shipping_address_1, shipping_address_2, shipping_city, shipping_postcode, shipping_country, shipping_state, shipping_phone, dob (YYYY-MM-DD, min 1925-01-01), gender, token, dobLocked ("true" or omitted), dietary_preferences, primary_health_goals, current_lifestyle_focus, weight_and_body_goals, naturopathic_support, consult_with_naturopath, personalisation_preference`

Option vocabularies (from UI):
- `dietary_preferences`: "Are you Vegan?", "Are you Vegetarian?", "Are you Gluten-Free?", "Are you Dairy-Free or Lactose Intolerant?", "Do you consume caffeine regularly?", "Do you avoid artificial sweeteners or additives?", "Non Applicable"
- `primary_health_goals` (UI says up to three): "Sleep & Relaxation", "Energy & Focus", "Gut & Digestion", "Weight Management", "Skin, Hair & Nails", "Stress & Mood", "Hormonal Balance / Menopause", "Joint & Bone Support", "Heart & Circulation", "Liver & Detox", "Prostate Health", "Longevity / Cellular Energy"
- `current_lifestyle_focus`: "I’m working on overall wellness and prevention" | "I’m managing a specific concern or condition" (curly apostrophe)
- `personalisation_preference`: "Send me personalised product suggestions", "Share educational articles & recipes", "Keep me updated on exclusive offers & rewards"

Caution: values containing commas ("Skin, Hair & Nails") are ambiguous after comma-joining.
Frontend bug to be aware of: the prefill maps `shipping_last_name ← user_meta.billing_email` and `shipping_company ← user_meta.shipping_last_name`, so those two fields are often submitted wrong.
Response: `data.message`. Business rule (UI copy): completing the profile awards **25 bonus points** (`profile complete` ledger action); DOB can only be set once.

---

## 4. Catalog

### 4.1 `POST product-exist` [PT]
Caller: `pages/[slug].js` (SSR). Request: `product_slug` (string).
Response `data`:
- `product` — full Product (see 8.1), including `status` (`"redirect"` triggers redirect) and `redirect_to_url` (target; default `/`, non-permanent).
- `relatedProductsInfo` — Product[] (card subset) or falsy.
Failure → 404 page.

### 4.2 `POST category-exist` [PT]
Caller: `pages/c/[...cslug].js` (SSR).

Request:

| field | type | source |
|---|---|---|
| `category_slug` | **string[]** (catch-all path segments, e.g. `["vitamins","vitamin-c"]`) | URL |
| `brands` | string, comma-separated brand slugs or `''` | `?brands=` |
| `dietary_info` | string, comma-separated dietary term slugs or `''` | `?dietary_info=` |
| `numberposts` | `"16"`\|`"32"` | cookie `_product_per__page_` (default `"16"`) |
| `paged` | string or `''` | `?pageno=` |
| `orderby` | `price_asc`\|`price_desc`\|`asc`\|`desc`\|`newest`\|`best_seller`\|`''`/undefined | `?sort=` or cookie `_sort_by_` |

Response `data`:
- `category`: `{ name: html, description: html }`
- `products`: Product[] (card)
- `pagination`: shape B
- `naturopath_top_picks`: Product[]
- `offers`: `[{ ID, offerImg, offerLink, post_title, post_content (html) }]`
- `trendingProductArray`: `[{ pid, slug, title, image: [{ src }] }]`
- `faq_section`: `[{ question, answer (html) }]` (first 3 rendered at top, rest below)
- `filter_options`: `{ brands: [{term_id, slug, name, count}], dietary_info: [{term_id, slug, name, count}] }`
- `relatedBlog`: `[{ slug, title (html), post_excerpt, post_image, author_img, nicename }]` (only `[0]` used)
- `seoMeta`: SeoMeta (8.6)
Failure → 404.

### 4.3 `POST breadcrumbs` [PT]
Caller: `src/components/Breadcrumb.js` (category pages). Request: `cslug` (string; first path segment only). Response `data`: `{ name, parent_menu_name, parent_slug }` (parent link `/c/<parent_slug>`).

### 4.4 `POST searchbybrand` [PT]
Callers: `pages/brands/index.js` (`{limit:500, paged}`), `pages/sitemap.xml.js` (`{limit:2000}`).
Response `data`: `brandlist: [{ slug, name, image }]`, `filter_options`: object keyed by **lowercase letter** → truthy if any brand starts with it (UI filters with `name.toLowerCase().startsWith(key)`).

### 4.5 `POST get-product-by-brand` [PT]
Caller: `pages/brands/[slug].js` (SSR).
Request: `numberposts` (`"16"`/`"32"`), `paged`, `bslug` (brand slug), `brandsfilters` (comma list, from `?brand=`), `dietaryfilters` (comma list, from `?dietary=`), `sort` (same values as 4.2; default `best_seller`, cookie `_brand_p_sort_by`).
Response `data`: `products` (Product[]), `pagination` (shape A), `brand` `{ name, description (html), image, banner_image, shot_description }`, `offers` (as 4.2), `relatedBlog` (**single object**, not array: `{slug,title,post_excerpt,post_image,author_img,nicename}`), `faq_section`, `naturopath_top_picks`, `seoMeta` (if `metadesc` empty the UI substitutes `brand.shot_description`).
Failure → **301 redirect to `/brands`**.

### 4.6 `POST get-brandfilter-options` [PT]
Caller: `src/components/brands/BrandListFilters.js`. Request: `bslug`.
Response `data`: `{ brands: [{slug,name,count}], dietary: [{slug,name}] }`.

### 4.7 `POST get-condition-specific-categories` [PT]
Caller: `pages/shop-by-condition/index.js` (SSR). Request `{limit: 300, paged}`.
Response `data`: `shoplist: [{ slug, name, image }]` (links to `/c/<slug>`), `filter_options` (letter map as 4.4).
Note: page checks `if(data)` not `data.success`.

### 4.8 `POST shop-by-offer-page` [PT]
Caller: `pages/shop-by-offer.js` (SSR). Request `{ shop_by_offer_page: true }`.
Response `data`: `offersData: [{ ID, offerImg, offerLink, title }]`, `filtersCategory: [{term_id,slug,name}]`, `filtersBrand: [{term_id,slug,name}]`.

### 4.9 `POST get-product-reviewlist` [PT]
Caller: `src/components/product/ProductReview.js`. Request: `pslug` (product slug), optional `paged`.
Response `data`: `reviews: [{ id, author, title, review_text, posted_date, valueRating, qualityRating, priceRating }]`, `overallRatingStar` (number 0–5), `overallRatingShow` (number, shown in parentheses), `pagination` (shape D).

### 4.10 `POST add-product-review/` (direct, form)
Caller: `ProductReview.js`. Body: `token`, `ratingValue`, `ratingQuality`, `ratingPrice` (1–5), `reviewText`, `reviewTitle`, `pslug`. Response `data.message` both ways. (Reviews presumably require login/moderation.)

### 4.11 `POST handle-stock-notify-me` [PT]
Caller: `src/components/product/ProductNotifyMeButton.js` (shown for out-of-stock items). Request: `user_email`, `product_id`. Response: only `success` used.
Behaviour: register a back-in-stock notification.

### 4.12 `POST manage-product-access-request` [PT]
Caller: `src/components/product/ProductRequestAccessButton.js` (logged-in only).
Request:

| field | type |
|---|---|
| `recommendedByPractitioner`, `usedUnderGuidance`, `useResponsibly`, `acknowledgePolicy` | boolean |
| `productId` | number |
| `email` | string (may be empty) |
| `_auht_token` | token (raw, not JSON-quoted) |
| `ipAddress` | string (from api.ipify.org) |
| `productAccessLevel` | `"access_level_1"` \| `"access_level_2"` |
| `errors` | object (UI state, ignore) |

Response success: `data.token` — **new auth token** whose payload's `user_access_level` now includes the granted level; frontend replaces the cookie (30 min). Failure → "book an appointment" message.
Rules visible in UI: `access_level_1` products (practitioner-only) are self-certified with the 4 checkboxes; `access_level_2` requires a naturopath consult (no form; guests get a login alert). A user with `all_access` sees everything. Guests self-certifying `access_level_1` get a 12-hour `localStorage` grant (no API call) plus a Klaviyo list submission (4.13).

### 4.13 `POST klaviyo-practitioner/` [PT]
Caller: `ProductRequestAccessButton.js` (guest path). Body: same object as 4.12 minus token/level (`recommendedByPractitioner…acknowledgePolicy, productId, email, _auht_token:'' , ipAddress, errors`). Response: `success`; on failure frontend reads top-level `message`.

### 4.14 Sitemap feeds [PT]
`get-all-categories-for-sitemap` and `get-all-products-for-sitemap`, caller `pages/sitemap.xml.js`.
Request: `{ numberposts: 500, paged: 1..50 }`. Response `data.categories` / `data.products`: `[{ slug, modified }]` (`modified` used as `<lastmod>`; category URL `c/<slug>` so slug may contain `/`). Pagination stops when a page returns < 500 items.

---

## 5. Cart / checkout / payment

The cart lives in `localStorage['gr8-woo-cart']` (shape 8.2). For logged-in users the server keeps a copy, updated item-by-item.

### 5.1 `POST user-cart-detail` [PT]
Caller: `src/functions.js#getUserCartDataFromApi` (on app load when logged in, once per user — `localStorage.cartMerged`). Request: `_auht_token` (raw token).
Response `data`: Cart (8.2) — `products` (CartItem[]), `totalProductsCount`, `totalProductsPrice`, `tax`. On failure the UI substitutes an empty cart.
Frontend then merges: for same `productId` it **adds** quantities (server qty + local qty) and recomputes totals; local `gift` and `protection` are preserved.

### 5.2 `POST update-user-cart` / `POST delete-cart-item` — via custom Next route `/api/manage-cart`
Callers: `AddToCartButton.js`, `AddToCartButtonCart.js`, `CartItem.js`, `checkout/OrderSummayItem.js`, `order-complete/OrderSummayItem.js`, `ProductRequestAccessButton.js`, `src/functions.js#handleCartForLoginUser`.
Browser → Next: `{ actionToPerform: "add"|"delete", productId, authToken, newQty? }`.
Next → upstream (JSON): `{ "_auht_token": authToken, "product_id": productId, "action": actionToPerform, "newQty": newQty || 0 }`; `delete` → `delete-cart-item`, anything else → `update-user-cart`.
Response reshaped to `{ success }` only (data dropped; UI ignores result).
Semantics the server must implement:
- `action:"add", newQty:0` (Add-to-cart buttons) → **increment by 1** (the button may have added N locally, but only 1 is signalled — see Open questions).
- `action:"add", newQty>0` (quantity box, 1..99) → **set** quantity to `newQty`.
- `delete` → remove line.

### 5.3 `POST validate-stock/` — via custom Next route `/api/validate_stock`
Callers: `pages/checkout.js` (on load), `src/components/cart/OrderSummary.js` ("Secure Checkout").
Browser → Next body: `CartItem[]` (raw array). Next → upstream: `{ "products": CartItem[] }`.
Upstream `data`: `{ quantityError: boolean, returnArray: { <key>: { message: string } } }`.
Next reshapes to `{ success, quantityError, errorMsg: JSON.stringify(returnArray) }`; UI lists `errorMsg[key].message` and blocks checkout when `quantityError`.

### 5.4 `POST cart-rewards` [PT]
Callers: cart and checkout `OrderSummary.js`. Request `{}`.
Response `data`: **array** of tiers (anything else is treated as an error):

| field | type | notes |
|---|---|---|
| `target` | number | cart $ threshold |
| `label` | string (html allowed) | e.g. "free shipping" (UI swaps to "Cold Packed Express (Discounted)" when cold-packed items present) |
| `isActionable` | boolean | true → tier grants a gift product |
| `returnProtectionProduct` | Product (card subset: `id, name, slug, price, images[0].src`) | the gift; added to `cart.gift` with `offer_type:"carttier_offer"`, removed when total drops below `target` |

Progress bar uses `cartTotal = totalProductsPrice − redeemed $`.

### 5.5 `POST check-offer-checkout/` [PT]
Callers: `src/components/cart/CartItems.js`, `checkout/OrderSummary.js` (re-run whenever subtotal changes).
Request: `{ totalProductsPrice: number, product_ids: [{ productId, qty }] }`.
Response `data`:
- `products`: `{ brand_offer: Product[], minimum_offer: Product[] | {k: Product}, buy_get_free: Product[] | {k: Product} }` — each gift product needs `id, name, slug, price, images[0].src`.
- `tiers`: `[{ gift_product_id, gift_in_stock: boolean }]` — out-of-stock tier gifts are removed from the cart.
Behaviour: on every call the UI clears existing `brand_offer`/`minimum_offer`/`buy_get_free` gifts and re-adds what is returned (these gift types are not user-removable). `success:false` → all three types cleared.
Business rules implied: brand-purchase gifts, minimum-spend gifts, buy-X-get-Y-free.

### 5.6 `POST free-gift-offer-api` [PT, no body]
Caller: `src/components/cart/free-gift-offer/freeGiftOffer.js` (cart page). Response `data.products`: Product[] (`id, slug, name, price, images[0].src`). User can add one of each as gift with `offer_type:"cart_offer"` (user-removable).

### 5.7 `POST get-otheroffers/` [PT, no body]
Caller: cart `OrderSummary.js`. Response `data.returnProtectionProduct`: the **Shipping Protection** product `{ id, name, price, images[0].src }`. Price shown as "$2.99 AUD"; free for tiers `sapphire`/`platinum` (frontend computes `protectionPrice = 0` for those tiers). Opt-out checkbox, default on; stored as `cart.protection`. Removed when "Click & Collect" is chosen.

### 5.8 `POST cart-page-you-may-like-products-api` [PT]
Caller: `CartYouMayLikeSection.js`. Request `{ cart_like_products: true }`. Response `data.products`: Product[] (card subset incl. `productExtraTags`, `regular_price`, `access_level`, stock fields for AddToCart).

### 5.9 `POST get-last-minute-items` [PT]
Caller: `CheckoutLastMinuteItemSection.js`. Request `{ last_minute_items: true }`. Response `data.products`: Product[] (as 5.8).

### 5.10 `POST get-special-product` [PT, no body]
Caller: `SpecialProductPromoteItemSection.js` (checkout). Response `data.products`: Product[].

### 5.11 `POST validate-coupon-new` [PT]
Caller: `checkout/OrderSummary.js`.
Request: `{ cartInfo: Cart (whole localStorage cart incl. gift/protection/reedemPointsAmount), couponCode: string, authToken: token|'' , uemail: string }`.
Response success, one of:
- Discount coupon: `data.total_discount_amount` (number, $), `data.isShippingFree` (boolean → "Free Shipping Coupon" method, shipping 0).
- Gift coupon: `data.gift_coupon` = Product + `offer_type` (UI adds it to `cart.gift`; expected value `"coupon_gift"`), discount = 0. Absent/empty object means "not a gift coupon".
Failure: **`data.Message`** (capital M) is displayed. Return both `message` and `Message`.
Rules: coupon cannot be combined with points redemption (UI enforced); coupon is cleared whenever subtotal changes; e-mail is mandatory (per-customer usage limits likely).

### 5.12 `POST create-order-latest` [PT] — place order
Caller: `src/components/checkout/CheckOutForm.js` (axios).
Request (JSON) = the checkout form state plus extras:

```jsonc
{
  "otherFields": { "email": "", "password": "", "confirmPassword": "", "errors": {} },
  "billing":  { "firstName","lastName","address","address2","city","country":"AU","state":"QLD","postalCode","phone","company","errors" },
  "shipping": { ...same as billing },
  "createAccount": false,
  "isUserLogin": true,
  "_auht_token": "\"<token>\"",          // JSON.stringify(token) – quoted! '' for guests
  "orderNotes": "",
  "shippingSameAsBilling": true,
  "checkoutMethod": "guest" | "register" | "",
  "continueWithoutLogin": false,
  "paymentMethod": "braintree" | "paypal" | "afterpay",   // "braintree" = card via Westpac PayWay
  "shippingMethod": "standard" | "express" | "australia_post_standard" | "freeShippingViaCoupon"
                    | "cold_packed_express" | "cold_packed_express_discounted"
                    | "cold_packed_shipping" | "cold_packed_shipping_discounted",   // see note
  "showClickToCollect": false,
  "collectFromWarehouse": false,          // Click & Collect
  "freeShippingViaCoupon": false,
  "cartProductInfo": [{ "id": 123, "qty": 2 }],
  "coupon": "CODE",
  "gift": [GiftItem] | false,
  "protection": { productId, image, name, price } | {} | false,
  "userPublicIp": "1.2.3.4",
  "redeemRequested": true|false,
  "klaviyoOptIn": true|false,
  "nonceFromTheClientBT": "<PayWay singleUseTokenId>" | ""
}
```

Notes:
- `password`/`confirmPassword` required (6–18) only when `checkoutMethod === "register"` → create account.
- Validation (client): first/last name 2–35, address ≥ 6, city 3–25, postcode, phone exactly 10 digits, email.
- Shipping method values: radio `value` for cold-packed is `cold_packed_express` / `cold_packed_express_discounted` and a `useEffect` forces these whenever cold-packed items are present; initial state may be `cold_packed_shipping[_discounted]`. Accept all four.
- **No prices/totals are sent** — the server must recompute: product prices, GST, shipping (rules 5.15), coupon, points (`redeemRequested` uses the redemption already reserved by `user-points`), protection, gifts.
- Card payments are pre-authorised client-side with PayWay 3-D Secure (`/api/3d-auth`, merchant id in code) before this call; the server charges using `nonceFromTheClientBT` (a PayWay single-use token).

Response success `data`:
- card: `id` (order id) → redirect `/order-status/?pstatus=paid&orderid=<id>`
- afterpay: `afterPayApproveToken` → redirect `AFTERPAY_CHECKOUT_URL/?token=…`
- paypal: `payPalApproveToken` → redirect `PAYPAL_CHECKOUT_URL?token=…`
Response failure `data`:
- `stockIssue: true` → `/order-status/?pstatus=stockfailed`
- `transaction_status: "suspended"`, `id` → `/order-status/?pstatus=suspended&orderid=<id>` (shown as received)
- otherwise → `/order-status/?pstatus=failed`

### 5.13 `POST handle-order-payment-paypal` / `POST handle-order-payment-afterpay` [PT]
Caller: `pages/order-status.js` (SSR) on return from PayPal/Afterpay. The return URLs are generated by the server when creating the PayPal order / Afterpay checkout and must look like:

`/order-status?source=paypal|afterpay&pstatus=payment-processing|payment-declined|paid&token=<paypal token>&orderToken=<afterpay token>&orderid=<id>`

(`pstatus=payment-processing` → `tokenType:"approved"`, `payment-declined` → `"declined"`; any other `pstatus` with a `source` → no call.)

Request PayPal: `{ paypal_payment_token, paypal_token_type: "approved"|"declined" }`.
Request Afterpay: `{ afterpay_payment_token, afterpay_token_type }`.
Response success `data`: SuccessOrderInfo (8.4) (`id` required). Failure `data.id` (optional) → "Payment Failed".
Behaviour: capture/void the payment and finalise the order (stock, points, emails).

### 5.14 PayWay 3-D Secure (Next route `/api/3d-auth`, not upstream)
Caller: `CheckOutForm.js`. Next posts form-urlencoded to `https://api.payway.com.au/rest/v1/single-use-tokens/<promiseToken>/three-ds2-authentication` with a Basic secret key hard-coded in `pages/api/3d-auth.js`. Body fields: `merchantId, principalAmount, currency=aud, messageCategory=01, threeDSRequestorAuthenticationInd=01, email, billAddrLine1, billAddrCity, billAddrPostCode`. `transStatus` `C` → challenge iframe; `A`/`Y` → proceed; else error.
`principalAmount` = subtotal − coupon (standard shipping) else subtotal + shipping − coupon (frontend approximation; ignores protection/points).

### 5.15 Totals and shipping rules (frontend, must match server)

- Item tax: `round2(TAX_RATE * lineTotal / 100)` only if `is_taxable`; cart `tax` = Σ item tax. Prices are GST-inclusive.
- Shipping:
  - Any cart item in category named **"cold packed supplements"** (case-insensitive) → cold-packed express only: `EXPRESS_COLD_PRODUCT_SHIPPING_CHARGES` (19.95) if `(subtotal − reedemPointsAmount) < 100`, else `…_DISCOUNTED` (9.95).
  - Else `standard`: free if `subtotal > 99` (checkout total uses `subtotal + protection − discount − points > 99`), else 9.95; `express` 19.95; `australia_post_standard` 10.95; `express_free` 0 (legacy).
  - `freeShippingViaCoupon` or `collectFromWarehouse` → 0.
  - Shipping GST = `round2(shippingCost * TAX_RATE / 100)`.
- Order total = subtotal + protection + shipping − coupon discount − redeemed $.
- Click & Collect offered only for postcodes: 2483–2490, 4205, 4207–4221, 4223–4230, 4270–4272, 4275, 4280, 4285, 4287 (list in `CheckOutForm.js`).
- Country fixed to `AU`; states ACT, NSW, NT, QLD, SA, TAS, VIC, WA.

---

## 6. Orders

### 6.1 `POST order-history` [PT]
Callers: `pages/account/dashboard/index.js` (`{token, limit:"5"}`), `pages/account/dashboard/orders.js` (`{token, paged, limit:10}`; called with a relative URL from `getInitialProps`, so it only works client-side).
Response `data`: `orderlist: OrderListItem[]`, `pagination` (shape C), `arg` (logged only).
OrderListItem: `{ id, date_created (display string), total (display string), status, products: [{ id, name, slug, product_quantity, images: [{src}] }] }`.

### 6.2 `POST order-detail` [PT]
Caller: `pages/account/dashboard/order/[orderid].js` (SSR). Request: `order_id` only — **no user token is sent** (server should still enforce ownership; see Open questions).
Response `data.order`: OrderDetail (8.3).

### 6.3 `POST complete-order` [PT]
Caller: `pages/order-complete/[orderid].js` (SSR; page only for logged-in users) — "pay for pending order". Request: `orderid`.
Response `data` (PendingOrder): `order_id`, `products: [{ productId, product_id, id, qty, quantity, name, price, image, slug }]`, `totalProductsPrice` (number), `total_discount`, `subtotal`, `tax`, `otherFields: { email }`, `billing: {firstName,lastName,address,address2,city,country,state,postalCode,phone,company}`, `shipping: {same}`.

### 6.4 `POST update-order` [PT] (Next route `complete-order`)
Caller: `src/components/order-complete/CheckOutForm.js`. Body = order-complete form state (same keys as 5.12 `otherFields/billing/shipping/…/paymentMethod/shippingMethod`) plus `orderProductInfo: [{id, qty}]`, `orderId`, `nonceFromTheClientBT` (Braintree hosted-fields nonce on this page). Response identical to 5.12 (`id` / `afterPayApproveToken` / `payPalApproveToken`); failure shows top-level `message`.

### 6.5 `POST get-success-order-info` [PT]
Caller: `pages/order-status.js` (`pstatus=paid` or `suspended`). Request: `order_id`.
Response `data`: SuccessOrderInfo (8.4). On success the frontend clears the local cart and fires GA4/FB purchase events.

---

## 7. Rewards / wishlist / offers

### 7.1 `POST get-user-points/` [PT]
Caller: checkout `OrderSummary.js` (logged-in). Request `{ token }`.
Response `data`: `{ current_points: number, remaining_points: number, redeemed_points: number, has_redeemed: boolean, tier: "gold"|"sapphire"|"platinum", gr8_points_min_redeem_points: number, tier_min_cart_amount: number }`.
`has_redeemed` drives `redeemRequested` (persisted reservation).

### 7.2 `POST user-points` [PT] (Next route `redeem-point`) — redeem points
Caller: checkout `OrderSummary.js`. Request `{ token, TotalAmount: cart.totalProductsPrice, products: CartItem[] }`.
Response success `data`: `{ remaining_points, redeemed_points, redeemable_amount ($ number) }` → stored as `cart.reedemPointsAmount` and subtracted from total.
Failure: UI reads top-level `message` ("Unable to fetch points…" fallback). Expected failure reasons: below `gr8_points_min_redeem_points`, cart below `tier_min_cart_amount`, practitioner products, etc.
Rules: conversion advertised as **125 points = $5**; redemption reset whenever subtotal changes (frontend), cannot combine with coupons; points expire 12 months; tiers evaluated annually.

### 7.3 `POST get-rewards-info` [PT]
Caller: `pages/rewards.js`. Request: none (`{}`/empty).
Response `data`:
- `reward_actions`: `{ profile_complete, signup, birthday, follow_facebook, follow_instagram, follow_tiktok, follow_google_review, google_review, referral, referral_after_first_order }` each `{ points: number }`.
- `reward_tiers`: `{ gold|sapphire|platinum: { name: string, rate: number (points per $1) } }` (object, order = display order). UI copy: Gold on signup, next tier at $850 / 12 months, top tier at $2000 / 12 months.

### 7.4 `POST social-follow/` [PT]
Caller: `src/functions.js#handleClaimReward`. Request `{ token, platform: "facebook"|"instagram"|"tiktok"|"google_review" }`.
Response: message read as `data.data.message || data.message`. One-time award per platform (flags `gr8_followed_*` in user_meta).

### 7.5 `POST get-user-wishlist-api` [PT]
Caller: `src/functions.js#getUserWishlistDataFromApi` (on login). Request `{ token }`.
Response `data`: **array** of CartItem-shaped items (`productId, image, name, price, slug, …`); empty/failed → wishlist cleared.

### 7.6 `POST add-item-to-wishlist-api` / `POST remove-item-from-wishlist-api` — via custom Next route `/api/wishlist`
Caller: `src/components/wishlist/WishListButton.js`. Browser → Next `{ actionToPerform: "add"|"remove", productId, authToken }`; Next → upstream `{ "_auht_token": authToken, "product_id": productId }`. Response reshaped to `{ success }`.

Offers endpoints are in §5 (`cart-rewards`, `check-offer-checkout/`, `free-gift-offer-api`, `get-otheroffers/`, `validate-coupon-new`) and §4.8 (`shop-by-offer-page`).

---

## 8. Content / blog / pages / menus

### 8.0 `POST home-page-info`
Callers: `pages/index.js` SSR **directly** (`fetch(API_PATH + "/home-page-info")` with Basic auth), and `pages/home-duplicate.js` via `home-page-info-api` [PT]. Request `{ get_home_page_info: true }`.
Response `data`:

| field | shape |
|---|---|
| `seoMeta` | SeoMeta |
| `banners` | `[{ main_banner_desktop_image, main_banner_mobile_image, main_banner_desktop_alt, main_banner_mobile_alt, main_banner_link }]` |
| `topBannerTitle`, `top_banner_description` | string |
| `bannerImage` | string (story banner fallback `/demo-banner-img.jpg`) |
| `categoryTab` | `[{ tab_id, tab_name, sub_cat: [{ sub_name, sub_slug }] }]` |
| `shopByDepartment` | `[{ slug, name, thumbnail }]` (links `/c/<slug>`) |
| `ourNaturopathsPick` | Product[] |
| `blogSection` | BlogPost[] (list shape) |
| `showGr8Stories` | `"show"`\|`"hide"` |
| `gr8Stories` | `{ stories: [{ title, story_type: "video_story"|"image_story", banner_image, video_url, image_story_fields: [{ story_image, caption, button_info: { button_url } }] }] }` |
| `BrandBannerSlider` | `[{ brand_link, brand_slider_image, brand_slider_image_mobile }]` |
| `brandList` | `[{ slug, name, image }]` |

### 8.0a `POST home-banners-info` [PT, no body] — Next route exists, no caller found. Probably same `banners` shape.

### 8.1 Blog

- `POST get-bloglist` [PT] — callers `pages/blog/index.js` (`{limit:12, paged}`), `pages/blog/c/[slug].js` (`{limit:12, paged, cat_slug}`), sitemap (`{limit:1000}`). Response `data`: `blogList: BlogPost[]`, `pagination` (shape A), `seoMeta`, `cat_fullname` (category pages).
- `POST get-author-bloglist` [PT] — `pages/p/authors/[slug].js`, `{limit:12, paged, aslug}`. Response `data`: `blogList`, `pagination` (A), `author_img`, `nicename`, `userDesc`.
- `POST single-blog` [PT] — `pages/blog/[slug].js`, `{slug}`. Response `data.postDetail`: `{ title (html), nicename, imageUrl, description (html; `<img>` URLs on content host get rewritten to `/_next/image`), seoMeta, relativeProduct: [{ slug, title (html), images: [{src}] }], bslug, author_slug, publish_dt, short_description }` (last four used in JSON-LD). Failure → 404.
- `POST get-post-categories` [PT, no body] — `src/components/blog/PostCategories.js`. Response `data`: `[{ slug, name (html), subcat: [{ slug, name }] }]`.
- `POST authors` [PT, no body] — `pages/p/authors.js`. Response `data.authorData`: array (or index-keyed object) of `{ author_img, display_name, user_nicename, userDesc, userLinkedin, userFacebook, userInstagram }`.
- `POST get-wellness-method-blogs-api` [PT] — `src/functions.js#getRealtedBlogsWithFetch`, `{ wellness_method_cat: "<slug>" }` (slugs: cardiovascular-metabolic-health, childhood-health, digestive-health, fertility-pregnancy-post-partum, hormonal-health, immune-inflammation, mental-health, skin-issues). Response `data.blogList: BlogPost[]`.

### 8.2 `POST single-page` [PT]
Callers: `pages/p/[slug].js` (`{slug}`), `pages/quiz.js` (`{slug:"quiz"}`), `pages/p/about-us.js` (`{slug:"about-us"}`, SEO only). Response `data.pageDetail`: `{ title, description (html), imageUrl, seoMeta }`.

### 8.3 Menus

- `POST top-nav-bar-menu-info` [PT, cached] — `TopNavBarMenu.js`, `{ get_top_nav_bar_menu: true }`. Response `data`: MenuItem[] (cached in `sessionStorage.top_nav_menu`):
  - `type: "page"` → `{ type, name, background_color }` (rendered as non-link)
  - otherwise (category mega-menu) → `{ type, name, background_color (Tailwind colour token, e.g. "cyan"), category_info: { name (html), slug }, submenu: { category: [{id,name,slug}], brands: [{id,name,slug}], promotions: [{id,image,promotion_text,promotion_link}], "<Any heading>": [{id,name,slug}] } }`. `category_info.slug == "hot-buys"` styled specially.
- `POST top-nav-bar-momenu-info` [PT] — `TopNavBarMenuMobile.js`, same request. Response `data`: `{ menu: MenuItem[] (same shape), blogCat: [{ slug, name, subcat: [{slug, name}] }] }`.
- `POST footer-menu-info` [PT, cached] — `FooterMenu.js`, `{ get_footer_menu: true }`. Response `data`: **at least 4** columns `[{ heading, frontend_slug, items: [{ id, name (html), slug }] }]`; links `/<frontend_slug>/<slug>`. The frontend chunks them in pairs and mutates `[0][1]`, `[1][0]`, `[1][1]` (crashes with fewer than 4 columns). If the last item name is "Ambassadors" it is styled differently.

### 8.4 `POST announcement` [PT, no body]
Caller: `pages/_app.js` → `AnnouncementBar.jsx`. Response `data`: `{ enabled: boolean, title, subtitle, start_time, end_time }` (date strings parsable by `new Date()`; shown only when enabled and now within range; countdown to `end_time`).

---

## 9. Misc

| Endpoint | Caller | Request | Response used |
|---|---|---|---|
| `get-greviews` [PT, no body] | `FooterReview.js` | — | `data.rating` (number), `data.review_count` (number) — Google reviews summary |
| `get-feeds` (**GET**, no body; Next route is POST) | `InstagramFeed.js` | — | `data.feedArr: [{ permalink, img_url, media_type: "IMAGE"\|"VIDEO"\|… }]` — Instagram feed cache (images served from `scontent*.cdninstagram.com`) |
| `contact-submit` [PT] | `pages/contact-us/index.js` | `firstname, lastname, email, phone, message` | `data.message` both ways |
| `subsciber-newsletter` [PT] | `SubscriptionForm.js`, `alerts/SubscribePopUp.js`, `offers/OfferSubscribePopUp.js` | `emailAddress` | `data.message` both ways (likely Klaviyo list subscribe) |
| `send-download-notification` [PT] | `forms/EbookDownloadForm.js` (`/p/8-principles-health`) | `email, fullName, uniqueKey` (`"rules-for-healthy-life"` \| `"beautiful-glowing-skin"`) | `success` only — e-mail the e-book |

---

## 10. Third-party services called directly by the frontend

| Service | Where | Notes |
|---|---|---|
| Westpac **PayWay** (card) | `CheckOutForm.js` loads `https://api.payway.com.au/rest/v1/payway.js` (publishable key in code, `threeDS2:true`); `pages/api/3d-auth.js` calls 3DS2 auth with a secret key hard-coded in the route | The checkout's `paymentMethod: "braintree"` actually means PayWay card. |
| **Braintree** | `src/components/{checkout,order-complete}/BraintreeHostedFields.js` + `utils/gateway.js` (server SDK with production credentials **hard-coded** and imported client-side) — generates client token, hosted fields → nonce | Live only on the order-complete (pay pending order) page. |
| **PayPal** | redirect to `PAYPAL_CHECKOUT_URL?token=` | token created by `create-order-latest` / `update-order` |
| **Afterpay** | redirect to `AFTERPAY_CHECKOUT_URL/?token=`; product page loads `https://js.afterpay.com/afterpay-1.x.js` and `<afterpay-placement data-locale="en_AU" data-currency="AUD" data-amount>` | |
| **Klaviyo** | `window._learnq` events: "Started Checkout", identify, "Gr8Health Placed Order", "Gr8Health CheckBtn Click", "Added to Cart GR8", "Viewed Product GR8", "Social Reward Clicked", "Signed up for rewards", "Custom Profile Completed Gr8", "Referral Link Opened"; script via `KlaviyoScript.jsx` (`static.klaviyo.com`) | server-side list adds go through `klaviyo-practitioner/`, `subsciber-newsletter` |
| **Algolia** | `pages/search.js`, `src/components/algolia/*` — app id + search-only key in code; indices `gr8health_wp113_products`, `gr8health_wp113_posts`, `gr8health_wp113_pages` (16 hits/page) | WP plugin pushes these indices; the Node rebuild must keep indexing. Hit fields: products `slug, title, excerpt, excerpt2, featured_image, price, regular_price`; posts `slug, title, excerpt, featured_image, cat_name, cat_slug, color, author_img, nicename`; pages `title, content, featured_image` |
| reCAPTCHA v2 | `react-google-recaptcha` on login and signup with `NEXT_PUBLIC_CAPTCHA_KEY` | only a boolean `isHuman` reaches the API — **no token is verified server-side** |
| Google Maps Places | `CheckOutForm.js` (both) — browser key in code, AU restriction | address autocomplete |
| Google reviews | via `get-greviews`; review link `share.google/...` | |
| Instagram | via `get-feeds` | |
| Reviews.io | `useInitRatingSnippet` (`ratingSnippet`, store `gr8health.com.au`), `ProductReviewsIoWidget` (hidden) | |
| api.ipify.org | `src/functions.js#getUserIP`, `CheckOutForm.js` | IP sent as `userPublicIp` / `ipAddress` |
| Others | GTM/gtag, Facebook Pixel (`fbq`), RevenueHunt quiz (`pages/quiz.js`), Gorgias chat, PracticeBetter booking links | no API contract |

### 10.1 Media / image URL expectations

- `next.config.js images.domains`: `content-test.gr8health.com.au`, `content.gr8health.com.au`, `www.co2neutralwebsite.com`, `scontent-syd2-1.cdninstagram.com`, `scontent.cdninstagram.com`. Any image URL rendered with `next/image` (product images, offer images, brand images, author avatars, Instagram, gift/cart images, sale photos) **must be on one of these hosts** or a site-relative path, otherwise Next throws.
- `utils/optimizedImage.js` and `utils/miscellaneous.js#optimizeContentImages` route images on `content.gr8health.com.au` (and `staging.content.gr8health.com.au`) through `/_next/image?url=…&w=…`; others are left as-is.
- Expected pattern: WordPress uploads, `https://content.gr8health.com.au/wp-content/uploads/YYYY/MM/<file>` (hard-coded examples exist). One legacy background uses `https://gr8health.com.au/wp/wp-content/uploads/...`.
- Fallback image `/demo-product-img.png` when a product has no image.
- If the Node server serves media from a new host, add it to `images.domains` and `OPTIMIZER_HOSTS`/`IMAGE_OPTIMIZATION_DOMAINS`.

---

## 11. Shared data shapes

### 11.1 Product (as returned by catalog endpoints)

| field | type | used by |
|---|---|---|
| `id` | number | everywhere (cart `productId`) |
| `name` | string | cards, cart (fallback `title`) |
| `title` | string | fallback name (some lists) |
| `slug` | string | URL `/<slug>` |
| `price` | number\|numeric string | current price (`parseFloat`) |
| `regular_price` | number\|numeric string | strike-through when `price != regular_price`; discount % = floor((rp−p)/rp·100) |
| `short_description` | html | cards, product page, share |
| `description` | html | product page |
| `sku` | string | product code, Reviews.io |
| `images` | `[{ id, src }]` | `[0]` main image; rest thumbnails |
| `featured_image` | string | fallback image |
| `gallary` | `[{ image }]` | product gallery (prepended with `images[0]`) |
| `productExtraTags` | string[] of `new`, `sale`, `nutritionlist_top_pick`, `outofstock` | badge (later wins: NEW → HOT BUY → Top pick → SOLD OUT); `outofstock` hides Add-to-cart and shows Notify-me |
| `access_level` | `"none"`\|`"access_level_1"`\|`"access_level_2"` | practitioner gating |
| `sale_photo` | string | overlay image for access-level products |
| `productOfferForSales` | `[{ productOfferImg }]` | overlay fallback |
| `manage_stock` | boolean | show "Stock left" and enforce qty |
| `stock_quantity` | number | max addable when `backorders == "no"` |
| `backorders` | `"no"`\|`"notify"`\|`"yes"` | |
| `stock_status` | `"instock"`\|`"outofstock"`\|`"onbackorder"` | JSON-LD |
| `is_taxable` | boolean | GST calc |
| `categories` | `[{ name }]` or string[] or object | "cold packed supplements" detection; stored on cart item |
| `brand`, `brand_name`, `brand_slug` | string | brand link `/brands/<brand_slug>`; own-brand if slug `gr8-health`/`gr8health` or name "gr8 health" |
| `linkedProduct` | object `{ key: { slug, display_name } }` | "Select Version" dropdown (empty object when none) |
| `productCustomFields` | `{ ingredients, details, uses, serving_size }` (html) | overrides of `ingredients`, `featureDetail`, `uses` |
| `ingredients`, `featureDetail`, `uses` | html | fallbacks |
| `relatedBlog` | object `{ slug, title, post_excerpt, post_image, author_img, nicename }` or `{}` | product page |
| `seoMeta` | SeoMeta | product page |
| `status`, `redirect_to_url` | string | `product-exist` redirect |

Card endpoints may return a subset, but whatever is passed to `AddToCartButton` needs `id, name|title, price, slug, images|featured_image, is_taxable, access_level, categories, manage_stock, stock_quantity, backorders, productExtraTags, regular_price`.

### 11.2 Cart (`localStorage['gr8-woo-cart']`, also `user-cart-detail` response, `validate-coupon-new.cartInfo`)

```jsonc
{
  "products": [CartItem],
  "totalProductsCount": 3,          // int, Σ qty
  "totalProductsPrice": 59.85,      // number, Σ totalPrice (2dp)
  "tax": 5.44,                      // number, Σ item tax
  "gift": [GiftItem],               // optional
  "protection": { "productId", "image", "name", "price" } | {},   // optional
  "protection_backup": {...},       // optional (Click & Collect toggling)
  "reedemPointsAmount": 5           // optional, $ redeemed
}
```

CartItem: `{ productId, image, name, price (number), qty (int), slug, totalPrice (number, price*qty 2dp), tax (number), is_taxable (bool), access_level, categories }`.
GiftItem: `{ productId, image, name, price, qty, slug, totalPrice: 0, tax: 0, is_taxable: false, offer_type: "cart_offer"|"coupon_gift"|"brand_offer"|"minimum_offer"|"buy_get_free"|"carttier_offer" }`.

### 11.3 OrderDetail (`order-detail` → `data.order`)

`{ id, date_created, status ("pending" shows "Checkout" link to /order-complete/<id>), products: [{ product_id, product_name, images: [{src}], total (html money), quantity, description (html) }], billing: { first_name, last_name, address_1, address_2, city, state_name, country_name }, shipping: { same }, subtotal (html), shipping_method (truthy → show shipping_amount), shipping_amount (number/string), total_discount (number), total (html), total_tax (string) }`

### 11.4 SuccessOrderInfo (`get-success-order-info`, PayPal/Afterpay handlers)

`{ id, total (numeric string), currency ("AUD"), billing: { email }, line_items: { <k>: { product_id, product_name, total, quantity } } (object or array), product_ids: number[] }`

### 11.5 BlogPost (list shape)

`{ id, slug, title (html), excerpt (html), short_description (html/plain; first 100 chars used if no excerpt), imageUrl, cat_name (html), color (CSS colour for card background), author_img, author_slug, nicename, modified (sitemap) }`

### 11.6 SeoMeta

`{ title, metadesc, focuskw, og_title, og_img, og_url }`

### 11.7 MenuItem — see 8.3.

### 11.8 User — see 3.7.

---

## 12. Open questions (cannot be determined from the frontend)

1. **Token format**: exact plaintext payload produced by PHP (field order, extra fields, expiry?) and whether the server validates expiry. The frontend only needs `id, email, fname, user_access_level`. Is the token also stored server-side (revocable)? Cookie lifetime is 30 min / 5 days but server-side lifetime is unknown.
2. **`update-user-cart` with `newQty: 0`**: does it add 1 or nothing? `AddToCartButton` adds N locally but signals only one `add` without quantity, so server and local quantities can drift when N > 1.
3. **Price/total authority in `create-order-latest`**: confirm the server recomputes everything (prices, shipping incl. cold-packed and Click & Collect, protection price and tier waiver, gifts eligibility, points value) and ignores client `gift`/`protection.price`.
4. **Points redemption lifecycle**: does `user-points` reserve points server-side (so `create-order-latest` with `redeemRequested:true` applies it)? How is a reservation released if the cart changes (frontend only resets locally) or checkout is abandoned? Exact conversion (125 pts = $5?) and the meaning of `gr8_points_min_redeem_points` / `tier_min_cart_amount`.
5. **Tier rules**: points earn `rate` per $1 by tier; thresholds ($850 / $2000 in 12 months per UI copy) and tier-bonus amounts; which tiers get free shipping protection (frontend says sapphire/platinum).
6. **Offer engine** (`check-offer-checkout/`, `cart-rewards`, `free-gift-offer-api`): configuration source and rules (brand offer, minimum spend, buy-X-get-Y, tier gifts, how many `cart_offer` gifts may be chosen). Also whether gifts are validated server-side at order time.
7. **`validate-coupon-new`**: exact error key (`Message` vs `message`), how `gift_coupon` is configured, per-user limits, whether coupons apply before or after protection/shipping.
8. **PayPal/Afterpay return URLs**: exact query parameter names the server must put in redirect/cancel URLs (`source`, `pstatus`, `token`, `orderToken`, `orderid`, `status`); Afterpay's own `status=SUCCESS|CANCELLED` param is also read but unused.
9. **Payment gateways**: card charge via PayWay single-use token (`nonceFromTheClientBT`) in `create-order-latest` but via Braintree nonce in `update-order` — confirm both are still supported; `transaction_status: "suspended"` semantics (fraud review?).
10. **`order-detail` and `complete-order` authorisation**: neither sends a user token; currently any order id can be fetched. Should the Node server require the token (frontend change needed)?
11. **`user-info/` failure semantics**: the Next route needs a non-2xx status for invalid tokens; confirm the PHP plugin returns 401/403 there.
12. **reCAPTCHA**: only `isHuman: true` is sent; is any server-side verification expected (would need the token added on the frontend)?
13. **Sort values** `best_seller` and `newest` definitions; meaning of `numberposts` vs `limit` across endpoints; whether `paged` is 1-based (assumed) and `''` = 1.
14. **`home-banners-info`, `get-ip-data`, `subsciber-newsletter` (non-api duplicate route), `hello`**: unused — confirm they can be dropped.
15. **`footer-menu-info`**: guaranteed column count/order (frontend mutates fixed indices).
16. **`get-feeds` / `get-greviews`**: cache refresh strategy and credentials for Instagram Graph / Google Places on the server.
17. **Algolia indexing**: the WP plugin presumably syncs `gr8health_wp113_*` indices; the Node rebuild needs an equivalent indexer with the same record fields.
18. **Address-book encoding**: arrays are comma-joined and values contain commas ("Skin, Hair & Nails"); how does the PHP side split them? Consider accepting JSON arrays as well.
19. **`authors` response**: array or index-keyed object (frontend uses `Object.keys(...)` then indexes by position).
20. **Hard-coded secrets in the frontend** (Braintree private key in `utils/gateway.js`, PayWay secret in `pages/api/3d-auth.js`, token AES passphrase in `src/functions.js`, Basic API key exposed via `src/api.js`): rotating any of these requires coordinated frontend changes; decide before the cut-over.
