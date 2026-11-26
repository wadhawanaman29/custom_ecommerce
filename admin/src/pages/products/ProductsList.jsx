import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fetchAll, wc } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { decodeHtml, date, stockLabel } from '../../format';
import {
  ListTable, Notice, PageHeader, Pagination, SearchBox, StatusLinks, confirmDelete,
} from '../../components/ui';

const STATUSES = [['any', 'All'], ['publish', 'Published'], ['draft', 'Drafts'], ['pending', 'Pending'], ['private', 'Private'], ['trash', 'Trash']];

export default function ProductsList() {
  const navigate = useNavigate();
  const [q, setQ] = useQueryState({ page: '1', status: 'any', search: '', category: '', type: '', stock_status: '', orderby: 'date', order: 'desc' });
  const [notice, showNotice, closeNotice] = useNotice();
  const [counts, setCounts] = useState({});
  const [categories, setCategories] = useState([]);
  const params = { page: q.page, per_page: 20, status: q.status, search: q.search, category: q.category, type: q.type, stock_status: q.stock_status, orderby: q.orderby, order: q.order };
  const { items, total, totalPages, loading, error, reload } = useCollection(wc('products'), params);

  const loadCounts = () => Promise.all(STATUSES.map(([s]) => api.list(wc('products'), { status: s, per_page: 1, _fields: 'id' }).then((r) => [s, r.total])))
    .then((list) => setCounts(Object.fromEntries(list))).catch(() => {});
  useEffect(() => { loadCounts(); fetchAll(wc('products/categories')).then(setCategories).catch(() => {}); }, []);

  const act = async (fn, message) => {
    try { await fn(); showNotice('success', message); reload(); loadCounts(); } catch (e) { showNotice('error', e.message); }
  };
  const onBulk = (action, ids) => {
    if (action === 'delete' && !confirmDelete(`${ids.length} product(s)`)) return;
    const body = action === 'delete' || action === 'trash'
      ? { delete: action === 'delete' ? ids : [] , update: action === 'trash' ? ids.map((id) => ({ id, status: 'trash' })) : [] }
      : { update: ids.map((id) => ({ id, status: action === 'restore' ? 'draft' : action })) };
    act(() => api.post(wc('products/batch'), body), `${ids.length} product(s) updated.`);
  };
  const duplicate = (p) => act(async () => {
    const full = await api.get(wc(`products/${p.id}`));
    const copy = { ...full, name: `${full.name} (Copy)`, status: 'draft', sku: '', slug: '', images: full.images.map((i) => ({ id: i.id })) };
    ['id', 'permalink', 'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'variations', 'related_ids', 'price_html', '_links', 'meta_data'].forEach((k) => delete copy[k]);
    const created = await api.post(wc('products'), copy);
    if (full.type === 'variable' && full.variations.length) {
      const vars = await fetchAll(wc(`products/${full.id}/variations`));
      await api.post(wc(`products/${created.id}/variations/batch`), {
        create: vars.map((v) => ({ regular_price: v.regular_price, sale_price: v.sale_price, sku: '', manage_stock: v.manage_stock, stock_quantity: v.stock_quantity, stock_status: v.stock_status, attributes: v.attributes, image: v.image ? { id: v.image.id } : undefined, weight: v.weight, dimensions: v.dimensions, description: v.description })),
      });
    }
    navigate(`/products/${created.id}`);
  }, 'Product duplicated.');

  const sort = { orderby: q.orderby, order: q.order };
  const onSort = (key) => setQ({ orderby: key, order: q.orderby === key && q.order === 'asc' ? 'desc' : 'asc' });

  const columns = [
    { key: 'thumb', label: '', className: 'thumb', width: 52, render: (p) => (p.images[0] ? <img src={p.images[0].src} alt="" loading="lazy" /> : <span className="muted">—</span>) },
    {
      key: 'name', label: 'Name', sortable: true, sortKey: 'title',
      render: (p) => (
        <>
          <Link className="row-title" to={`/products/${p.id}`}>{decodeHtml(p.name) || '(no title)'}</Link>
          {p.status !== 'publish' && <strong className="muted"> — {p.status}</strong>}
          <div className="row-actions">
            <span className="muted">ID: {p.id}</span>
            {p.status !== 'trash' && <span><Link to={`/products/${p.id}`}>Edit</Link></span>}
            {p.status !== 'trash' && <span><a href="#" onClick={(e) => { e.preventDefault(); duplicate(p); }}>Duplicate</a></span>}
            {p.status !== 'trash' && <span><button type="button" className="button-link-delete" onClick={() => act(() => api.del(wc(`products/${p.id}`)), 'Product moved to the Trash.')}>Trash</button></span>}
            {p.status === 'trash' && <span><a href="#" onClick={(e) => { e.preventDefault(); act(() => api.put(wc(`products/${p.id}`), { status: 'draft' }), 'Product restored.'); }}>Restore</a></span>}
            {p.status === 'trash' && <span><button type="button" className="button-link-delete" onClick={() => confirmDelete(`"${p.name}"`) && act(() => api.del(wc(`products/${p.id}`), { force: true }), 'Product deleted permanently.')}>Delete Permanently</button></span>}
            {p.status === 'publish' && <span><a href={p.permalink} target="_blank" rel="noreferrer">View</a></span>}
          </div>
        </>
      ),
    },
    { key: 'sku', label: 'SKU', render: (p) => p.sku || <span className="muted">–</span> },
    { key: 'stock', label: 'Stock', render: (p) => stockLabel(p) },
    { key: 'price', label: 'Price', sortable: true, render: (p) => <span dangerouslySetInnerHTML={{ __html: p.price_html || '–' }} /> },
    { key: 'categories', label: 'Categories', render: (p) => p.categories.map((c) => decodeHtml(c.name)).join(', ') || '–' },
    { key: 'type', label: 'Type', render: (p) => p.type },
    { key: 'featured', label: '★', render: (p) => <button type="button" title="Toggle featured" style={{ border: 0, background: 'none', cursor: 'pointer', fontSize: 16, color: p.featured ? '#dba617' : '#c3c4c7' }} onClick={() => act(() => api.put(wc(`products/${p.id}`), { featured: !p.featured }), 'Featured updated.')}>★</button> },
    { key: 'date', label: 'Date', sortable: true, render: (p) => <>{p.status === 'publish' ? 'Published' : 'Last modified'}<br />{date(p.date_created)}</> },
  ];

  return (
    <>
      <PageHeader title="Products" action="Add New" actionTo="/products/new" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <StatusLinks value={q.status} onChange={(status) => setQ({ status })} items={STATUSES.map(([value, label]) => ({ value, label, count: counts[value] }))} />
        <SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder="Search products" />
      </div>
      <div className="tablenav">
        <div className="actions">
          <select value={q.category} onChange={(e) => setQ({ category: e.target.value })} aria-label="Filter by category">
            <option value="">Select a category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{decodeHtml(c.name)} ({c.count})</option>)}
          </select>
          <select value={q.type} onChange={(e) => setQ({ type: e.target.value })} aria-label="Filter by type">
            <option value="">Filter by product type</option>
            <option value="simple">Simple product</option><option value="variable">Variable product</option>
            <option value="grouped">Grouped product</option><option value="external">External/Affiliate product</option>
          </select>
          <select value={q.stock_status} onChange={(e) => setQ({ stock_status: e.target.value })} aria-label="Filter by stock status">
            <option value="">Filter by stock status</option>
            <option value="instock">In stock</option><option value="outofstock">Out of stock</option><option value="onbackorder">On backorder</option>
          </select>
        </div>
        <Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} />
      </div>
      <ListTable
        columns={columns} items={items} loading={loading} error={error} sort={sort} onSort={onSort}
        bulkActions={q.status === 'trash'
          ? [{ value: 'restore', label: 'Restore' }, { value: 'delete', label: 'Delete permanently' }]
          : [{ value: 'publish', label: 'Publish' }, { value: 'draft', label: 'Set to draft' }, { value: 'trash', label: 'Move to Trash' }]}
        onBulk={onBulk}
      />
      <div className="tablenav"><span /><Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} /></div>
    </>
  );
}
