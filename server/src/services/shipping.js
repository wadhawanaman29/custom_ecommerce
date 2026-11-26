// Shipping zone matching and rate calculation (flat_rate / free_shipping / local_pickup), like WC_Shipping.
const prisma = require('../db');
const { postcodeMatches } = require('./tax');
const { round } = require('../lib/format');

const METHODS = {
  flat_rate: { title: 'Flat rate', description: 'Lets you charge a fixed rate for shipping.' },
  free_shipping: { title: 'Free shipping', description: 'Free shipping is a special method which can be triggered with coupons and minimum spends.' },
  local_pickup: { title: 'Local pickup', description: 'Allow customers to pick up orders themselves. By default, when using local pickup store base taxes will apply regardless of customer address.' },
};

// Settings schema per method (shape of WC_Shipping_Method instance form fields)
function methodSettingsSchema(methodId, shippingClasses = []) {
  const f = (id, label, type, def, extra = {}) => ({ id, label, description: '', type, value: def, default: def, tip: '', placeholder: '', ...extra });
  const common = [f('title', 'Method title', 'text', METHODS[methodId]?.title || '')];
  if (methodId === 'flat_rate') {
    return [
      ...common,
      f('tax_status', 'Tax status', 'select', 'taxable', { options: { taxable: 'Taxable', none: 'None' } }),
      f('cost', 'Cost', 'text', '0', { tip: 'Enter a cost (excl. tax) or sum, e.g. 10.00 * [qty]. Use [qty], [cost], [fee percent="10" min_fee="20" max_fee=""].' }),
      ...shippingClasses.map((c) => f(`class_cost_${c.id}`, `"${c.name}" shipping class cost`, 'text', '')),
      ...(shippingClasses.length ? [f('no_class_cost', 'No shipping class cost', 'text', ''), f('type', 'Calculation type', 'select', 'class', { options: { class: 'Per class: Charge shipping for each shipping class individually', order: 'Per order: Charge shipping for the most expensive shipping class' } })] : []),
    ];
  }
  if (methodId === 'free_shipping') {
    return [
      ...common,
      f('requires', 'Free shipping requires...', 'select', '', { options: { '': 'N/A', coupon: 'A valid free shipping coupon', min_amount: 'A minimum order amount', either: 'A minimum order amount OR a coupon', both: 'A minimum order amount AND a coupon' } }),
      f('min_amount', 'Minimum order amount', 'price', '0'),
      f('ignore_discounts', 'Coupons discounts', 'checkbox', 'no'),
    ];
  }
  return [...common, f('tax_status', 'Tax status', 'select', 'taxable', { options: { taxable: 'Taxable', none: 'None' } }), f('cost', 'Cost', 'text', '0')];
}

function zoneMatches(zone, dest) {
  const country = String(dest.country || '').toUpperCase();
  const state = String(dest.state || '').toUpperCase();
  const region = zone.locations.filter((l) => l.type !== 'postcode');
  const postcodes = zone.locations.filter((l) => l.type === 'postcode');
  if (!zone.locations.length) return false;
  const regionOk = !region.length || region.some((l) => {
    if (l.type === 'country') return l.code.toUpperCase() === country;
    if (l.type === 'state') return l.code.toUpperCase() === `${country}:${state}`;
    if (l.type === 'continent') return (CONTINENTS[l.code] || []).includes(country);
    return false;
  });
  const postcodeOk = !postcodes.length || postcodeMatches(postcodes.map((l) => l.code), dest.postcode);
  return regionOk && postcodeOk;
}

async function matchZone(dest) {
  const zones = await prisma.shippingZone.findMany({ include: { locations: true }, orderBy: [{ order: 'asc' }, { id: 'asc' }] });
  return zones.find((z) => zoneMatches(z, dest)) || null;
}

