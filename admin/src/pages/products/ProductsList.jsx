import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, custom, fetchAll, getToken, wc } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { decodeHtml, date, stockLabel } from '../../format';
import { useContentTypes } from '../../contentTypes';
import {
  ListTable, Modal, Notice, PageHeader, Pagination, SearchBox, StatusLinks, confirmDelete,
} from '../../components/ui';

const STATUS_NAMES = { publish: 'Published', draft: 'Drafts', pending: 'Pending', private: 'Private', future: 'Scheduled', trash: 'Trash' };
const statusName = (s) => STATUS_NAMES[s] || s.charAt(0).toUpperCase() + s.slice(1);
const STATUS_ORDER = ['publish', 'draft', 'pending', 'private', 'future'];

// Optional columns, toggled under "Screen Options" (remembered per browser)
const OPTIONAL = [
  ['sku', 'SKU', true], ['gtin', 'GTIN', true], ['stock', 'Stock', true], ['price', 'Price', true], ['fb_sync', 'Synced to Meta catalog', true],
  ['brands', 'Brands', true], ['out_of_stock', 'Out of Stock Date', true], ['access_level', 'Access Level', true],
  ['categories', 'Categories', false], ['tags', 'Tags', false], ['type', 'Type', false], ['featured', 'Featured', false], ['date', 'Date', true],
];
const COLS_KEY = 'products_list_columns';
const loadCols = () => {
  try { const v = JSON.parse(localStorage.getItem(COLS_KEY)); if (v && typeof v === 'object') return v; } catch { /* ignore */ }
  return Object.fromEntries(OPTIONAL.map(([k, , on]) => [k, on]));
};

const accessLabel = (v, choices) => {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const out = list.filter((x) => x && x !== 'none').map((x) => choices[x] || x);
  return out.length ? out.join(', ') : 'None';
};

