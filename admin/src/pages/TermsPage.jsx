import { useEffect, useState } from 'react';
import { api, fetchAll, wc, wp } from '../api';
import { useCollection, useNotice, useQueryState } from '../hooks';
import { decodeHtml } from '../format';
import { ImageField } from '../components/media';
import {
  ListTable, Modal, Notice, PageHeader, Pagination, SearchBox, confirmDelete,
} from '../components/ui';

const KINDS = {
  product_cat: { title: 'Product categories', singular: 'category', path: wc('products/categories'), hierarchical: true, image: true, display: true, countLink: (t) => `/products?category=${t.id}` },
  product_tag: { title: 'Product tags', singular: 'tag', path: wc('products/tags') },
  shipping_class: { title: 'Shipping classes', singular: 'shipping class', path: wc('products/shipping_classes') },
  category: { title: 'Categories', singular: 'category', path: wp('categories'), hierarchical: true, wp: true },
  post_tag: { title: 'Tags', singular: 'tag', path: wp('tags'), wp: true },
};

const blank = { name: '', slug: '', description: '', parent: 0, display: 'default', image: null, menu_order: 0 };

function TermForm({ cfg, value, onChange, parents }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="field"><label>Name</label><input type="text" value={decodeHtml(value.name)} onChange={(e) => set({ name: e.target.value })} required /></div>
      <div className="field"><label>Slug</label><input type="text" value={value.slug} onChange={(e) => set({ slug: e.target.value })} /><p className="description">The URL-friendly version of the name. Leave empty to generate.</p></div>
      {cfg.hierarchical && (
        <div className="field"><label>Parent {cfg.singular}</label>
          <select value={value.parent || 0} onChange={(e) => set({ parent: Number(e.target.value) })}>
            <option value={0}>None</option>
            {parents.filter((p) => p.id !== value.id).map((p) => <option key={p.id} value={p.id}>{decodeHtml(p.name)}</option>)}
          </select>
        </div>
      )}
      <div className="field"><label>Description</label><textarea rows={4} value={value.description} onChange={(e) => set({ description: e.target.value })} /></div>
      {cfg.display && (
        <div className="field"><label>Display type</label>
          <select value={value.display} onChange={(e) => set({ display: e.target.value })}><option value="default">Default</option><option value="products">Products</option><option value="subcategories">Subcategories</option><option value="both">Both</option></select>
        </div>
      )}
      {cfg.image && <div className="field"><label>Thumbnail</label><ImageField value={value.image} onChange={(image) => set({ image })} label="Upload/Add image" /></div>}
      {cfg.display && <div className="field"><label>Menu order</label><input type="number" value={value.menu_order} onChange={(e) => set({ menu_order: Number(e.target.value) })} /></div>}
    </>
  );
}

export default function TermsPage({ kind }) {
  const cfg = KINDS[kind];
  const [q, setQ] = useQueryState({ page: '1', search: '' });
  const [notice, showNotice, closeNotice] = useNotice();
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [parents, setParents] = useState([]);
  const { items, total, totalPages, loading, error, reload } = useCollection(cfg.path, { page: q.page, per_page: 20, search: q.search, orderby: 'name', order: 'asc', hide_empty: false });
  const loadParents = () => { if (cfg.hierarchical) fetchAll(cfg.path).then(setParents).catch(() => {}); };
  useEffect(() => { setForm(blank); setEditing(null); loadParents(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = (v) => {
    const b = { name: v.name, description: v.description };
    if (v.slug) b.slug = v.slug;
    if (cfg.hierarchical) b.parent = v.parent || 0;
    if (cfg.display) { b.display = v.display; b.menu_order = v.menu_order; b.image = v.image && v.image.id ? { id: v.image.id } : null; }
    return b;
  };
  const create = async (e) => {
    e.preventDefault();
    try { await api.post(cfg.path, body(form)); setForm(blank); showNotice('success', `${cfg.singular[0].toUpperCase()}${cfg.singular.slice(1)} added.`); reload(); loadParents(); } catch (err) { showNotice('error', err.message); }
  };
  const update = async () => {
    try { await api.put(`${cfg.path}/${editing.id}`, body(editing)); setEditing(null); showNotice('success', 'Item updated.'); reload(); loadParents(); } catch (err) { showNotice('error', err.message); }
  };
  const remove = async (ids) => {
    try {
      for (const id of ids) await api.del(`${cfg.path}/${id}`, { force: true });
      showNotice('success', `${ids.length} item(s) deleted.`); reload(); loadParents();
    } catch (err) { showNotice('error', err.message); }
  };
  const parentName = (id) => (parents.find((p) => p.id === id) || {}).name;

  const columns = [
    ...(cfg.image ? [{ key: 'image', label: 'Image', className: 'thumb', render: (t) => (t.image ? <img src={t.image.src} alt="" /> : <span className="muted">—</span>) }] : []),
    { key: 'name', label: 'Name', render: (t) => (
      <>
        <a href="#" className="row-title" onClick={(e) => { e.preventDefault(); setEditing({ ...blank, ...t, parent: t.parent || 0 }); }}>{t.parent && parentName(t.parent) ? '— ' : ''}{decodeHtml(t.name)}</a>
        <div className="row-actions">
          <span className="muted">ID: {t.id}</span>
          <span><a href="#" onClick={(e) => { e.preventDefault(); setEditing({ ...blank, ...t, parent: t.parent || 0 }); }}>Edit</a></span>
          {t.slug !== 'uncategorized' && <span><button type="button" className="button-link-delete" onClick={() => confirmDelete(`"${decodeHtml(t.name)}"`) && remove([t.id])}>Delete</button></span>}
        </div>
      </>
    ) },
    { key: 'description', label: 'Description', render: (t) => t.description || <span className="muted">—</span> },
    { key: 'slug', label: 'Slug' },
    { key: 'count', label: 'Count', render: (t) => t.count },
  ];

  return (
    <>
      <PageHeader title={cfg.title} />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout" style={{ gridTemplateColumns: '320px minmax(0, 1fr)' }}>
        <form onSubmit={create}>
          <h2>Add new {cfg.singular}</h2>
          <TermForm cfg={cfg} value={form} onChange={setForm} parents={parents} />
          <button type="submit" className="button button-primary">Add new {cfg.singular}</button>
        </form>
        <div>
          <div className="tablenav"><SearchBox value={q.search} onSearch={(search) => setQ({ search })} placeholder={`Search ${cfg.title.toLowerCase()}`} />
            <Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} /></div>
          <ListTable columns={columns} items={items} loading={loading} error={error} bulkActions={[{ value: 'delete', label: 'Delete' }]}
            onBulk={(a, ids) => confirmDelete(`${ids.length} item(s)`) && remove(ids)} />
        </div>
      </div>
      {editing && (
        <Modal title={`Edit ${cfg.singular}`} onClose={() => setEditing(null)} width={560}
          footer={<><button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="button button-primary" onClick={update}>Update</button></>}>
          <TermForm cfg={cfg} value={editing} onChange={setEditing} parents={parents} />
        </Modal>
      )}
    </>
  );
}
