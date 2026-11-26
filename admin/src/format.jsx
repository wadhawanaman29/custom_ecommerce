export const STATUS_LABELS = {
  pending: 'Pending payment', processing: 'Processing', 'on-hold': 'On hold', completed: 'Completed',
  cancelled: 'Cancelled', refunded: 'Refunded', failed: 'Failed', 'checkout-draft': 'Draft', trash: 'Trash',
};
export const POST_STATUS = { publish: 'Published', draft: 'Draft', pending: 'Pending', private: 'Private', future: 'Scheduled', trash: 'Trash' };

let currency = { symbol: '$', code: 'USD' };
export const setCurrency = (c) => { currency = c; };
export const getCurrency = () => currency;

const decode = (s) => {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
};

export function price(v) {
  if (v === '' || v === null || v === undefined) return '–';
  const n = Number(v);
  return `${decode(currency.symbol || '')}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function date(v, withTime = false) {
  if (!v) return '–';
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : v);
  if (Number.isNaN(d.getTime())) return v;
  return withTime ? d.toLocaleString() : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
export const decodeHtml = (s) => decode(String(s || ''));

// "2024-05-03T10:20:30" → value for <input type="datetime-local"> and back
export const toLocalInput = (v) => (v ? String(v).slice(0, 16) : '');
export const fromLocalInput = (v) => (v ? `${v}:00` : '');
export const toDateInput = (v) => (v ? String(v).slice(0, 10) : '');

export function stockLabel(p) {
  if (p.stock_status === 'outofstock') return <span className="stock-out">Out of stock</span>;
  if (p.stock_status === 'onbackorder') return <span className="stock-back">On backorder</span>;
  return <span className="stock-in">In stock{p.manage_stock && p.stock_quantity !== null ? ` (${p.stock_quantity})` : ''}</span>;
}
