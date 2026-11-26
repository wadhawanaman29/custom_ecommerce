import { Link } from 'react-router-dom';
import { api, wc } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { date, price } from '../../format';
import {
  ListTable, Notice, PageHeader, Pagination, SearchBox, StatusLinks, confirmDelete,
} from '../../components/ui';

const TYPES = { percent: 'Percentage discount', fixed_cart: 'Fixed cart discount', fixed_product: 'Fixed product discount' };

export default function CouponsList() {
  const [q, setQ] = useQueryState({ page: '1', search: '', status: 'any' });
  const [notice, showNotice, closeNotice] = useNotice();
  const { items, total, totalPages, loading, error, reload } = useCollection(wc('coupons'), { page: q.page, per_page: 20, search: q.search, status: q.status });
  const run = async (fn, msg) => { try { await fn(); showNotice('success', msg); reload(); } catch (e) { showNotice('error', e.message); } };
  return (
    <>
      <PageHeader title="Coupons" action="Add coupon" actionTo="/coupons/new" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <StatusLinks value={q.status} onChange={(status) => setQ({ status })} items={[{ value: 'any', label: 'All' }, { value: 'publish', label: 'Published' }, { value: 'draft', label: 'Drafts' }, { value: 'trash', label: 'Trash' }]} />
        <SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder="Search coupons" />
      </div>
      <div className="tablenav"><span /><Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} /></div>
      <ListTable items={items} loading={loading} error={error}
        bulkActions={[{ value: 'trash', label: 'Move to Trash' }, { value: 'delete', label: 'Delete permanently' }]}
        onBulk={(a, ids) => (a === 'delete'
          ? confirmDelete(`${ids.length} coupon(s)`) && run(() => api.post(wc('coupons/batch'), { delete: ids }), 'Coupons deleted.')
          : run(() => api.post(wc('coupons/batch'), { update: ids.map((id) => ({ id, status: 'trash' })) }), 'Coupons trashed.'))}
        columns={[
          { key: 'code', label: 'Code', render: (c) => <><Link className="row-title" to={`/coupons/${c.id}`}><code>{c.code}</code></Link>{c.status !== 'publish' && <strong className="muted"> — {c.status}</strong>}
            <div className="row-actions"><span><Link to={`/coupons/${c.id}`}>Edit</Link></span>
              {c.status === 'trash' ? <span><a href="#" onClick={(e) => { e.preventDefault(); run(() => api.put(wc(`coupons/${c.id}`), { status: 'publish' }), 'Coupon restored.'); }}>Restore</a></span>
                : <span><button type="button" className="button-link-delete" onClick={() => run(() => api.del(wc(`coupons/${c.id}`)), 'Coupon trashed.')}>Trash</button></span>}</div></> },
          { key: 'type', label: 'Coupon type', render: (c) => TYPES[c.discount_type] || c.discount_type },
          { key: 'amount', label: 'Amount', render: (c) => (c.discount_type === 'percent' ? `${Number(c.amount)}%` : price(c.amount)) },
          { key: 'description', label: 'Description', render: (c) => c.description || '—' },
          { key: 'products', label: 'Product IDs', render: (c) => c.product_ids.join(', ') || '—' },
          { key: 'usage', label: 'Usage / Limit', render: (c) => `${c.usage_count} / ${c.usage_limit || '∞'}` },
          { key: 'expiry', label: 'Expiry date', render: (c) => (c.date_expires ? date(c.date_expires) : '—') },
        ]} />
    </>
  );
}
