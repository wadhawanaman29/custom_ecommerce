import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, custom } from '../../api';
import { useQueryState } from '../../hooks';
import { STATUS_LABELS, date } from '../../format';
import { Loading, PageHeader, Postbox } from '../../components/ui';
import {
  DateRangeFilter, ReportChart, ReportTable, SummaryNumbers, computeRanges, fmt, intervalsFor, parseYmd,
} from '../../components/analytics';

const A = (p) => custom(`admin/analytics/${p}`);

// URL-synced report state (period, compare, custom dates, interval, selected chart metric)
function useReportState(defaultChart) {
  const [q, setQ] = useQueryState({ period: 'month', compare: 'previous_period', after: '', before: '', interval: '', chart: defaultChart, chart_type: 'line' });
  const ranges = useMemo(() => computeRanges(q), [q.period, q.compare, q.after, q.before]); // eslint-disable-line react-hooks/exhaustive-deps
  const interval = q.interval && intervalsFor(ranges.days).some(([k]) => k === q.interval) ? q.interval : ranges.defaultInterval;
  return { q, setQ, ranges, interval };
}

// Loads a report endpoint for the current and comparison ranges
function usePair(path, ranges, extra = {}) {
  const [state, setState] = useState({ cur: null, prev: null, error: null });
  const key = JSON.stringify([path, ranges.current, ranges.previous, extra]);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, cur: null, error: null }));
    Promise.all([api.get(A(path), { ...ranges.current, ...extra }), api.get(A(path), { ...ranges.previous, ...extra })])
      .then(([cur, prev]) => live && setState({ cur, prev, error: null }))
      .catch((e) => live && setState({ cur: null, prev: null, error: e.message }));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

