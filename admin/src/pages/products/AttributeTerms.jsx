import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, wc } from '../../api';
import { useCollection, useNotice, useResource } from '../../hooks';
import { decodeHtml } from '../../format';
import {
  ListTable, Modal, Notice, PageHeader, Pagination, confirmDelete,
} from '../../components/ui';

const blank = { name: '', slug: '', description: '', menu_order: 0 };

export default function AttributeTerms() {
  const { id } = useParams();
  const [attr] = useResource(wc(`products/attributes/${id}`));
  const [page, setPage] = useState(1);
  const { items, total, totalPages, loading, error, reload } = useCollection(wc(`products/attributes/${id}/terms`), { page, per_page: 50 });
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [notice, showNotice, closeNotice] = useNotice();
  const run = async (fn, msg) => { try { await fn(); showNotice('success', msg); reload(); } catch (e) { showNotice('error', e.message); } };
  const fields = (v, set) => (
    <>
      <div className="field"><label>Name</label><input type="text" value={decodeHtml(v.name)} onChange={(e) => set({ ...v, name: e.target.value })} required /></div>
      <div className="field"><label>Slug</label><input type="text" value={v.slug} onChange={(e) => set({ ...v, slug: e.target.value })} /></div>
      <div className="field"><label>Description</label><textarea rows={3} value={v.description} onChange={(e) => set({ ...v, description: e.target.value })} /></div>
      <div className="field"><label>Order</label><input type="number" value={v.menu_order} onChange={(e) => set({ ...v, menu_order: Number(e.target.value) })} /></div>
    </>
  );
  return (
    <>
      <PageHeader title={`${attr ? attr.name : 'Attribute'} — terms`}><Link to="/products/attributes">← Back to attributes</Link></PageHeader>
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout" style={{ gridTemplateColumns: '320px minmax(0, 1fr)' }}>
        <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post(wc(`products/attributes/${id}/terms`), { ...form, slug: form.slug || undefined }); setForm(blank); }, 'Term added.'); }}>
          <h2>Add new {attr ? attr.name : 'term'}</h2>
          {fields(form, setForm)}
          <button type="submit" className="button button-primary">Add new</button>
        </form>
        <div>
          <div className="tablenav"><span /><Pagination page={page} total={total} totalPages={totalPages} onPage={setPage} /></div>
          <ListTable items={items} loading={loading} error={error}
            bulkActions={[{ value: 'delete', label: 'Delete' }]}
            onBulk={(a, ids) => confirmDelete(`${ids.length} term(s)`) && run(() => api.post(wc(`products/attributes/${id}/terms/batch`), { delete: ids }), 'Terms deleted.')}
            columns={[
              { key: 'name', label: 'Name', render: (t) => (<><strong>{decodeHtml(t.name)}</strong><div className="row-actions">
                <span><a href="#" onClick={(e) => { e.preventDefault(); setEditing(t); }}>Edit</a></span>
                <span><button type="button" className="button-link-delete" onClick={() => confirmDelete(`"${t.name}"`) && run(() => api.del(wc(`products/attributes/${id}/terms/${t.id}`), { force: true }), 'Term deleted.')}>Delete</button></span></div></>) },
              { key: 'slug', label: 'Slug' },
              { key: 'description', label: 'Description' },
              { key: 'menu_order', label: 'Order' },
              { key: 'count', label: 'Count' },
            ]} />
        </div>
      </div>
      {editing && (
        <Modal title="Edit term" onClose={() => setEditing(null)} width={520}
          footer={<><button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="button button-primary" onClick={() => run(async () => { await api.put(wc(`products/attributes/${id}/terms/${editing.id}`), { name: editing.name, slug: editing.slug, description: editing.description, menu_order: editing.menu_order }); setEditing(null); }, 'Term updated.')}>Update</button></>}>
          {fields(editing, setEditing)}
        </Modal>
      )}
    </>
  );
}