export default function ProductsList() {
  const navigate = useNavigate();
  const { registry } = useContentTypes();
  const [q, setQ] = useQueryState({
    page: '1', status: 'any', search: '', category: '', type: '', stock_status: '', brand: '', manufacturer: '', fb_sync: '', access_level: '', orderby: 'date', order: 'desc',
  });
  const [notice, showNotice, closeNotice] = useNotice();
  const [counts, setCounts] = useState({});
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [manufacturer, setManufacturer] = useState(null); // { attr, terms }
  const [cols, setCols] = useState(loadCols);
  const [screenOpts, setScreenOpts] = useState(false);
  const [perPage, setPerPage] = useState(() => { try { return Number(localStorage.getItem('products_per_page')) || 20; } catch { return 20; } });
  const [exporting, setExporting] = useState(false);

  const params = {
    page: q.page, per_page: perPage, status: q.status, search: q.search, category: q.category, type: q.type, stock_status: q.stock_status,
    brand: q.brand, fb_sync: q.fb_sync, access_level: q.access_level, orderby: q.orderby, order: q.order,
    ...(q.manufacturer && manufacturer ? { attribute: manufacturer.attr.slug, attribute_term: q.manufacturer } : {}),
  };
  const { items, total, totalPages, loading, error, reload } = useCollection(wc('products'), params);

  const accessChoices = useMemo(() => {
    for (const g of (registry && registry.field_groups) || []) {
      const f = (g.fields || []).find((x) => x.name === 'product_access_level');
      if (f && f.choices) return f.choices;
    }
    return {};
  }, [registry]);

  const loadCounts = () => api.get(custom('admin/plugins/products/status-counts')).then(setCounts).catch(() => {});
  useEffect(() => {
    loadCounts();
    fetchAll(wc('products/categories')).then(setCategories).catch(() => {});
    fetchAll(wc('products/brands')).then(setBrands).catch(() => {});
    api.get(wc('products/attributes')).then((attrs) => {
      const a = attrs.find((x) => /manufacturer/i.test(x.slug) || /manufacturer/i.test(x.name));
      if (a) fetchAll(wc(`products/attributes/${a.id}/terms`)).then((terms) => setManufacturer({ attr: a, terms })).catch(() => {});
    }).catch(() => {});
  }, []);

  const toggleCol = (k) => setCols((c) => { const n = { ...c, [k]: !c[k] }; try { localStorage.setItem(COLS_KEY, JSON.stringify(n)); } catch { /* ignore */ } return n; });

  const act = async (fn, message) => {
    try { await fn(); showNotice('success', message); reload(); loadCounts(); } catch (e) { showNotice('error', e.message); }
  };
  const onBulk = (action, ids) => {
    if (action === 'delete' && !confirmDelete(`${ids.length} product(s)`)) return;
    const body = action === 'delete' || action === 'trash'
      ? { delete: action === 'delete' ? ids : [], update: action === 'trash' ? ids.map((id) => ({ id, status: 'trash' })) : [] }
      : { update: ids.map((id) => ({ id, status: action === 'restore' ? 'draft' : action })) };
    act(() => api.post(wc('products/batch'), body), `${ids.length} product(s) updated.`);
  };
  const duplicate = (p) => act(async () => {
    const full = await api.get(wc(`products/${p.id}`));
    const copy = {
      ...full, name: `${full.name} (Copy)`, status: 'draft', sku: '', slug: '', global_unique_id: '', images: full.images.map((i) => ({ id: i.id })), brands: (full.brands || []).map((b) => ({ id: b.id })),
    };
    ['id', 'permalink', 'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'variations', 'related_ids', 'price_html', '_links', 'meta_data', 'out_of_stock_date'].forEach((k) => delete copy[k]);
    const created = await api.post(wc('products'), copy);
    if (full.type === 'variable' && full.variations.length) {
      const vars = await fetchAll(wc(`products/${full.id}/variations`));
      await api.post(wc(`products/${created.id}/variations/batch`), {
        create: vars.map((v) => ({ regular_price: v.regular_price, sale_price: v.sale_price, sku: '', manage_stock: v.manage_stock, stock_quantity: v.stock_quantity, stock_status: v.stock_status, attributes: v.attributes, image: v.image ? { id: v.image.id } : undefined, weight: v.weight, dimensions: v.dimensions, description: v.description })),
      });
    }
    navigate(`/products/${created.id}`);
  }, 'Product duplicated.');

  const exportCsv = async () => {
    setExporting(true);
    try {
      const sp = new URLSearchParams();
      if (q.status && q.status !== 'any') sp.set('status', q.status);
      if (q.type) sp.set('type', q.type);
      if (q.category) sp.set('category', q.category);
      const res = await fetch(`/wp-json/${custom('admin/plugins/export/products')}?${sp}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `wc-product-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { showNotice('error', e.message); } finally { setExporting(false); }
  };

  const sort = { orderby: q.orderby, order: q.order };
  const onSort = (key) => setQ({ orderby: key, order: q.orderby === key && q.order === 'asc' ? 'desc' : 'asc' });
  const dash = <span className="muted">–</span>;

  const allColumns = [
    { key: 'thumb', label: '', className: 'thumb', width: 52, render: (p) => (p.images[0] ? <img src={p.images[0].src} alt="" loading="lazy" /> : <span className="muted">—</span>) },
    {
      key: 'name', label: 'Name', sortable: true, sortKey: 'title',
      render: (p) => (
        <>
          <Link className="row-title" to={`/products/${p.id}`}>{decodeHtml(p.name) || '(no title)'}</Link>
          {p.status !== 'publish' && <strong className="muted"> — {statusName(p.status)}</strong>}
          <div className="row-actions">
            <span className="muted">ID: {p.id}</span>
            {p.status !== 'trash' && <span><Link to={`/products/${p.id}`}>Edit</Link></span>}
            {p.status !== 'trash' && <span><a href="#" onClick={(e) => { e.preventDefault(); duplicate(p); }}>Duplicate</a></span>}
            {p.status !== 'trash' && <span><button type="button" className="button-link-delete" onClick={() => act(() => api.del(wc(`products/${p.id}`)), 'Product moved to the Trash.')}>Trash</button></span>}
            {p.status === 'trash' && <span><a href="#" onClick={(e) => { e.preventDefault(); act(() => api.put(wc(`products/${p.id}`), { status: 'draft' }), 'Product restored.'); }}>Restore</a></span>}
            {p.status === 'trash' && <span><button type="button" className="button-link-delete" onClick={() => confirmDelete(`"${p.name}"`) && act(() => api.del(wc(`products/${p.id}`), { force: true }), 'Product deleted permanently.')}>Delete Permanently</button></span>}
            {p.status !== 'trash' && <span><a href={p.permalink} target="_blank" rel="noreferrer">{p.status === 'publish' ? 'View' : 'Preview'}</a></span>}
          </div>
        </>
      ),
    },
    { key: 'sku', label: 'SKU', render: (p) => p.sku || dash },
    { key: 'gtin', label: 'GTIN', render: (p) => p.global_unique_id || dash },
    { key: 'stock', label: 'Stock', render: (p) => stockLabel(p) },
    { key: 'price', label: 'Price', sortable: true, render: (p) => <span dangerouslySetInnerHTML={{ __html: p.price_html || '–' }} /> },
    { key: 'fb_sync', label: 'Synced to Meta catalog', render: (p) => (p.facebook && p.facebook.sync === false ? <span className="muted">Not synced</span> : <span style={{ color: '#00a32a' }}>Synced</span>) },
    { key: 'brands', label: 'Brands', render: (p) => ((p.brands || []).length ? p.brands.map((b, i) => <span key={b.id}>{i > 0 && ', '}<Link to={`/products?brand=${b.id}`}>{decodeHtml(b.name)}</Link></span>) : dash) },
    { key: 'out_of_stock', label: 'Out of Stock Date', render: (p) => (p.out_of_stock_date ? date(p.out_of_stock_date) : dash) },
    { key: 'access_level', label: 'Access Level', render: (p) => accessLabel((p.acf || {}).product_access_level, accessChoices) },
    { key: 'categories', label: 'Categories', render: (p) => p.categories.map((c) => decodeHtml(c.name)).join(', ') || dash },
    { key: 'tags', label: 'Tags', render: (p) => p.tags.map((t) => decodeHtml(t.name)).join(', ') || dash },
    { key: 'type', label: 'Type', render: (p) => p.type },
    { key: 'featured', label: '★', render: (p) => <button type="button" title="Toggle featured" style={{ border: 0, background: 'none', cursor: 'pointer', fontSize: 16, color: p.featured ? '#dba617' : '#c3c4c7' }} onClick={() => act(() => api.put(wc(`products/${p.id}`), { featured: !p.featured }), 'Featured updated.')}>★</button> },
    { key: 'date', label: 'Date', sortable: true, render: (p) => <>{p.status === 'publish' ? 'Published' : 'Last Modified'}<br />{date(p.status === 'publish' ? p.date_created : p.date_modified, true)}</> },
  ];
  const columns = allColumns.filter((c) => c.key === 'thumb' || c.key === 'name' || cols[c.key]);

  // Status tabs: All, standard statuses, then custom ones (e.g. Redirect, Protection), Trash, Sorting
  const statusKeys = Object.keys(counts).filter((k) => k !== 'all' && k !== 'trash' && k !== 'auto-draft' && counts[k] > 0);
  statusKeys.sort((a, b) => (STATUS_ORDER.indexOf(a) + 1 || 99) - (STATUS_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const statusItems = [
    { value: 'any', label: 'All', count: counts.all },
    ...statusKeys.map((k) => ({ value: k, label: statusName(k), count: counts[k] })),
    ...(counts.trash ? [{ value: 'trash', label: 'Trash', count: counts.trash }] : []),
  ];
  const sorting = q.orderby === 'menu_order';

  return (
    <>
      <PageHeader title="Products" action="Add New" actionTo="/products/new">
        <button type="button" className="page-title-action" disabled={exporting} onClick={exportCsv}>{exporting ? 'Exporting…' : 'Export'}</button>
        <button type="button" className="page-title-action" onClick={() => setScreenOpts(true)}>Screen Options</button>
      </PageHeader>
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <span className="flex">
          <StatusLinks value={sorting ? '' : q.status} onChange={(status) => setQ({ status, orderby: 'date', order: 'desc' })} items={statusItems} />
          <span className="muted">|</span>
          <a href="#" className={sorting ? 'current' : ''} onClick={(e) => { e.preventDefault(); setQ({ status: 'any', orderby: 'menu_order', order: 'asc' }); }}>Sorting</a>
        </span>
        <SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder="Search products" />
      </div>
      <div className="tablenav">
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          {manufacturer && (
            <select value={q.manufacturer} onChange={(e) => setQ({ manufacturer: e.target.value })} aria-label="Filter by manufacturer">
              <option value="">All {manufacturer.attr.name || 'Manufacturer'}</option>
              {manufacturer.terms.map((t) => <option key={t.id} value={t.id}>{decodeHtml(t.name)}</option>)}
            </select>
          )}
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
          {brands.length > 0 && (
            <select value={q.brand} onChange={(e) => setQ({ brand: e.target.value })} aria-label="Filter by brand">
              <option value="">Filter by brand</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{decodeHtml(b.name)}{b.count !== undefined ? ` (${b.count})` : ''}</option>)}
            </select>
          )}
          <select value={q.fb_sync} onChange={(e) => setQ({ fb_sync: e.target.value })} aria-label="Filter by Meta sync">
            <option value="">Filter by synced to Meta</option>
            <option value="synced">Synced</option><option value="not_synced">Not synced</option>
          </select>
          <select value={q.access_level} onChange={(e) => setQ({ access_level: e.target.value })} aria-label="Filter by access level">
            <option value="">All Access Levels</option>
            <option value="none">None</option>
            {Object.entries(accessChoices).filter(([k]) => k !== 'none').map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {(q.manufacturer || q.category || q.type || q.stock_status || q.brand || q.fb_sync || q.access_level) && (
            <button type="button" className="button" onClick={() => setQ({ manufacturer: '', category: '', type: '', stock_status: '', brand: '', fb_sync: '', access_level: '' })}>Clear filters</button>
          )}
        </div>
        <Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} />
      </div>
      {sorting && <p className="description">Sorted by menu order (the "Sorting" view). Change a product's position under Product data → Advanced → Menu order.</p>}
      <ListTable
        columns={columns} items={items} loading={loading} error={error} sort={sort} onSort={onSort}
        bulkActions={q.status === 'trash'
          ? [{ value: 'restore', label: 'Restore' }, { value: 'delete', label: 'Delete permanently' }]
          : [{ value: 'publish', label: 'Publish' }, { value: 'draft', label: 'Set to draft' }, { value: 'trash', label: 'Move to Trash' }]}
        onBulk={onBulk}
      />
      <div className="tablenav"><span /><Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} /></div>

      {screenOpts && (
        <Modal title="Screen Options" onClose={() => setScreenOpts(false)} footer={<button type="button" className="button button-primary" onClick={() => setScreenOpts(false)}>Done</button>}>
          <p><strong>Columns</strong></p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
            {OPTIONAL.map(([k, label]) => <label key={k} className="inline"><input type="checkbox" checked={!!cols[k]} onChange={() => toggleCol(k)} /> {label}</label>)}
          </div>
          <p className="mt"><strong>Pagination</strong></p>
          <label className="inline">Number of items per page:{' '}
            <input type="number" min={1} max={100} value={perPage} className="small-text" onChange={(e) => {
              const n = Math.min(100, Math.max(1, Number(e.target.value) || 20));
              setPerPage(n); try { localStorage.setItem('products_per_page', String(n)); } catch { /* ignore */ }
            }} />
          </label>
        </Modal>
      )}
    </>
  );
}
