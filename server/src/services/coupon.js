// WC_Coupon validation + WC_Discounts distribution.
const prisma = require('../db');
const { ApiError } = require('../lib/http');
const { round } = require('../lib/format');

const arr = (v) => (Array.isArray(v) ? v : []);
const err = (code, message) => new ApiError(400, code, message);

async function getCouponByCode(code) {
  return prisma.coupon.findUnique({ where: { code: String(code || '').trim().toLowerCase() } });
}

// items: [{ productId, variationId, parentCategoryIds, onSale, price (unit), quantity, subtotal }]
function itemIsValid(coupon, it) {
  const productIds = arr(coupon.productIds).map(Number);
  const excluded = arr(coupon.excludedProductIds).map(Number);
  const cats = arr(coupon.productCategories).map(Number);
  const exCats = arr(coupon.excludedProductCategories).map(Number);
  const ids = [it.productId, it.variationId].filter(Boolean);
  let valid = !productIds.length && !cats.length;
  if (productIds.length && ids.some((id) => productIds.includes(id))) valid = true;
  if (cats.length && it.categoryIds.some((c) => cats.includes(c))) valid = true;
  if (!valid) return false;
  if (ids.some((id) => excluded.includes(id))) return false;
  if (it.categoryIds.some((c) => exCats.includes(c))) return false;
  if (coupon.excludeSaleItems && it.onSale) return false;
  return true;
}

// Throws WC-style errors (same messages the WC cart uses)
async function validateCoupon(coupon, {
  items, subtotal, customerId, email, enabled = true, code: requestedCode = '',
}) {
  const code = coupon ? coupon.code : requestedCode;
  if (!enabled) throw err('woocommerce_rest_coupons_disabled', 'Coupons are disabled.');
  if (!coupon || coupon.status !== 'publish') throw err('woocommerce_rest_invalid_coupon', `Coupon "${code}" does not exist!`);
  if (coupon.dateExpires && coupon.dateExpires < new Date()) throw err('woocommerce_rest_invalid_coupon', 'This coupon has expired.');
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) throw err('woocommerce_rest_invalid_coupon', 'Coupon usage limit has been reached.');
  if (coupon.usageLimitPerUser && (customerId || email)) {
    // Indexed count on CouponUsage (couponId, usedBy) — no unbounded JSON list
    const who = [customerId ? String(customerId) : null, email ? String(email).toLowerCase() : null].filter(Boolean);
    const used = await prisma.couponUsage.count({ where: { couponId: coupon.id, usedBy: { in: who } } });
    if (used >= coupon.usageLimitPerUser) throw err('woocommerce_rest_invalid_coupon', 'Coupon usage limit has been reached.');
  }
  if (coupon.minimumAmount !== null && Number(coupon.minimumAmount) > 0 && subtotal < Number(coupon.minimumAmount)) {
    throw err('woocommerce_rest_invalid_coupon', `The minimum spend for this coupon is ${Number(coupon.minimumAmount).toFixed(2)}.`);
  }
  if (coupon.maximumAmount !== null && Number(coupon.maximumAmount) > 0 && subtotal > Number(coupon.maximumAmount)) {
    throw err('woocommerce_rest_invalid_coupon', `The maximum spend for this coupon is ${Number(coupon.maximumAmount).toFixed(2)}.`);
  }
  const emails = arr(coupon.emailRestrictions).map((e) => String(e).toLowerCase());
  if (emails.length) {
    const e = String(email || '').toLowerCase();
    const ok = emails.some((pattern) => (pattern.includes('*') ? new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(e) : pattern === e));
    if (!ok) throw err('woocommerce_rest_invalid_coupon', 'Sorry, it seems this coupon is not yours.');
  }
  const valid = items.filter((it) => itemIsValid(coupon, it));
  if (coupon.discountType !== 'fixed_cart' || arr(coupon.productIds).length || arr(coupon.productCategories).length) {
    if (!valid.length) throw err('woocommerce_rest_invalid_coupon', 'Sorry, this coupon is not applicable to selected products.');
  }
  if (coupon.excludeSaleItems && coupon.discountType === 'fixed_cart' && items.every((i) => i.onSale)) {
    throw err('woocommerce_rest_invalid_coupon', 'Sorry, this coupon is not valid for sale items.');
  }
}

// Applies coupons to items in place: item.discount accumulates. Amounts in store currency, unrounded to dp+2.
// remaining price per item = subtotal - discount (for sequential discounts)
function applyCoupons(coupons, items, { dp, sequential }) {
  const couponTotals = {};
  for (const coupon of coupons) {
    const valid = items.filter((it) => itemIsValid(coupon, it));
    const base = (it) => (sequential ? it.subtotal - it.discount : it.subtotal);
    let applied = 0;
    if (coupon.discountType === 'percent') {
      let limitLeft = coupon.limitUsageToXItems || Infinity;
      for (const it of valid) {
        const qty = Math.min(it.quantity, limitLeft);
        if (qty <= 0) continue;
        limitLeft -= qty;
        const unitBase = base(it) / it.quantity;
        const d = Math.min(round(unitBase * qty * (Number(coupon.amount) / 100), dp + 2), it.subtotal - it.discount);
        it.discount += d;
        applied += d;
      }
    } else if (coupon.discountType === 'fixed_product') {
      let limitLeft = coupon.limitUsageToXItems || Infinity;
      for (const it of valid) {
        const qty = Math.min(it.quantity, limitLeft);
        if (qty <= 0) continue;
        limitLeft -= qty;
        const d = Math.min(Number(coupon.amount) * qty, it.subtotal - it.discount);
        it.discount += d;
        applied += d;
      }
    } else {
      // fixed_cart: split across eligible items proportionally to their remaining price
      const pool = valid.length ? valid : [];
      const totalBase = pool.reduce((n, it) => n + Math.max(0, it.subtotal - it.discount), 0);
      let amount = Math.min(Number(coupon.amount), totalBase);
      if (totalBase > 0) {
        let distributed = 0;
        pool.forEach((it, idx) => {
          const remaining = Math.max(0, it.subtotal - it.discount);
          let d = idx === pool.length - 1 ? amount - distributed : round((remaining / totalBase) * amount, dp);
          d = Math.min(d, remaining);
          it.discount += d;
          distributed += d;
        });
        applied = distributed;
      } else amount = 0;
    }
    couponTotals[coupon.code] = applied;
  }
  return couponTotals;
}

module.exports = { getCouponByCode, validateCoupon, applyCoupons, itemIsValid };
