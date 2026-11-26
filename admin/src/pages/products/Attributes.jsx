import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, wc } from '../../api';
import { useNotice, useResource } from '../../hooks';
import { Loading, Modal, Notice, PageHeader, confirmDelete } from '../../components/ui';

const blank = { name: '', slug: '', order_by: 'menu_order', has_archives: false };

function AttrForm({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="field"><label>Name</label><input type="text" value={value.name} onChange={(e) => set({ name: e.target.value })} required /></div>
      <div className="field"><label>Slug</label><input type="text" value={value.slug.replace(/^pa_/, '')} onChange={(e) => set({ slug: e.target.value })} maxLength={28} /><p className="description">Unique slug/reference; max 28 characters.</p></div>
      <label className="inline mb"><input type="checkbox" checked={value.has_archives} onChange={(e) => set({ has_archives: e.target.checked })} /> Enable archives</label>
      <div className="field"><label>Default sort order</label>
        <select value={value.order_by} onChange={(e) => set({ order_by: e.target.value })}><option value="menu_order">Custom ordering</option><option value="name">Name</option><option value="name_num">Name (numeric)</option><option value="id">Term ID</option></select></div>
    </>
  );
}

export default function Attributes() {
  const [attrs, , { loading, reload }] = useResource(wc('products/attributes'));
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [notice, showNotice, closeNotice] = useNotice();
  const run = async (fn, msg) => { try { await fn(); showNotice('success', msg); reload(); } catch (e) { showNotice('error', e.message); } };
  return (
    <>
      <PageHeader title="Attributes" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout" style={{ gridTemplateColumns: '320px minmax(0, 1fr)' }}>
        <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post(wc('products/attributes'), { ...form, slug: form.slug || undefined }); setForm(blank); }, 'Attribute added.'); }}>
          <h2>Add new attribute</h2>
          <p className="muted">Attributes let you define extra product data, such as size or color.</p>
          <AttrForm value={form} onChange={setForm} />
          <button type="submit" className="button button-primary">Add attribute</button>
        </form>
        <div>
          {loading && !attrs ? <Loading /> : (
            <table className="wp-list-table">
              <thead><tr><th>Name</th><th>Slug</th><th>Order by</th><th>Terms</th></tr></thead>
              <tbody>
                {(attrs || []).map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.name}</strong>
                      <div className="row-actions"><span><a href="#" onClick={(e) => { e.preventDefault(); setEditing(a); }}>Edit</a></span>
                        <span><button type="button" className="button-link-delete" onClick={() => confirmDelete(`attribute "${a.name}"`) && run(() => api.del(wc(`products/attributes/${a.id}`), { force: true }), 'Attribute deleted.')}>Delete</button></span></div></td>
                    <td>{a.slug}</td><td>{a.order_by}</td>
                    <td><Link to={`/products/attributes/${a.id}`}>Configure terms</Link></td>
                  </tr>
                ))}
                {attrs && !attrs.length && <tr className="empty"><td colSpan={4}>No attributes currently exist.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {editing && (
        <Modal title="Edit attribute" onClose={() => setEditing(null)} width={520}
          footer={<><button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="button button-primary" onClick={() => run(async () => { await api.put(wc(`products/attributes/${editing.id}`), { name: editing.name, slug: editing.slug.replace(/^pa_/, ''), order_by: editing.order_by, has_archives: editing.has_archives }); setEditing(null); }, 'Attribute updated.')}>Update</button></>}>
          <AttrForm value={editing} onChange={setEditing} />
        </Modal>
      )}
    </>
  );
}
