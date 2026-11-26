// wp_options replacement with an in-memory cache (options are read on almost every request).
const prisma = require('../db');
const registry = require('./settings-registry');

let cache = null;
let loading = null;

async function load() {
  if (cache) return cache;
  if (!loading) {
    loading = prisma.option.findMany().then((rows) => {
      cache = new Map(rows.map((r) => [r.name, r.value]));
      loading = null;
      return cache;
    }).catch((e) => { loading = null; throw e; });
  }
  return loading;
}

async function getOption(name, fallback) {
  const map = await load();
  if (map.has(name)) return map.get(name);
  const def = registry.byId.get(name);
  if (fallback !== undefined) return fallback;
  return def ? def.default : undefined;
}

async function getOptions(names) {
  const out = {};
  for (const n of names) out[n] = await getOption(n);
  return out;
}

async function setOption(name, value) {
  await prisma.option.upsert({ where: { name }, create: { name, value }, update: { value } });
  const map = await load();
  map.set(name, value);
  return value;
}

function invalidate() { cache = null; }

// Store-wide values used by serializers and order calculations.
async function store() {
  const o = await getOptions([
    'woocommerce_currency', 'woocommerce_price_num_decimals', 'woocommerce_prices_include_tax',
    'woocommerce_calc_taxes', 'woocommerce_tax_based_on', 'woocommerce_default_country',
    'woocommerce_store_postcode', 'woocommerce_store_city', 'woocommerce_shipping_tax_class',
    'woocommerce_tax_round_at_subtotal', 'woocommerce_manage_stock', 'woocommerce_enable_coupons',
    'woocommerce_calc_discounts_sequentially', 'woocommerce_notify_no_stock_amount',
    'woocommerce_hide_out_of_stock_items', 'gmt_offset', 'blogname',
    'woocommerce_currency_pos', 'woocommerce_price_thousand_sep', 'woocommerce_price_decimal_sep',
  ]);
  const [country, state = ''] = String(o.woocommerce_default_country || '').split(':');
  return {
    currency: o.woocommerce_currency || 'USD',
    dp: parseInt(o.woocommerce_price_num_decimals, 10) || 0,
    pricesIncludeTax: o.woocommerce_prices_include_tax === 'yes',
    calcTaxes: o.woocommerce_calc_taxes === 'yes',
    taxBasedOn: o.woocommerce_tax_based_on || 'shipping',
    shippingTaxClass: o.woocommerce_shipping_tax_class || 'inherit',
    roundAtSubtotal: o.woocommerce_tax_round_at_subtotal === 'yes',
    manageStock: o.woocommerce_manage_stock !== 'no',
    couponsEnabled: o.woocommerce_enable_coupons !== 'no',
    sequentialDiscounts: o.woocommerce_calc_discounts_sequentially === 'yes',
    noStockAmount: parseInt(o.woocommerce_notify_no_stock_amount, 10) || 0,
    hideOutOfStock: o.woocommerce_hide_out_of_stock_items === 'yes',
    gmtOffset: parseFloat(o.gmt_offset) || 0,
    base: { country, state, postcode: o.woocommerce_store_postcode || '', city: o.woocommerce_store_city || '' },
    siteName: o.blogname,
    currencyPos: o.woocommerce_currency_pos || 'left',
    thousandSep: o.woocommerce_price_thousand_sep ?? ',',
    decimalSep: o.woocommerce_price_decimal_sep || '.',
  };
}

module.exports = { getOption, getOptions, setOption, invalidate, store };
