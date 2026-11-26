import { useEffect, useState } from 'react';
import { api, custom, fetchAll, wc } from '../../api';
import { useNotice, useResource } from '../../hooks';
import { date } from '../../format';
import {
  Loading, Modal, Notice, PageHeader, confirmDelete,
} from '../../components/ui';

// WooCommerce → Settings → Advanced → REST API
export default function ApiKeys() {
  const [keys, , { loading, reload }] = useResource(custom('admin/api-keys'));
  const [notice, showNotice, closeNotice] = useNotice();
  const [creating, setCreating] = useState(null);
  const [created, setCreated] = useState(null);
  const [staff, setStaff] = useState([]);
  useEffect(() => { fetchAll(wc('customers'), { role: 'administrator' }).then(async (a) => setStaff([...a, ...(await fetchAll(wc('customers'), { role: 'shop_manager' }).catch(() => []))])).catch(() => {}); }, []);

  const create = async () => {
    try {
      const k = await api.post(custom('admin/api-keys'), creating);
      setCreating(null); setCreated(k); reload();
    } catch (e) { showNotice('error', e.message); }
  };
  const revoke = async (k) => {
    if (!confirmDelete(`the key "${k.description}" — apps using it will stop working`)) return;
    try { await api.del(custom(`admin/api-keys/${k.id}`)); showNotice('success', 'API key revoked.'); reload(); } catch (e) { showNotice('error', e.message); }
  };
  const copy = (text) => navigator.clipboard && navigator.clipboard.writeText(text);

  return (
    <>
      <PageHeader title="REST API keys" onAction={() => setCreating({ description: '', permissions: 'read', user_id: '' })} action="Add key" />
      <Notice notice={notice} onClose={closeNotice} />
      <p className="muted">Keys work exactly like WooCommerce consumer keys (Basic auth or <code>consumer_key</code>/<code>consumer_secret</code> query params) on <code>/wp-json/wc/v3</code>. Keys imported from WordPress keep working.</p>
      {loading && !keys ? <Loading /> : (
        <table className="wp-list-table">
          <thead><tr><th>Description</th><th>Consumer key ending in</th><th>User</th><th>Permissions</th><th>Last access</th><th /></tr></thead>
          <tbody>
            {(keys || []).map((k) => (
              <tr key={k.id}>
                <td><strong>{k.description || '(no description)'}</strong></td>
                <td><code>…{k.truncated_key}</code></td>
                <td>{k.user ? `${k.user.name} (${k.user.email})` : '—'}</td>
                <td>{{ read: 'Read', write: 'Write', read_write: 'Read/Write' }[k.permissions]}</td>
                <td>{k.last_access ? date(k.last_access, true) : 'Unknown'}</td>
                <td><button type="button" className="button-link-delete" onClick={() => revoke(k)}>Revoke</button></td>
              </tr>
            ))}
            {keys && !keys.length && <tr className="empty"><td colSpan={6}>No keys yet.</td></tr>}
          </tbody>
        </table>
      )}
      {creating && (
        <Modal title="Add API key" onClose={() => setCreating(null)} width={520}
          footer={<><button type="button" className="button" onClick={() => setCreating(null)}>Cancel</button><button type="button" className="button button-primary" disabled={!creating.description.trim()} onClick={create}>Generate API key</button></>}>
          <div className="field"><label>Description</label><input type="text" value={creating.description} onChange={(e) => setCreating({ ...creating, description: e.target.value })} placeholder="e.g. Storefront (Next.js)" /></div>
          <div className="field"><label>User</label><select value={creating.user_id} onChange={(e) => setCreating({ ...creating, user_id: e.target.value })}>
            <option value="">Me</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}</select>
            <p className="description">The key acts with this user's permissions.</p></div>
          <div className="field"><label>Permissions</label><select value={creating.permissions} onChange={(e) => setCreating({ ...creating, permissions: e.target.value })}>
            <option value="read">Read</option><option value="write">Write</option><option value="read_write">Read/Write</option></select></div>
        </Modal>
      )}
      {created && (
        <Modal title="API key generated" onClose={() => setCreated(null)} width={620}
          footer={<button type="button" className="button button-primary" onClick={() => setCreated(null)}>I have saved the keys</button>}>
          <div className="notice notice-warning"><span>Make sure to copy your new keys now — the consumer key won't be shown again.</span></div>
          <div className="field"><label>Consumer key</label><div className="flex"><input type="text" readOnly value={created.consumer_key} onFocus={(e) => e.target.select()} style={{ flex: 1 }} /><button type="button" className="button" onClick={() => copy(created.consumer_key)}>Copy</button></div></div>
          <div className="field"><label>Consumer secret</label><div className="flex"><input type="text" readOnly value={created.consumer_secret} onFocus={(e) => e.target.select()} style={{ flex: 1 }} /><button type="button" className="button" onClick={() => copy(created.consumer_secret)}>Copy</button></div></div>
        </Modal>
      )}
    </>
  );
}
