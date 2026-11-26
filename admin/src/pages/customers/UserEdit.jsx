import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, wc, wp } from '../../api';
import { useNotice } from '../../hooks';
import { Loading, Notice, PageHeader, Postbox } from '../../components/ui';

const BILLING = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'postcode', 'country', 'state', 'phone', 'email'];
const SHIPPING = BILLING.filter((f) => f !== 'email');
const label = (f) => f.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const blankAddr = (fields) => Object.fromEntries(fields.map((f) => [f, '']));

export default function UserEdit({ kind }) {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [u, setU] = useState(null);
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('customer');
  const [notice, showNotice, closeNotice] = useNotice();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isNew) { setU({ email: '', first_name: '', last_name: '', username: '', billing: blankAddr(BILLING), shipping: blankAddr(SHIPPING), role: 'customer' }); return; }
    api.get(wc(`customers/${id}`)).then((c) => { setU(c); setRole(c.role); }).catch((e) => showNotice('error', e.message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!u) return <><Notice notice={notice} onClose={closeNotice} /><Loading /></>;
  const set = (patch) => setU((x) => ({ ...x, ...patch }));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { email: u.email, first_name: u.first_name, last_name: u.last_name, billing: u.billing, shipping: u.shipping };
      if (password) body.password = password;
      let saved;
      if (isNew) {
        saved = await api.post(wc('customers'), { ...body, username: u.username || undefined, password: password || undefined });
        if (role !== 'customer') await api.put(wp(`users/${saved.id}`), { roles: [role] });
        navigate(`/${kind === 'customer' ? 'customers' : 'users'}/${saved.id}`, { replace: true });
      } else {
        saved = await api.put(wc(`customers/${id}`), body);
        if (role !== u.role) await api.put(wp(`users/${id}`), { roles: [role] });
        setU({ ...saved, role });
      }
      setPassword('');
      showNotice('success', isNew ? 'User created.' : 'Profile updated.');
    } catch (err) { showNotice('error', err.message); } finally { setSaving(false); }
  };

  const addrFields = (key, fields) => (
    <div className="grid-2">{fields.map((f) => (
      <div key={f} className="field"><label>{label(f)}</label><input type="text" value={(u[key] || {})[f] || ''} onChange={(e) => set({ [key]: { ...u[key], [f]: e.target.value } })} /></div>
    ))}</div>
  );

  return (
    <form onSubmit={save}>
      <PageHeader title={isNew ? 'Add new user' : `Edit ${[u.first_name, u.last_name].filter(Boolean).join(' ') || u.username}`}>
        {!isNew && <Link to={`/orders?customer=${id}`}>View orders</Link>}
      </PageHeader>
      <Notice notice={notice} onClose={closeNotice} />
      <Postbox title="Account">
        <table className="form-table"><tbody>
          <tr><th>Username</th><td>{isNew ? <input type="text" className="regular-text" value={u.username} onChange={(e) => set({ username: e.target.value })} placeholder="Generated from email if empty" /> : <><code>{u.username}</code> <span className="description">Usernames cannot be changed.</span></>}</td></tr>
          <tr><th>Email (required)</th><td><input type="email" className="regular-text" required value={u.email} onChange={(e) => set({ email: e.target.value })} /></td></tr>
          <tr><th>First name</th><td><input type="text" className="regular-text" value={u.first_name} onChange={(e) => set({ first_name: e.target.value })} /></td></tr>
          <tr><th>Last name</th><td><input type="text" className="regular-text" value={u.last_name} onChange={(e) => set({ last_name: e.target.value })} /></td></tr>
          <tr><th>Role</th><td><select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="customer">Customer</option><option value="subscriber">Subscriber</option><option value="contributor">Contributor</option><option value="author">Author</option>
            <option value="editor">Editor</option><option value="shop_manager">Shop manager</option><option value="administrator">Administrator</option></select></td></tr>
          <tr><th>{isNew ? 'Password' : 'New password'}</th><td><input type="password" className="regular-text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isNew ? 'Random if empty' : 'Leave empty to keep'} minLength={6} /></td></tr>
        </tbody></table>
      </Postbox>
      <div className="grid-2">
        <Postbox title="Customer billing address">{addrFields('billing', BILLING)}</Postbox>
        <Postbox title="Customer shipping address">{addrFields('shipping', SHIPPING)}</Postbox>
      </div>
      <button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Saving…' : isNew ? 'Add New User' : 'Update User'}</button>
    </form>
  );
}
