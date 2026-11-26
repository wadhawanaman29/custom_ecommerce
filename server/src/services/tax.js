// WC_Tax equivalent: rate matching by location/class/priority and tax calculation.
const prisma = require('../db');
const { round } = require('../lib/format');

function postcodeMatches(patterns, postcode) {
  if (!Array.isArray(patterns) || !patterns.length) return true;
  const pc = String(postcode || '').toUpperCase().replace(/\s+/g, '');
  return patterns.some((raw) => {
    const p = String(raw).toUpperCase().replace(/\s+/g, '');
    if (p.includes('...')) {
      const [a, b] = p.split('...');
      const n = parseInt(pc, 10);
      return Number.isFinite(n) && n >= parseInt(a, 10) && n <= parseInt(b, 10);
    }
    if (p.includes('*')) return pc.startsWith(p.replace(/\*.*$/, ''));
    return p === pc;
  });
}

function cityMatches(cities, city) {
  if (!Array.isArray(cities) || !cities.length) return true;
  const c = String(city || '').toUpperCase().trim();
  return cities.some((x) => String(x).toUpperCase().trim() === c);
}

let ratesCache = null;
let ratesCacheAt = 0;
async function allRates() {
  if (!ratesCache || Date.now() - ratesCacheAt > 30000) {
    ratesCache = await prisma.taxRate.findMany({ orderBy: [{ priority: 'asc' }, { order: 'asc' }] });
    ratesCacheAt = Date.now();
  }
  return ratesCache;
}
function clearRatesCache() { ratesCache = null; }

// Returns matched rates (one per priority), like WC_Tax::find_rates
async function findRates({ country = '', state = '', postcode = '', city = '' }, taxClass = '') {
  const cls = taxClass && taxClass !== 'standard' ? taxClass : 'standard';
  const C = String(country).toUpperCase();
  const S = String(state).toUpperCase();
  const matched = (await allRates()).filter((r) => r.class === cls
    && (r.country === '' || r.country.toUpperCase() === C)
    && (r.state === '' || r.state.toUpperCase() === S)
    && postcodeMatches(r.postcodes, postcode)
    && cityMatches(r.cities, city));
  const seen = new Set();
  const out = [];
  for (const r of matched) {
    if (seen.has(r.priority)) continue;
    seen.add(r.priority);
    out.push(r);
  }
  return out;
}

// Returns { [rateId]: amount } (unrounded), like WC_Tax::calc_tax
function calcTax(price, rates, inclusive = false) {
  const taxes = {};
  if (!rates.length || !price) return taxes;
  if (!inclusive) {
    let preCompound = 0;
    for (const r of rates) {
      if (r.compound) continue;
      taxes[r.id] = (price * Number(r.rate)) / 100;
      preCompound += taxes[r.id];
    }
    let running = price + preCompound;
    for (const r of rates) {
      if (!r.compound) continue;
      taxes[r.id] = (running * Number(r.rate)) / 100;
      running += taxes[r.id];
    }
    return taxes;
  }
  // Inclusive: back the tax out of the price
  const compound = rates.filter((r) => r.compound);
  const regular = rates.filter((r) => !r.compound);
  let nonCompoundPrice = price;
  for (const r of [...compound].reverse()) {
    const t = nonCompoundPrice - nonCompoundPrice / (1 + Number(r.rate) / 100);
    taxes[r.id] = t;
    nonCompoundPrice -= t;
  }
  const regularRate = 1 + regular.reduce((n, r) => n + Number(r.rate), 0) / 100;
  const net = nonCompoundPrice / regularRate;
  for (const r of regular) {
    taxes[r.id] = (net * Number(r.rate)) / 100;
  }
  return taxes;
}

const sumTaxes = (taxes) => Object.values(taxes).reduce((a, b) => a + b, 0);
const roundTaxes = (taxes, dp) => Object.fromEntries(Object.entries(taxes).map(([k, v]) => [k, round(v, dp + 2)]));

// Shipping tax rates: shipping-enabled rates for the shipping tax class
async function findShippingRates(location, shippingTaxClass, itemTaxClasses = []) {
  let cls = shippingTaxClass;
  if (!cls || cls === 'inherit') {
    // WC: use the class of the cart items if they all share one, else standard
    const uniq = [...new Set(itemTaxClasses.map((c) => c || 'standard'))];
    cls = uniq.length === 1 ? uniq[0] : 'standard';
  }
  return (await findRates(location, cls)).filter((r) => r.shipping);
}

module.exports = { findRates, findShippingRates, calcTax, sumTaxes, roundTaxes, clearRatesCache, postcodeMatches };
