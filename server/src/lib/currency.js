// Currency symbols (HTML entities, as WooCommerce outputs them) and price_html rendering.
const SYMBOLS = {
  USD: '&#36;', EUR: '&euro;', GBP: '&pound;', INR: '&#8377;', JPY: '&yen;', CNY: '&yen;', AUD: '&#36;', CAD: '&#36;',
  NZD: '&#36;', SGD: '&#36;', HKD: '&#36;', AED: '&#x62f;.&#x625;', SAR: '&#x631;.&#x633;', CHF: '&#67;&#72;&#70;',
  SEK: '&#107;&#114;', NOK: '&#107;&#114;', DKK: 'kr.', PLN: '&#122;&#322;', RUB: '&#8381;', BRL: '&#82;&#36;',
  MXN: '&#36;', ZAR: '&#82;', TRY: '&#8378;', KRW: '&#8361;', IDR: 'Rp', MYR: '&#82;&#77;', THB: '&#3647;',
  PHP: '&#8369;', PKR: '&#8360;', BDT: '&#2547;&nbsp;', NPR: '&#8360;', LKR: '&#3515;&#3540;', NGN: '&#8358;',
  KES: 'KSh', EGP: 'EGP', ILS: '&#8362;', VND: '&#8363;', UAH: '&#8372;', CZK: '&#75;&#269;', HUF: '&#70;&#116;',
};

const symbol = (code) => SYMBOLS[code] || code;

function formatAmount(amount, { dp = 2, thousandSep = ',', decimalSep = '.' } = {}) {
  const [int, dec] = Number(amount || 0).toFixed(dp).split('.');
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, thousandSep);
  return dec ? `${withSep}${decimalSep}${dec}` : withSep;
}

function amountHtml(amount, s) {
  const sym = `<span class="woocommerce-Price-currencySymbol">${symbol(s.currency)}</span>`;
  const num = formatAmount(amount, s);
  const formatted = {
    left: `${sym}${num}`,
    right: `${num}${sym}`,
    left_space: `${sym}&nbsp;${num}`,
    right_space: `${num}&nbsp;${sym}`,
  }[s.currencyPos || 'left'];
  return `<span class="woocommerce-Price-amount amount"><bdi>${formatted}</bdi></span>`;
}

// Mirrors WC_Product::get_price_html for simple/variable products
function priceHtml({ type, price, regularPrice, onSale, min, max }, s) {
  if (type === 'variable') {
    if (min === null || min === undefined) return '';
    if (min !== max) return `${amountHtml(min, s)} &ndash; ${amountHtml(max, s)}`;
    return amountHtml(min, s);
  }
  if (price === null || price === undefined || price === '') return '';
  if (onSale && regularPrice !== null && regularPrice !== undefined && regularPrice !== '') {
    return `<del aria-hidden="true">${amountHtml(regularPrice, s)}</del> <span class="screen-reader-text">Original price was: ${formatAmount(regularPrice, s)}.</span><ins aria-hidden="true">${amountHtml(price, s)}</ins><span class="screen-reader-text">Current price is: ${formatAmount(price, s)}.</span>`;
  }
  return amountHtml(price, s);
}

module.exports = { SYMBOLS, symbol, formatAmount, amountHtml, priceHtml };