// Evaluates WC flat-rate cost formulas: "10 + 2 * [qty]", "[cost] * 0.1", [fee percent="10" min_fee="5"]
function evalCost(expr, { qty, cost }) {
  if (expr === undefined || expr === null || String(expr).trim() === '') return 0;
  let s = String(expr);
  s = s.replace(/\[fee([^\]]*)\]/g, (m, attrs) => {
    const get = (k) => { const r = new RegExp(`${k}="([^"]*)"`).exec(attrs); return r ? parseFloat(r[1]) : NaN; };
    let fee = Number.isFinite(get('percent')) ? cost * (get('percent') / 100) : 0;
    if (Number.isFinite(get('min_fee')) && fee < get('min_fee')) fee = get('min_fee');
    if (Number.isFinite(get('max_fee')) && fee > get('max_fee')) fee = get('max_fee');
    return String(fee);
  });
  s = s.replace(/\[qty\]/g, String(qty)).replace(/\[cost\]/g, String(cost));
  s = s.replace(/,/g, '.');
  if (!/^[\d.\s+\-*/()]+$/.test(s)) return 0;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${s});`)();
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

// package: { destination, items: [{ product, quantity, lineTotal }], subtotal, discountedSubtotal, freeShippingCoupon }
async function calculateRates(pkg) {
  const zone = await matchZone(pkg.destination);
  const methods = await prisma.shippingZoneMethod.findMany({
    where: { zoneId: zone ? zone.id : null, enabled: true }, orderBy: [{ order: 'asc' }, { instanceId: 'asc' }],
  });
  const qty = pkg.items.reduce((n, i) => n + i.quantity, 0);
  const rates = [];
  for (const m of methods) {
    const st = m.settings || {};
    const title = st.title || METHODS[m.methodId]?.title || m.methodId;
    if (m.methodId === 'flat_rate') {
      let cost = evalCost(st.cost, { qty, cost: pkg.subtotal });
      // Shipping class costs
      const byClass = new Map();
      for (const it of pkg.items) {
        const cid = it.product?.shippingClassId || 0;
        const e = byClass.get(cid) || { qty: 0, cost: 0 };
        e.qty += it.quantity; e.cost += it.lineTotal;
        byClass.set(cid, e);
      }
      const classCosts = [];
      for (const [cid, e] of byClass) {
        const exprKey = cid ? `class_cost_${cid}` : 'no_class_cost';
        if (st[exprKey] !== undefined && st[exprKey] !== '') classCosts.push(evalCost(st[exprKey], e));
      }
      if (classCosts.length) cost += st.type === 'order' ? Math.max(...classCosts) : classCosts.reduce((a, b) => a + b, 0);
      rates.push({ rate_id: `flat_rate:${m.instanceId}`, method_id: 'flat_rate', instance_id: m.instanceId, label: title, cost: round(cost, 4), taxable: (st.tax_status || 'taxable') === 'taxable' });
    } else if (m.methodId === 'free_shipping') {
      const min = parseFloat(st.min_amount) || 0;
      const total = st.ignore_discounts === 'yes' ? pkg.subtotal : pkg.discountedSubtotal;
      const hasMin = total >= min;
      const hasCoupon = !!pkg.freeShippingCoupon;
      const ok = {
        '': true, coupon: hasCoupon, min_amount: hasMin, either: hasMin || hasCoupon, both: hasMin && hasCoupon,
      }[st.requires || ''];
      if (ok) rates.push({ rate_id: `free_shipping:${m.instanceId}`, method_id: 'free_shipping', instance_id: m.instanceId, label: title, cost: 0, taxable: false });
    } else if (m.methodId === 'local_pickup') {
      rates.push({ rate_id: `local_pickup:${m.instanceId}`, method_id: 'local_pickup', instance_id: m.instanceId, label: title, cost: round(evalCost(st.cost, { qty, cost: pkg.subtotal }), 4), taxable: (st.tax_status || 'taxable') === 'taxable' });
    }
  }
  return { zone: zone ? { id: zone.id, name: zone.name } : { id: 0, name: 'Locations not covered by your other zones' }, rates };
}

// Country → continent (WooCommerce continent codes)
const CONTINENTS = {
  AF: 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW'.split(' '),
  AN: 'AQ BV GS HM TF'.split(' '),
  AS: 'AE AF AM AZ BD BH BN BT CC CN CX CY GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE'.split(' '),
  EU: 'AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK'.split(' '),
  NA: 'AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI'.split(' '),
  OC: 'AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS'.split(' '),
  SA: 'AR BO BR CL CO EC FK GF GY PE PY SR UY VE'.split(' '),
};

module.exports = { METHODS, methodSettingsSchema, matchZone, calculateRates, evalCost, CONTINENTS };
