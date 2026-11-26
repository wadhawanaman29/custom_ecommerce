import { useState } from 'react';
import { Link } from 'react-router-dom';
import { custom } from '../api';
import { useResource } from '../hooks';
import { date, price, STATUS_LABELS } from '../format';
import { Loading, PageHeader, Postbox } from '../components/ui';

function SalesChart({ series }) {
  const max = Math.max(1, ...series.map((s) => s.sales));
  const w = 100 / series.length;
  return (
    <svg className="chart" viewBox="0 0 100 50" preserveAspectRatio="none" role="img" aria-label="Daily sales">
      {series.map((s, i) => {
        const h = (s.sales / max) * 46;
        return (
          <rect key={s.date} x={i * w + w * 0.15} y={48 - h} width={w * 0.7} height={Math.max(h, s.sales ? 0.5 : 0.15)} fill={s.sales ? '#2271b1' : '#dcdcde'}>
            <title>{`${s.date}: ${price(s.sales)} (${s.orders} orders)`}</title>
          </rect>
        );
      })}
      <line x1="0" y1="48" x2="100" y2="48" stroke="#c3c4c7" strokeWidth="0.2" />
    </svg>
  );
}

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const [stats, , { loading, error }] = useResource(custom(`admin/stats?days=${days}`), [days]);
  return (
    <>
      <PageHeader title="Dashboard">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option>
        </select>
      </PageHeader>
      {error && <div className="notice notice-error"><span>{error}</span></div>}
      {loading && !stats ? <Loading /> : stats && (
        <>
          <div className="cards">
            <div className="card"><div className="label">Sales ({days}d)</div><div className="value">{price(stats.sales)}</div></div>
            <div className="card"><div className="label">Orders ({days}d)</div><div className="value">{stats.orders}</div></div>
            <div className="card"><div className="label">Average order</div><div className="value">{price(stats.average_order)}</div></div>
            <div className="card"><div className="label">Today</div><div className="value">{price(stats.today_sales)} <small className="muted">/ {stats.today_orders}</small></div></div>
            <div className="card"><div className="label">Products</div><div className="value"><Link to="/products">{stats.products}</Link></div></div>
            <div className="card"><div className="label">Customers</div><div className="value"><Link to="/customers">{stats.customers}</Link></div></div>
          </div>
          <div className="dashboard-grid">
            <div>
              {stats.woo_status && (
                <div className="postbox woo-status">
                  <div className="postbox-header"><span>WooCommerce Status</span></div>
                  <Link className="ws-row" to="/analytics/revenue?period=month&chart=net_revenue">
                    <span className="ws-icon" aria-hidden="true">📊</span>
                    <span><strong className="ws-value">{price(stats.woo_status.net_sales_month)}</strong><small>net sales this month</small></span>
                  </Link>
                  {stats.woo_status.top_seller_month && (
                    <Link className="ws-row" to={`/products/${stats.woo_status.top_seller_month.product_id}`}>
                      <span className="ws-icon" aria-hidden="true">📦</span>
                      <span><strong className="ws-value">{stats.woo_status.top_seller_month.name}</strong><small>top seller this month (sold {stats.woo_status.top_seller_month.quantity})</small></span>
                    </Link>
                  )}
                  <div className="ws-grid">
                    <Link className="ws-row" to="/orders?status=processing"><span className="ws-icon ws-green" aria-hidden="true">•••</span><span><strong className="ws-value">{stats.woo_status.processing} order{stats.woo_status.processing === 1 ? '' : 's'}</strong><small>awaiting processing</small></span></Link>
                    <Link className="ws-row" to="/orders?status=on-hold"><span className="ws-icon ws-grey" aria-hidden="true">−</span><span><strong className="ws-value">{stats.woo_status.on_hold} order{stats.woo_status.on_hold === 1 ? '' : 's'}</strong><small>on-hold</small></span></Link>
                    <Link className="ws-row" to="/analytics/stock?type=lowstock"><span className="ws-icon ws-yellow" aria-hidden="true">!</span><span><strong className="ws-value">{stats.woo_status.low_in_stock} product{stats.woo_status.low_in_stock === 1 ? '' : 's'}</strong><small>low in stock</small></span></Link>
                    <Link className="ws-row" to="/analytics/stock?type=outofstock"><span className="ws-icon ws-red" aria-hidden="true">✕</span><span><strong className="ws-value">{stats.woo_status.out_of_stock} product{stats.woo_status.out_of_stock === 1 ? '' : 's'}</strong><small>out of stock</small></span></Link>
                  </div>
                </div>
              )}
              <Postbox title="Sales by day"><SalesChart series={stats.series} /><p className="muted">Paid orders (processing, completed, on hold). Hover a bar for details.</p></Postbox>
              <Postbox title="Recent orders" actions={<Link to="/orders">View all</Link>}>
                <table className="wp-list-table">
                  <thead><tr><th>Order</th><th>Date</th><th>Status</th><th className="right">Total</th></tr></thead>
                  <tbody>
                    {stats.recent_orders.map((o) => (
                      <tr key={o.id}>
                        <td><Link to={`/orders/${o.id}`}>#{o.number} {o.name}</Link></td>
                        <td>{date(o.date)}</td>
                        <td><span className={`status status-${o.status}`}>{STATUS_LABELS[o.status] || o.status}</span></td>
                        <td className="right">{price(o.total)}</td>
                      </tr>
                    ))}
                    {!stats.recent_orders.length && <tr className="empty"><td colSpan={4}>No orders yet.</td></tr>}
                  </tbody>
                </table>
              </Postbox>
            </div>
            <div>
              <Postbox title="Order status">
                <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                  {Object.entries(stats.status_counts).filter(([, n]) => n > 0).map(([s, n]) => (
                    <li key={s} className="flex" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                      <Link to={`/orders?status=${s}`}>{STATUS_LABELS[s] || s}</Link><strong>{n}</strong>
                    </li>
                  ))}
                </ul>
              </Postbox>
              <Postbox title="Stock">
                <p><Link to="/products?stock_status=outofstock">{stats.out_of_stock} out of stock</Link></p>
                {stats.low_stock.length > 0 && <><strong>Low stock</strong>
                  <ul>{stats.low_stock.map((p) => <li key={`${p.id}-${p.variation_id}`}><Link to={`/products/${p.id}`}>{p.name}</Link> — {p.stock} left</li>)}</ul></>}
              </Postbox>
              <Postbox title="Top sellers">
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {stats.top_products.map((t) => <li key={t.product_id}><Link to={`/products/${t.product_id}`}>{t.name}</Link> — {t.quantity} sold</li>)}
                  {!stats.top_products.length && <li className="muted" style={{ listStyle: 'none' }}>No sales in this period.</li>}
                </ol>
              </Postbox>
              {stats.pending_reviews > 0 && <div className="notice notice-warning"><span><Link to="/products/reviews?status=hold">{stats.pending_reviews} review(s) awaiting moderation</Link></span></div>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
