import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fetchAll, wp } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { POST_STATUS, date, decodeHtml } from '../../format';
import {
  ListTable, Notice, PageHeader, Pagination, SearchBox, StatusLinks, confirmDelete,
} from '../../components/ui';

const STATUSES = ['any', 'publish', 'draft', 'pending', 'private', 'future', 'trash'];

export default function PostsList({ type }) {
  const isPage = type === 'page';
  const base = isPage ? 'pages' : 'posts';
  const [q, setQ] = useQueryState({ page: '1', status: 'any', search: '', categories: '' });
  const [notice, showNotice, closeNotice] = useNotice();
  const [counts, setCounts] = useState({});
  const [cats, setCats] = useState([]);
  const [authors, setAuthors] = useState({});
  const params = { page: q.page, per_page: 20, status: q.status === 'any' ? 'publish,future,draft,pending,private' : q.status, search: q.search, categories: q.categories, context: 'edit', ...(isPage ? { orderby: 'menu_order', order: 'asc' } : {}) };
  const { items, total, totalPages, loading, error, reload } = useCollection(wp(base), params);
  const loadCounts = () => Promise.all(STATUSES.map((s) => api.list(wp(base), { status: s === 'any' ? 'publish,future,draft,pending,private' : s, per_page: 1, _fields: 'id' }).then((r) => [s, r.total]).catch(() => [s, 0])))
    .then((l) => setCounts(Object.fromEntries(l)));
  useEffect(() => {
    loadCounts();
    if (!isPage) fetchAll(wp('categories')).then(setCats).catch(() => {});
    fetchAll(wp('users'), { context: 'edit', roles: 'administrator,editor,author,shop_manager,contributor' }).then((us) => setAuthors(Object.fromEntries(us.map((u) => [u.id, u.name])))).catch(() => {});
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn, msg) => { try { await fn(); showNotice('success', msg); reload(); loadCounts(); } catch (e) { showNotice('error', e.message); } };
  const onBulk = (action, ids) => run(async () => {
    for (const id of ids) {
      if (action === 'delete') await api.del(wp(`${base}/${id}`), { force: true });
      else if (action === 'trash') await api.del(wp(`${base}/${id}`));
      else await api.put(wp(`${base}/${id}`), { status: action });
    }
  }, `${ids.length} item(s) updated.`);
  const catName = (id) => decodeHtml((cats.find((c) => c.id === id) || {}).name || '');

  return (
    <>
      <PageHeader title={isPage ? 'Pages' : 'Posts'} action="Add New" actionTo={`/${base}/new`} />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <StatusLinks value={q.status} onChange={(status) => setQ({ status })} items={STATUSES.filter((s) => s === 'any' || counts[s]).map((s) => ({ value: s, label: s === 'any' ? 'All' : POST_STATUS[s], count: counts[s] }))} />
        <SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder={`Search ${base}`} />
      </div>
      <div className="tablenav">
        <div className="actions">{!isPage && (
          <select value={q.categories} onChange={(e) => setQ({ categories: e.target.value })} aria-label="Filter by category">
            <option value="">All Categories</option>{cats.map((c) => <option key={c.id} value={c.id}>{decodeHtml(c.name)}</option>)}
          </select>
        )}</div>
        <Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} />
      </div>
      <ListTable items={items} loading={loading} error={error} onBulk={(a, ids) => (a !== 'delete' || confirmDelete(`${ids.length} item(s)`)) && onBulk(a, ids)}
        bulkActions={q.status === 'trash' ? [{ value: 'draft', label: 'Restore' }, { value: 'delete', label: 'Delete permanently' }] : [{ value: 'publish', label: 'Publish' }, { value: 'draft', label: 'Set to draft' }, { value: 'trash', label: 'Move to Trash' }]}
        columns={[
          { key: 'title', label: 'Title', render: (p) => (
            <>
              <Link className="row-title" to={`/${base}/${p.id}`}>{isPage && p.parent ? '— ' : ''}{decodeHtml(p.title.rendered) || '(no title)'}</Link>
              {p.status !== 'publish' && <strong className="muted"> — {POST_STATUS[p.status] || p.status}</strong>}
              <div className="row-actions">
                <span className="muted">ID: {p.id}</span>
                {p.status !== 'trash' && <span><Link to={`/${base}/${p.id}`}>Edit</Link></span>}
                {p.status !== 'trash' && <span><button type="button" className="button-link-delete" onClick={() => run(() => api.del(wp(`${base}/${p.id}`)), 'Moved to the Trash.')}>Trash</button></span>}
                {p.status === 'trash' && <span><a href="#" onClick={(e) => { e.preventDefault(); run(() => api.put(wp(`${base}/${p.id}`), { status: 'draft' }), 'Restored.'); }}>Restore</a></span>}
                {p.status === 'trash' && <span><button type="button" className="button-link-delete" onClick={() => confirmDelete(`"${decodeHtml(p.title.rendered)}"`) && run(() => api.del(wp(`${base}/${p.id}`), { force: true }), 'Deleted permanently.')}>Delete Permanently</button></span>}
                {p.status === 'publish' && <span><a href={p.link} target="_blank" rel="noreferrer">View</a></span>}
              </div>
            </>
          ) },
          { key: 'author', label: 'Author', render: (p) => authors[p.author] || `#${p.author}` },
          ...(isPage ? [{ key: 'slug', label: 'Slug', render: (p) => <code>/{p.slug}</code> }] : [
            { key: 'categories', label: 'Categories', render: (p) => p.categories.map(catName).filter(Boolean).join(', ') || '—' },
          ]),
          { key: 'date', label: 'Date', render: (p) => <>{p.status === 'publish' ? 'Published' : 'Last Modified'}<br />{date(p.status === 'publish' ? p.date : p.modified, true)}</> },
        ]} />
    </>
  );
}