const intervalLabel = (iv, interval) => {
  const d = parseYmd(iv.date_start);
  if (interval === 'day') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (interval === 'week') return `Wk of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  if (interval === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  if (interval === 'quarter') return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
  return String(d.getFullYear());
};
const longDate = (s) => parseYmd(s).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

// Shared page frame: header, date filter, cards, chart
function ReportFrame({
  title, state, metrics, totals, prevTotals, revenue, chartMap = {}, children, loading, error,
}) {
  const { q, setQ, ranges, interval } = state;
  const selected = metrics.some((m) => m.key === q.chart) ? q.chart : metrics[0].key;
  const metric = metrics.find((m) => m.key === selected);
  const chartKey = chartMap[selected] || selected;
  return (
    <>
      <PageHeader title={title} />
      <DateRangeFilter value={q} ranges={ranges} onChange={(v) => setQ({ period: v.period, compare: v.compare, after: v.period === 'custom' ? v.after : '', before: v.period === 'custom' ? v.before : '', interval: '' })} />
      {error && <div className="notice notice-error"><span>{error}</span></div>}
      {loading || !totals ? <Loading /> : (
        <>
          <SummaryNumbers metrics={metrics} totals={totals} previous={prevTotals} selected={selected} onSelect={(chart) => setQ({ chart })} />
          {revenue && (
            <div className="postbox chart-box">
              <div className="postbox-header">
                <span className="flex">
                  <span>{metric.label}</span>
                  <span className="legend"><span className="dot" style={{ background: '#1e4d8f' }} />{ranges.label.replace(/^.*\(/, '').replace(')', '')} <strong>{fmt[metric.format || 'money'](totals[selected])}</strong></span>
                  <span className="legend"><span className="dot" style={{ background: '#5ec27e' }} />{ranges.compareLabel.replace(/^.*\(/, '').replace(')', '')} <strong>{prevTotals ? fmt[metric.format || 'money'](prevTotals[selected]) : '–'}</strong></span>
                </span>
                <span className="flex">
                  <select value={interval} onChange={(e) => setQ({ interval: e.target.value })} aria-label="Interval">{intervalsFor(ranges.days).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  <button type="button" className={`button button-small ${q.chart_type === 'line' ? 'button-primary' : ''}`} onClick={() => setQ({ chart_type: 'line' })} title="Line chart">📈</button>
                  <button type="button" className={`button button-small ${q.chart_type === 'bar' ? 'button-primary' : ''}`} onClick={() => setQ({ chart_type: 'bar' })} title="Bar chart">📊</button>
                </span>
              </div>
              <div className="inside">
                <ReportChart
                  labels={revenue.cur.intervals.map((iv) => intervalLabel(iv, interval))}
                  current={revenue.cur.intervals.map((iv) => iv.subtotals[chartKey] || 0)}
                  previous={revenue.cur.intervals.map((_, i) => (revenue.prev.intervals[i] ? revenue.prev.intervals[i].subtotals[chartKey] || 0 : 0))}
                  format={metric.format || 'money'} type={q.chart_type}
                  currentLabel={ranges.label.replace(/ \(.*/, '')} previousLabel={ranges.compareLabel.replace(/^vs\. /, '').replace(/ \(.*/, '')}
                />
              </div>
            </div>
          )}
          {children}
        </>
      )}
    </>
  );
}

const REVENUE_METRICS = [
  { key: 'gross_sales', label: 'Gross sales' }, { key: 'refunds', label: 'Returns', lowerIsBetter: true }, { key: 'coupons', label: 'Coupons', lowerIsBetter: true },
  { key: 'net_revenue', label: 'Net sales' }, { key: 'taxes', label: 'Taxes' }, { key: 'shipping', label: 'Shipping' }, { key: 'total_sales', label: 'Total sales' },
];

export function RevenueReport() {
  const state = useReportState('net_revenue');
  const revenue = usePair('revenue', state.ranges, { interval: state.interval });
  const t = revenue.cur && revenue.cur.totals;
  const rows = revenue.cur ? revenue.cur.intervals.map((iv) => ({ key: iv.date_start, date: iv.date_start, date_end: iv.date_end, ...iv.subtotals })) : [];
  const money = (key, label) => ({ key, label, numeric: true, format: 'money' });
  return (
    <ReportFrame title="Revenue" state={state} metrics={REVENUE_METRICS} totals={t} prevTotals={revenue.prev && revenue.prev.totals} revenue={revenue.cur && revenue} loading={!revenue.cur && !revenue.error} error={revenue.error}>
      <ReportTable title="Revenue" csvName={`revenue_${state.ranges.current.after}_${state.ranges.current.before}`} rows={rows} defaultSort={{ key: 'date', order: 'desc' }}
        columns={[
          { key: 'date', label: 'Date', render: (r) => (state.interval === 'day' ? longDate(r.date) : `${longDate(r.date)} – ${longDate(r.date_end)}`) },
          { key: 'orders_count', label: 'Orders', numeric: true, render: (r) => <Link to={`/analytics/orders?period=custom&after=${r.date}&before=${r.date_end}`}>{r.orders_count}</Link> },
          money('gross_sales', 'Gross sales'), money('refunds', 'Returns'), money('coupons', 'Coupons'), money('net_revenue', 'Net sales'),
          money('taxes', 'Taxes'), money('shipping', 'Shipping'), money('total_sales', 'Total sales'),
        ]}
        summary={t && [[`${state.ranges.days}`, state.ranges.days === 1 ? 'day' : 'days'], [fmt.number(t.orders_count), 'orders'], [fmt.money(t.gross_sales), 'Gross sales'], [fmt.money(t.refunds), 'Returns'], [fmt.money(t.coupons), 'Coupons'], [fmt.money(t.net_revenue), 'Net sales'], [fmt.money(t.taxes), 'Taxes'], [fmt.money(t.shipping), 'Shipping'], [fmt.money(t.total_sales), 'Total sales']]}
      />
    </ReportFrame>
  );
}

export function OrdersReport() {
  const state = useReportState('orders_count');
  const revenue = usePair('revenue', state.ranges, { interval: state.interval });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'date', order: 'desc' });
  const [orders, setOrders] = useState({ rows: [], total: 0, loading: true });
  useEffect(() => setPage(1), [state.ranges.current.after, state.ranges.current.before]);
  useEffect(() => {
    setOrders((o) => ({ ...o, loading: true }));
    api.list(A('orders'), { ...state.ranges.current, page, per_page: 25, orderby: sort.key, order: sort.order })
      .then((r) => setOrders({ rows: r.data, total: r.total, loading: false })).catch(() => setOrders({ rows: [], total: 0, loading: false }));
  }, [state.ranges.current.after, state.ranges.current.before, page, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = revenue.cur && revenue.cur.totals;
  return (
    <ReportFrame title="Orders" state={state} totals={t} prevTotals={revenue.prev && revenue.prev.totals} revenue={revenue.cur && revenue} loading={!revenue.cur && !revenue.error} error={revenue.error}
      metrics={[{ key: 'orders_count', label: 'Orders', format: 'number' }, { key: 'net_revenue', label: 'Net sales' }, { key: 'avg_order_value', label: 'Average order value' }, { key: 'avg_items_per_order', label: 'Average items per order', format: 'decimal' }]}>
      <ReportTable title="Orders" csvName="orders" rows={orders.rows.map((o) => ({ ...o, id: o.order_id }))}
        serverPage={{ total: orders.total, page, perPage: 25, onPage: setPage, onSort: (s) => setSort(s) }}
        defaultSort={sort}
        columns={[
          { key: 'date', label: 'Date', render: (o) => date(o.date_created, true), csv: (o) => o.date_created },
          { key: 'order_number', label: 'Order #', render: (o) => <Link to={`/orders/${o.order_id}`}>{o.order_number}</Link>, csv: (o) => o.order_number },
          { key: 'status', label: 'Status', render: (o) => <span className={`status status-${o.status}`}>{STATUS_LABELS[o.status] || o.status}</span>, csv: (o) => o.status },
          { key: 'customer', label: 'Customer', sortable: false, render: (o) => (o.customer_id ? <Link to={`/customers/${o.customer_id}`}>{o.customer_name}</Link> : o.customer_name), csv: (o) => o.customer_name },
          { key: 'customer_type', label: 'Customer type', sortable: false, render: (o) => (o.customer_type === 'new' ? 'New' : 'Returning') },
          { key: 'products', label: 'Product(s)', sortable: false, render: (o) => o.products.map((p) => p.name).join(', '), csv: (o) => o.products.map((p) => `${p.quantity}× ${p.name}`).join('; ') },
          { key: 'num_items_sold', label: 'Items sold', numeric: true, sortable: false },
          { key: 'coupons', label: 'Coupon(s)', sortable: false, render: (o) => o.coupons.join(', ') || '—', csv: (o) => o.coupons.join(' ') },
          { key: 'net_total', label: 'Net sales', numeric: true, format: 'money' },
        ]}
        summary={t && [[fmt.number(t.orders_count), 'orders'], [fmt.money(t.net_revenue), 'net sales'], [fmt.money(t.avg_order_value), 'average order value'], [fmt.decimal(t.avg_items_per_order), 'average items per order']]}
      />
    </ReportFrame>
  );
}

function stockText(r) {
  if (!r.stock_status) return '—';
  const label = { instock: 'In stock', outofstock: 'Out of stock', onbackorder: 'On backorder' }[r.stock_status] || r.stock_status;
  return r.stock_quantity !== null && r.stock_quantity !== undefined ? `${label} (${r.stock_quantity})` : label;
}

export function ProductsReport({ variations = false }) {
  const state = useReportState('items_sold');
  const data = usePair('products', state.ranges, variations ? { type: 'variations' } : {});
  const revenue = usePair('revenue', state.ranges, { interval: state.interval });
  const t = data.cur && data.cur.totals;
  return (
    <ReportFrame title={variations ? 'Variations' : 'Products'} state={state} totals={t} prevTotals={data.prev && data.prev.totals}
      revenue={revenue.cur && revenue} chartMap={{ items_sold: 'num_items_sold' }}
      loading={(!data.cur || !revenue.cur) && !data.error} error={data.error || revenue.error}
      metrics={[{ key: 'items_sold', label: 'Items sold', format: 'number' }, { key: 'net_revenue', label: 'Net sales' }, { key: 'orders_count', label: 'Orders', format: 'number' }]}>
      <ReportTable title={variations ? 'Variations' : 'Products'} csvName={variations ? 'variations' : 'products'} rows={data.cur ? data.cur.rows.map((r) => ({ ...r, id: r.variation_id || r.product_id })) : []}
        defaultSort={{ key: 'items_sold', order: 'desc' }}
        columns={[
          { key: 'name', label: variations ? 'Product / Variation title' : 'Product title', render: (r) => <Link to={`/products/${r.product_id}`}>{r.name}</Link>, csv: (r) => r.name },
          { key: 'sku', label: 'SKU', render: (r) => r.sku || '—' },
          { key: 'items_sold', label: 'Items sold', numeric: true, format: 'number' },
          { key: 'net_revenue', label: 'Net sales', numeric: true, format: 'money' },
          { key: 'orders_count', label: 'Orders', numeric: true, format: 'number' },
          ...(variations ? [] : [{ key: 'categories', label: 'Category', sortable: false, render: (r) => r.categories.join(', ') || '—', csv: (r) => r.categories.join('; ') }]),
          { key: 'stock_status', label: 'Status', render: stockText, csv: stockText },
          { key: 'stock_quantity', label: 'Stock', numeric: true, value: (r) => (r.stock_quantity === null ? -1 : r.stock_quantity), render: (r) => (r.stock_quantity === null ? 'N/A' : r.stock_quantity) },
        ]}
        summary={t && [[fmt.number(t.products_count), variations ? 'variations' : 'products'], [fmt.number(t.items_sold), 'items sold'], [fmt.money(t.net_revenue), 'net sales'], [fmt.number(t.orders_count), 'orders']]}
      />
    </ReportFrame>
  );
}

export function CategoriesReport() {
  const state = useReportState('items_sold');
  const data = usePair('categories', state.ranges);
  const revenue = usePair('revenue', state.ranges, { interval: state.interval });
  const t = data.cur && data.cur.totals;
  return (
    <ReportFrame title="Categories" state={state} totals={t} prevTotals={data.prev && data.prev.totals} revenue={revenue.cur && revenue} chartMap={{ items_sold: 'num_items_sold' }}
      loading={(!data.cur || !revenue.cur) && !data.error} error={data.error || revenue.error}
      metrics={[{ key: 'items_sold', label: 'Items sold', format: 'number' }, { key: 'net_revenue', label: 'Net sales' }]}>
      <ReportTable title="Categories" csvName="categories" rows={data.cur ? data.cur.rows.map((r) => ({ ...r, id: r.category_id })) : []} defaultSort={{ key: 'items_sold', order: 'desc' }}
        columns={[
          { key: 'name', label: 'Category', render: (r) => <Link to={`/products?category=${r.category_id}`}>{r.name}</Link>, csv: (r) => r.name },
          { key: 'items_sold', label: 'Items sold', numeric: true, format: 'number' },
          { key: 'net_revenue', label: 'Net sales', numeric: true, format: 'money' },
          { key: 'products_count', label: 'Products', numeric: true, format: 'number' },
          { key: 'orders_count', label: 'Orders', numeric: true, format: 'number' },
        ]}
        summary={t && [[fmt.number(t.categories_count), 'categories'], [fmt.number(t.items_sold), 'items sold'], [fmt.money(t.net_revenue), 'net sales']]}
      />
    </ReportFrame>
  );
}

export function CouponsReport() {
  const state = useReportState('orders_count');
  const data = usePair('coupons', state.ranges);
  const revenue = usePair('revenue', state.ranges, { interval: state.interval });
  const t = data.cur && data.cur.totals;
  return (
    <ReportFrame title="Coupons" state={state} totals={t} prevTotals={data.prev && data.prev.totals} revenue={revenue.cur && revenue} chartMap={{ orders_count: 'discounted_orders', amount: 'coupons' }}
      loading={(!data.cur || !revenue.cur) && !data.error} error={data.error || revenue.error}
      metrics={[{ key: 'orders_count', label: 'Discounted orders', format: 'number' }, { key: 'amount', label: 'Amount' }]}>
      <ReportTable title="Coupons" csvName="coupons" rows={data.cur ? data.cur.rows.map((r) => ({ ...r, id: r.code })) : []} defaultSort={{ key: 'orders_count', order: 'desc' }}
        columns={[
          { key: 'code', label: 'Coupon code', render: (r) => (r.coupon_id ? <Link to={`/coupons/${r.coupon_id}`}><code>{r.code}</code></Link> : <code>{r.code}</code>), csv: (r) => r.code },
          { key: 'orders_count', label: 'Orders', numeric: true, format: 'number' },
          { key: 'amount', label: 'Amount discounted', numeric: true, format: 'money' },
          { key: 'created', label: 'Created', render: (r) => (r.created ? date(r.created) : '—') },
          { key: 'expires', label: 'Expires', render: (r) => (r.expires ? date(r.expires) : 'N/A') },
          { key: 'type', label: 'Type', render: (r) => ({ percent: 'Percentage', fixed_cart: 'Fixed cart', fixed_product: 'Fixed product' }[r.type] || r.type || '—') },
        ]}
        summary={t && [[fmt.number(t.coupons_count), 'coupons'], [fmt.number(t.orders_count), 'orders'], [fmt.money(t.amount), 'amount discounted']]}
      />
    </ReportFrame>
  );
}

export function TaxesReport() {
  const state = useReportState('total_tax');
  const data = usePair('taxes', state.ranges);
  const revenue = usePair('revenue', state.ranges, { interval: state.interval });
  const t = data.cur && data.cur.totals;
  return (
    <ReportFrame title="Taxes" state={state} totals={t} prevTotals={data.prev && data.prev.totals} revenue={revenue.cur && revenue} chartMap={{ total_tax: 'taxes', order_tax: 'taxes', shipping_tax: 'taxes', orders_count: 'orders_count' }}
      loading={(!data.cur || !revenue.cur) && !data.error} error={data.error || revenue.error}
      metrics={[{ key: 'total_tax', label: 'Total tax' }, { key: 'order_tax', label: 'Order tax' }, { key: 'shipping_tax', label: 'Shipping tax' }, { key: 'orders_count', label: 'Orders', format: 'number' }]}>
      <ReportTable title="Taxes" csvName="taxes" rows={data.cur ? data.cur.rows.map((r) => ({ ...r, id: `${r.tax_code}-${r.tax_rate_id}` })) : []} defaultSort={{ key: 'total_tax', order: 'desc' }}
        columns={[
          { key: 'tax_code', label: 'Tax code' },
          { key: 'rate', label: 'Rate', numeric: true, render: (r) => `${Number(r.rate).toFixed(2)}%` },
          { key: 'total_tax', label: 'Total tax', numeric: true, format: 'money' },
          { key: 'order_tax', label: 'Order tax', numeric: true, format: 'money' },
          { key: 'shipping_tax', label: 'Shipping tax', numeric: true, format: 'money' },
          { key: 'orders_count', label: 'Orders', numeric: true, format: 'number' },
        ]}
        summary={t && [[fmt.number(data.cur.rows.length), 'tax codes'], [fmt.money(t.total_tax), 'total tax'], [fmt.money(t.order_tax), 'order tax'], [fmt.money(t.shipping_tax), 'shipping tax'], [fmt.number(t.orders_count), 'orders']]}
      />
    </ReportFrame>
  );
}

// Overview: performance cards, two charts, leaderboards
export function Overview() {
  const state = useReportState('total_sales');
  const revenue = usePair('revenue', state.ranges, { interval: state.interval });
  const [boards, setBoards] = useState(null);
  useEffect(() => {
    setBoards(null);
    api.get(A('leaderboards'), { ...state.ranges.current, per_page: 5 }).then(setBoards).catch(() => setBoards({ products: [], categories: [], coupons: [] }));
  }, [state.ranges.current.after, state.ranges.current.before]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = revenue.cur && revenue.cur.totals;
  const p = revenue.prev && revenue.prev.totals;
  const { ranges, interval } = state;
  const chart = (key, label, format) => (
    <Postbox title={label}>
      <ReportChart labels={revenue.cur.intervals.map((iv) => intervalLabel(iv, interval))} current={revenue.cur.intervals.map((iv) => iv.subtotals[key])}
        previous={revenue.cur.intervals.map((_, i) => (revenue.prev.intervals[i] ? revenue.prev.intervals[i].subtotals[key] : 0))} format={format}
        currentLabel={ranges.label.replace(/ \(.*/, '')} previousLabel={ranges.compareLabel.replace(/^vs\. /, '').replace(/ \(.*/, '')} />
    </Postbox>
  );
  const board = (title, rows, cols) => (
    <Postbox title={title}>
      <table className="wp-list-table" style={{ border: 0 }}>
        <thead><tr>{cols.map(([k, l, num]) => <th key={k} className={num ? 'right' : ''}>{l}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([k, , num, f]) => <td key={k} className={num ? 'right' : ''}>{f ? f(r) : r[k]}</td>)}</tr>)}
          {!rows.length && <tr className="empty"><td colSpan={cols.length}>No data recorded for the selected time period.</td></tr>}</tbody>
      </table>
    </Postbox>
  );
  return (
    <>
      <PageHeader title="Overview" />
      <DateRangeFilter value={state.q} ranges={ranges} onChange={(v) => state.setQ({ period: v.period, compare: v.compare, after: v.period === 'custom' ? v.after : '', before: v.period === 'custom' ? v.before : '', interval: '' })} />
      {!t ? <Loading /> : (
        <>
          <h2>Performance</h2>
          <SummaryNumbers totals={t} previous={p} metrics={[
            { key: 'total_sales', label: 'Total sales' }, { key: 'net_revenue', label: 'Net sales' }, { key: 'orders_count', label: 'Orders', format: 'number' },
            { key: 'avg_order_value', label: 'Average order value' }, { key: 'num_items_sold', label: 'Products sold', format: 'number' }, { key: 'refunds', label: 'Returns', lowerIsBetter: true },
            { key: 'discounted_orders', label: 'Discounted orders', format: 'number' }, { key: 'coupons', label: 'Net discount amount', lowerIsBetter: true },
          ]} />
          <h2 className="flex" style={{ justifyContent: 'space-between' }}>Charts
            <select value={interval} onChange={(e) => state.setQ({ interval: e.target.value })} aria-label="Interval">{intervalsFor(ranges.days).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></h2>
          <div className="grid-2">{chart('net_revenue', 'Net sales', 'money')}{chart('orders_count', 'Orders', 'number')}{chart('total_sales', 'Total sales', 'money')}{chart('num_items_sold', 'Items sold', 'number')}</div>
          <h2>Leaderboards</h2>
          {!boards ? <Loading /> : (
            <div className="grid-2">
              {board('Top products – items sold', boards.products, [['name', 'Product', false, (r) => <Link to={`/products/${r.product_id}`}>{r.name}</Link>], ['items_sold', 'Items sold', true], ['net_revenue', 'Net sales', true, (r) => fmt.money(r.net_revenue)]])}
              {board('Top categories – items sold', boards.categories, [['name', 'Category', false, (r) => <Link to={`/products?category=${r.category_id}`}>{r.name}</Link>], ['items_sold', 'Items sold', true], ['net_revenue', 'Net sales', true, (r) => fmt.money(r.net_revenue)]])}
              {board('Top coupons – number of orders', boards.coupons, [['code', 'Coupon code', false, (r) => <code>{r.code}</code>], ['orders_count', 'Orders', true], ['amount', 'Amount discounted', true, (r) => fmt.money(r.amount)]])}
              <Postbox title="More reports">
                <ul>{[['revenue', 'Revenue'], ['orders', 'Orders'], ['products', 'Products'], ['categories', 'Categories'], ['coupons', 'Coupons'], ['stock', 'Stock']].map(([k, l]) => <li key={k}><Link to={`/analytics/${k}${window.location.search}`}>{l} report</Link></li>)}</ul>
              </Postbox>
            </div>
          )}
        </>
      )}
    </>
  );
}
