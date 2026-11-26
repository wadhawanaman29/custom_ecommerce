import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fetchAll, wp } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { POST_STATUS, decodeHtml } from '../../format';
import { typeInfo, useContentTypes } from '../../contentTypes';
import {
  ListTable, Loading, Notice, PageHeader, Pagination, SearchBox, StatusLinks, confirmDelete,
} from '../../components/ui';

const STATUSES = ['any', 'publish', 'draft', 'pending', 'private', 'trash'];
const wpDateTime = (s) => {
  if (!s) return '';
  const d = new Date(s);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()}`;
};

// List screen for any registered custom post type (e.g. Frontend Menus)
export default function ContentList() {
  const { type } = useParams();
  const { registry } = useContentTypes();
  const info = typeInfo(registry, type);
  if (!registry) return <Loading />;
  if (!info) return <div className="notice notice-error"><span>Unknown content type “{type}”. Check Tools → Content Types.</span></div>;
  return <List key={type} info={info} />;
}

function List({ info }) {
  const base = info.rest_base;
  const route = `/content/${info.name}`;
  const [q, setQ] = useQueryState({ page: '1', status: 'any', search: '', orderby: 'date', order: 'desc', term: '' });
  const [notice, showNotice, closeNotice] = useNotice();
  const [counts, setCounts] = useState({});
  const [terms, setTerms] = useState({});
  const tax = info.taxonomies[0];
  const params = {
    page: q.page, per_page: 20, status: q.status === 'any' ? 'publish,future,draft,pending,private' : q.status, search: q.search,
    orderby: q.orderby, order: q.order, context: 'edit', ...(q.term && tax ? { [tax.rest_base || tax.name]: q.term } : {}),
  };
  const { items, total, totalPages, loading, error, reload } = useCollection(wp(base), params);
  const loadCounts = () => Promise.all(STATUSES.map((s) => api.list(wp(base), { status: s === 'any' ? 'publish,future,draft,pending,private' : s, per_page: 1, _fields: 'id' }).then((r) => [s, r.total]).catch(() => [s, 0])))
    .then((l) => setCounts(Object.fromEntries(l)));
  useEffect(() => {
    loadCounts();
    Promise.all(info.taxonomies.map(async (t) => [t.name, await fetchAll(wp(t.rest_base || t.name)).catch(() => [])])).then((l) => setTerms(Object.fromEntries(l)));
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn, msg) => { try { await fn(); showNotice('success', msg); reload(); loadCounts(); } catch (e) { showNotice('error', e.message); } };
  const onBulk = (action, ids) => run(async () => {
    for (const id of ids) {
      if (action === 'delete') await api.del(wp(`${base}/${id}`), { force: true });
      else if (action === 'trash') await api.del(wp(`${base}/${id}`));
      else await api.put(wp(`${base}/${id}`), { status: action });
    }
  }, `${ids.length} item(s) updated.`);
  const termName = (taxName, id) => decodeHtml(((terms[taxName] || []).find((t) => t.id === id) || {}).name || `#${id}`);
  const sortByOrder = q.orderby === 'menu_order';

  return (
    <>
      <PageHeader title={info.label} action={`Add new ${info.singular_label}`} actionTo={`${route}/new`} />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <ul className="subsubsub">
          {STATUSES.filter((s) => s === 'any' || counts[s]).map((s) => (
            <li key={s}><a href="#" className={q.status === s && !sortByOrder ? 'current' : ''} onClick={(e) => { e.preventDefault(); setQ({ status: s, orderby: 'date', order: 'desc' }); }}>
              {s === 'any' ? 'All' : s === 'draft' ? 'Drafts' : s === 'publish' ? 'Published' : POST_STATUS[s]}<span className="muted"> ({counts[s] ?? '…'})</span></a></li>
          ))}
          <li><a href="#" className={sortByOrder ? 'current' : ''} onClick={(e) => { e.preventDefault(); setQ({ orderby: 'menu_order', order: 'asc' }); }}>Sort by Order</a></li>
        </ul>
        <SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder={`Search ${info.label}`} />
      </div>
      <div className="tablenav">
        <div className="actions">
          {tax && (
            <select value={q.term} onChange={(e) => setQ({ term: e.target.value })} aria-label={`Filter by ${tax.singular_label}`}>
              <option value="">All {tax.label}</option>
              {(terms[tax.name] || []).map((t) => <option key={t.id} value={t.id}>{decodeHtml(t.name)} ({t.count})</option>)}
            </select>
          )}
        </div>
        <Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} />
      </div>
      <ListTable items={items} loading={loading} error={error}
        sort={{ orderby: q.orderby, order: q.order }} onSort={(k) => setQ({ orderby: k, order: q.orderby === k && q.order === 'asc' ? 'desc' : 'asc' })}
        onBulk={(a, ids) => (a !== 'delete' || confirmDelete(`${ids.length} item(s)`)) && onBulk(a, ids)}
        bulkActions={q.status === 'trash' ? [{ value: 'draft', label: 'Restore' }, { value: 'delete', label: 'Delete permanently' }] : [{ value: 'publish', label: 'Publish' }, { value: 'draft', label: 'Set to draft' }, { value: 'trash', label: 'Move to Trash' }]}
        columns={[
          { key: 'title', label: 'Title', sortable: true, render: (p) => (
            <>
              <Link className="row-title" to={`${route}/${p.id}`}>{decodeHtml(p.title.rendered) || '(no title)'}</Link>
              {p.status !== 'publish' && <strong> — {POST_STATUS[p.status] || p.status}</strong>}
              <div className="row-actions">
                <span className="muted">ID: {p.id}</span>
                {p.status !== 'trash' && <span><Link to={`${route}/${p.id}`}>Edit</Link></span>}
                {p.status !== 'trash' && <span><button type="button" className="button-link-delete" onClick={() => run(() => api.del(wp(`${base}/${p.id}`)), 'Moved to the Trash.')}>Trash</button></span>}
                {p.status === 'trash' && <span><a href="#" onClick={(e) => { e.preventDefault(); run(() => api.put(wp(`${base}/${p.id}`), { status: 'draft' }), 'Restored.'); }}>Restore</a></span>}
                {p.status === 'trash' && <span><button type="button" className="button-link-delete" onClick={() => confirmDelete(`"${decodeHtml(p.title.rendered)}"`) && run(() => api.del(wp(`${base}/${p.id}`), { force: true }), 'Deleted permanently.')}>Delete Permanently</button></span>}
              </div>
            </>
          ) },
          ...info.taxonomies.map((t) => ({
            key: `tax-${t.name}`, label: t.label,
            render: (p) => ((p[t.rest_base || t.name] || []).map((id) => <a key={id} href="#" onClick={(e) => { e.preventDefault(); if (t === tax) setQ({ term: String(id) }); }} style={{ marginRight: 6 }}>{termName(t.name, id)}</a>)),
          })),
          { key: 'menu_order', label: 'Order', sortable: true, render: (p) => p.menu_order },
          { key: 'date', label: 'Date', sortable: true, render: (p) => <>{p.status === 'publish' ? 'Published' : 'Last Modified'}<br />{wpDateTime(p.status === 'publish' ? p.date : p.modified)}</> },
        ]} />
      <div className="tablenav"><span /><Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} /></div>
    </>
  );
}
