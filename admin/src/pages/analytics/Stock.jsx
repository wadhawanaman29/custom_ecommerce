import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, custom } from '../../api';
import { useQueryState } from '../../hooks';
import { Loading, PageHeader } from '../../components/ui';
import { ReportTable, SummaryNumbers, fmt } from '../../components/analytics';

const TYPES = [['all', 'All products'], ['outofstock', 'Out of stock'], ['lowstock', 'Low stock'], ['instock', 'In stock'], ['onbackorder', 'On backorder']];
const LABEL = { instock: 'In stock', outofstock: 'Out of stock', onbackorder: 'On backorder' };

export default function Stock() {
  const [q, setQ] = useQueryState({ type: 'all', page: '1' });
  const [sort, setSort] = useState({ key: 'stock_quantity', order: 'asc' });
  const [data, setData] = useState(null);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    api.list(custom('admin/analytics/stock'), { type: q.type, page: q.page, per_page: 25, orderby: sort.key, order: sort.order })
      .then((r) => { setData(r.data); setTotal(r.total); }).catch(() => setData({ totals: {}, rows: [] }));
  }, [q.type, q.page, sort]);
  if (!data) return <><PageHeader title="Stock" /><Loading /></>;
  return (
    <>
      <PageHeader title="Stock" />
      <div className="flex mb">
        <label htmlFor="stock-filter">Show:</label>
        <select id="stock-filter" value={q.type} onChange={(e) => setQ({ type: e.target.value })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      <SummaryNumbers totals={data.totals} selected={q.type === 'all' ? null : q.type} onSelect={(k) => setQ({ type: k })} metrics={[
        { key: 'products', label: 'Products', format: 'number' }, { key: 'lowstock', label: 'Low stock', format: 'number', lowerIsBetter: true },
        { key: 'outofstock', label: 'Out of stock', format: 'number', lowerIsBetter: true }, { key: 'onbackorder', label: 'On backorder', format: 'number' }, { key: 'instock', label: 'In stock', format: 'number' },
      ]} />
      <ReportTable title="Stock" csvName={`stock_${q.type}`} rows={data.rows}
        serverPage={{ total, page: Number(q.page), perPage: 25, onPage: (p) => setQ({ page: String(p) }), onSort: (s) => setSort(s) }}
        defaultSort={sort}
        columns={[
          { key: 'name', label: 'Product / Variation', render: (r) => <Link to={`/products/${r.parent_id || r.id}`}>{r.name}</Link>, csv: (r) => r.name },
          { key: 'sku', label: 'SKU', render: (r) => r.sku || '—' },
          { key: 'stock_status', label: 'Status', render: (r) => <span className={r.stock_status === 'outofstock' ? 'stock-out' : r.stock_status === 'onbackorder' ? 'stock-back' : 'stock-in'}>{LABEL[r.stock_status] || r.stock_status}</span>, csv: (r) => LABEL[r.stock_status] || r.stock_status },
          { key: 'stock_quantity', label: 'Stock', numeric: true, render: (r) => (r.manage_stock ? fmt.number(r.stock_quantity) : 'N/A'), csv: (r) => (r.manage_stock ? r.stock_quantity : '') },
        ]}
      />
    </>
  );
}
