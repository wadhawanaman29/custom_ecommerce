import { useState } from 'react';
import { Link } from 'react-router-dom';
import { custom, wc } from '../../api';
import { useResource } from '../../hooks';
import { STATUS_LABELS, price } from '../../format';
import { Loading, PageHeader, Postbox } from '../../components/ui';

const PERIODS = [['week', 'Last 7 days'], ['month', 'Last 30 days'], ['year', 'Year']];
const DAYS = { week: 7, month: 30, year: 365 };

export default function Reports() {
  const [period, setPeriod] = useState('month');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const range = min && max ? `date_min=${min}&date_max=${max}` : `period=${period}`;
  const [sales, , { loading }] = useResource(wc(`reports/sales?${range}`), [range]);
  const [stats] = useResource(custom(`admin/stats?days=${DAYS[period]}`), [period]);
  const [orders] = useResource(wc('reports/orders/totals'));
  const [customers] = useResource(wc('reports/customers/totals'));
  const [products] = useResource(wc('reports/products/totals'));
  const s = sales && sales[0];
  return (
    <>
      <PageHeader title="Reports" />
      <div className="flex mb">
        {PERIODS.map(([k, l]) => <button key={k} type="button" className={`button ${period === k && !(min && max) ? 'button-primary' : ''}`} onClick={() => { setPeriod(k); setMin(''); setMax(''); }}>{l}</button>)}
        <span className="muted">Custom:</span>
        <input type="date" value={min} onChange={(e) => setMin(e.target.value)} aria-label="From" />
        <input type="date" value={max} onChange={(e) => setMax(e.target.value)} aria-label="To" />
      </div>
      {loading && !s ? <Loading /> : s && (
        <div className="cards">
          <div className="card"><div className="label">Gross sales</div><div className="value">{price(s.total_sales)}</div></div>
          <div className="card"><div className="label">Net sales</div><div className="value">{price(s.net_sales)}</div></div>
          <div className="card"><div className="label">Orders placed</div><div className="value">{s.total_orders}</div></div>
          <div className="card"><div className="label">Items purchased</div><div className="value">{s.total_items}</div></div>
          <div className="card"><div className="label">Refunded</div><div className="value">{price(s.total_refunds)}</div></div>
          <div className="card"><div className="label">Shipping</div><div className="value">{price(s.total_shipping)}</div></div>
          <div className="card"><div className="label">Tax</div><div className="value">{price(s.total_tax)}</div></div>
          <div className="card"><div className="label">Coupons used</div><div className="value">{price(s.total_discount)}</div></div>
        </div>
      )}
      <div className="grid-3">
        <Postbox title="Top sellers (period)">
          {stats ? <ol style={{ margin: 0, paddingLeft: 18 }}>{stats.top_products.map((t) => <li key={t.product_id}><Link to={`/products/${t.product_id}`}>{t.name}</Link> — {t.quantity} sold ({price(t.total)})</li>)}
            {!stats.top_products.length && <li className="muted" style={{ listStyle: 'none' }}>No sales.</li>}</ol> : <Loading />}
        </Postbox>
        <Postbox title="Orders by status">
          {orders ? <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>{orders.filter((o) => o.total).map((o) => <li key={o.slug} className="flex" style={{ justifyContent: 'space-between' }}><Link to={`/orders?status=${o.slug}`}>{STATUS_LABELS[o.slug] || o.name}</Link><strong>{o.total}</strong></li>)}</ul> : <Loading />}
        </Postbox>
        <Postbox title="Customers & products">
          {customers && products ? <dl className="kv">
            {[...customers, ...products].flatMap((x) => [<dt key={`${x.slug}-l`}>{x.name}</dt>, <dd key={`${x.slug}-v`}>{x.total}</dd>])}
          </dl> : <Loading />}
        </Postbox>
      </div>
    </>
  );
}
