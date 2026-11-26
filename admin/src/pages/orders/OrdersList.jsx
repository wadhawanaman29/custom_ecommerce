import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, wc } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { STATUS_LABELS, date, price } from '../../format';
import {
  ListTable, Notice, PageHeader, Pagination, SearchBox, StatusLinks, confirmDelete,
} from '../../components/ui';

const TABS = ['any', 'pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed', 'trash'];

export default function OrdersList() {
  const [q, setQ] = useQueryState({ page: '1', status: 'any', search: '', customer: '' });
  const [notice, showNotice, closeNotice] = useNotice();
  const [counts, setCounts] = useState({});
  const { items, total, totalPages, loading, error, reload } = useCollection(wc('orders'), { page: q.page, per_page: 20, status: q.status, search: q.search, customer: q.customer });
  const loadCounts = () => api.get(wc('reports/orders/totals')).then((r) => {
    const c = Object.fromEntries(r.map((x) => [x.slug, x.total]));
    c.any = r.filter((x) => !['trash', 'checkout-draft'].includes(x.slug)).reduce((n, x) => n + x.total, 0);
    setCounts(c);
  }).catch(() => {});
  useEffect(() => { loadCounts(); }, []);
  const run = async (fn, msg) => { try { await fn(); showNotice('success', msg); reload(); loadCounts(); } catch (e) { showNotice('error', e.message); } };

  const onBulk = (action, ids) => {
    if (action === 'delete') return confirmDelete(`${ids.length} order(s)`) && run(() => api.post(wc('orders/batch'), { delete: ids }), 'Orders deleted.');
    if (action === 'trash') return run(() => Promise.all(ids.map((oid) => api.del(wc(`orders/${oid}`)))), `${ids.length} order(s) moved to the Trash.`);
    return run(() => api.post(wc('orders/batch'), { update: ids.map((id) => ({ id, status: action })) }), `${ids.length} order status(es) changed.`);
  };

  return (
    <>
      <PageHeader title="Orders" action="Add order" actionTo="/orders/new" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <StatusLinks value={q.status} onChange={(status) => setQ({ status })}
          items={TABS.filter((s) => s === 'any' || counts[s]).map((s) => ({ value: s, label: s === 'any' ? 'All' : STATUS_LABELS[s], count: counts[s] }))} />
        <SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder="Search orders" />
      </div>
      <div className="tablenav">
        <div className="actions">{q.customer && <span>Filtered by customer #{q.customer} <a href="#" onClick={(e) => { e.preventDefault(); setQ({ customer: '' }); }}>clear</a></span>}</div>
        <Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} />
      </div>
      <ListTable items={items} loading={loading} error={error} onBulk={onBulk}
        bulkActions={[
          { value: 'processing', label: 'Change status to processing' }, { value: 'on-hold', label: 'Change status to on-hold' },
          { value: 'completed', label: 'Change status to completed' }, { value: 'cancelled', label: 'Change status to cancelled' },
          { value: 'trash', label: 'Move to Trash' }, { value: 'delete', label: 'Delete permanently' },
        ]}
        columns={[
          { key: 'order', label: 'Order', render: (o) => <Link className="row-title" to={`/orders/${o.id}`}>#{o.number} {[o.billing.first_name, o.billing.last_name].filter(Boolean).join(' ') || o.billing.email || 'Guest'}</Link> },
          { key: 'date', label: 'Date', render: (o) => date(o.date_created) },
          { key: 'status', label: 'Status', render: (o) => <span className={`status status-${o.status}`}>{STATUS_LABELS[o.status] || o.status}</span> },
          { key: 'items', label: 'Items', render: (o) => o.line_items.reduce((n, l) => n + l.quantity, 0) },
          { key: 'billing', label: 'Billing', render: (o) => <>{[o.billing.address_1, o.billing.city, o.billing.state, o.billing.country].filter(Boolean).join(', ')}<br /><span className="muted">via {o.payment_method_title || o.payment_method || '—'}</span></> },
          { key: 'total', label: 'Total', className: 'right', render: (o) => <>{price(o.total)}{o.refunds.length > 0 && <><br /><small className="muted">refunded {price(Math.abs(o.refunds.reduce((n, r) => n + Number(r.total), 0)))}</small></>}</> },
        ]} />
      <div className="tablenav"><span /><Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} /></div>
    </>
  );
}
