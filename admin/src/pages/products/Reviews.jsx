import { Link } from 'react-router-dom';
import { api, wc } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { date, decodeHtml } from '../../format';
import {
  ListTable, Notice, PageHeader, Pagination, SearchBox, StatusLinks, confirmDelete,
} from '../../components/ui';

export default function Reviews() {
  const [q, setQ] = useQueryState({ page: '1', status: 'all', search: '' });
  const [notice, showNotice, closeNotice] = useNotice();
  const { items, total, totalPages, loading, error, reload } = useCollection(wc('products/reviews'), { page: q.page, per_page: 20, status: q.status, search: q.search });
  const run = async (fn, msg) => { try { await fn(); showNotice('success', msg); reload(); } catch (e) { showNotice('error', e.message); } };
  const setStatus = (ids, status) => run(() => api.post(wc('products/reviews/batch'), { update: ids.map((id) => ({ id, status })) }), 'Reviews updated.');
  return (
    <>
      <PageHeader title="Reviews" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <StatusLinks value={q.status} onChange={(status) => setQ({ status })} items={[{ value: 'all', label: 'All' }, { value: 'hold', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'spam', label: 'Spam' }, { value: 'trash', label: 'Trash' }]} />
        <SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder="Search reviews" />
      </div>
      <div className="tablenav"><span /><Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} /></div>
      <ListTable items={items} loading={loading} error={error}
        bulkActions={[{ value: 'approved', label: 'Approve' }, { value: 'hold', label: 'Unapprove' }, { value: 'spam', label: 'Mark as spam' }, { value: 'trash', label: 'Move to Trash' }, { value: 'delete', label: 'Delete permanently' }]}
        onBulk={(a, ids) => (a === 'delete' ? confirmDelete(`${ids.length} review(s)`) && run(() => api.post(wc('products/reviews/batch'), { delete: ids }), 'Reviews deleted.') : setStatus(ids, a))}
        columns={[
          { key: 'type', label: 'Type', render: () => 'Review' },
          { key: 'author', label: 'Author', render: (r) => <><strong>{r.reviewer}</strong><br /><a href={`mailto:${r.reviewer_email}`}>{r.reviewer_email}</a>{r.verified && <><br /><em className="muted">verified owner</em></>}</> },
          { key: 'rating', label: 'Rating', render: (r) => <span title={`${r.rating} out of 5`} style={{ color: '#dba617' }}>{'★'.repeat(r.rating)}<span style={{ color: '#c3c4c7' }}>{'★'.repeat(5 - r.rating)}</span></span> },
          { key: 'review', label: 'Review', render: (r) => (
            <>
              {r.status === 'hold' && <strong className="muted">[Pending] </strong>}
              <span dangerouslySetInnerHTML={{ __html: r.review }} />
              <div className="row-actions">
                {r.status !== 'approved' && <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus([r.id], 'approved'); }}>Approve</a></span>}
                {r.status === 'approved' && <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus([r.id], 'hold'); }}>Unapprove</a></span>}
                <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus([r.id], 'spam'); }}>Spam</a></span>
                <span><button type="button" className="button-link-delete" onClick={() => run(() => api.del(wc(`products/reviews/${r.id}`)), 'Review trashed.')}>Trash</button></span>
              </div>
            </>
          ) },
          { key: 'product', label: 'Product', render: (r) => <Link to={`/products/${r.product_id}`}>{decodeHtml(r.product_name)}</Link> },
          { key: 'date', label: 'Submitted on', render: (r) => date(r.date_created, true) },
        ]} />
    </>
  );
}
