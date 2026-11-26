import { api, wp } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { date } from '../../format';
import {
  ListTable, Notice, PageHeader, Pagination, StatusLinks, confirmDelete,
} from '../../components/ui';

export default function Comments() {
  const [q, setQ] = useQueryState({ page: '1', status: 'all' });
  const [notice, showNotice, closeNotice] = useNotice();
  const { items, total, totalPages, loading, error, reload } = useCollection(wp('comments'), { page: q.page, per_page: 20, status: q.status });
  const run = async (fn, msg) => { try { await fn(); showNotice('success', msg); reload(); } catch (e) { showNotice('error', e.message); } };
  const setStatus = (ids, status) => run(() => Promise.all(ids.map((id) => api.put(wp(`comments/${id}`), { status }))), 'Comments updated.');
  return (
    <>
      <PageHeader title="Comments" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <StatusLinks value={q.status} onChange={(status) => setQ({ status })} items={[{ value: 'all', label: 'All' }, { value: 'hold', label: 'Pending' }, { value: 'approve', label: 'Approved' }, { value: 'spam', label: 'Spam' }, { value: 'trash', label: 'Trash' }]} />
        <Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} />
      </div>
      <ListTable items={items} loading={loading} error={error}
        bulkActions={[{ value: 'approved', label: 'Approve' }, { value: 'hold', label: 'Unapprove' }, { value: 'spam', label: 'Mark as spam' }, { value: 'trash', label: 'Move to Trash' }, { value: 'delete', label: 'Delete permanently' }]}
        onBulk={(a, ids) => (a === 'delete' ? confirmDelete(`${ids.length} comment(s)`) && run(() => Promise.all(ids.map((id) => api.del(wp(`comments/${id}`), { force: true }))), 'Deleted.') : setStatus(ids, a))}
        columns={[
          { key: 'author', label: 'Author', render: (c) => <><strong>{c.author_name}</strong>{c.author_url && <><br /><a href={c.author_url} target="_blank" rel="noreferrer">{c.author_url}</a></>}</> },
          { key: 'content', label: 'Comment', render: (c) => (
            <>
              {c.status === 'hold' && <strong className="muted">[Pending] </strong>}
              <span dangerouslySetInnerHTML={{ __html: c.content.rendered }} />
              <div className="row-actions">
                {c.status !== 'approved' && <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus([c.id], 'approved'); }}>Approve</a></span>}
                {c.status === 'approved' && <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus([c.id], 'hold'); }}>Unapprove</a></span>}
                <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus([c.id], 'spam'); }}>Spam</a></span>
                <span><button type="button" className="button-link-delete" onClick={() => setStatus([c.id], 'trash')}>Trash</button></span>
              </div>
            </>
          ) },
          { key: 'post', label: 'In response to', render: (c) => <a href={c.link} target="_blank" rel="noreferrer">Post #{c.post}</a> },
          { key: 'date', label: 'Submitted on', render: (c) => date(c.date, true) },
        ]} />
    </>
  );
}
