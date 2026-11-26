import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fetchAll, wc } from '../../api';
import { useNotice } from '../../hooks';
import SettingsForm from '../../components/SettingsForm';
import { EmailsTab } from '../plugins/PluginPages';
import { Loading, Modal, Notice, PageHeader, confirmDelete } from '../../components/ui';

const TABS = [['general', 'General'], ['products', 'Products'], ['tax', 'Tax'], ['shipping', 'Shipping'], ['checkout', 'Payments'], ['account', 'Accounts & Privacy'], ['email', 'Emails'], ['advanced', 'Advanced']];

// ───────── Tax rates (per class) ─────────
function TaxRates({ onNotice }) {
  const [classes, setClasses] = useState(null);
  const [cls, setCls] = useState('standard');
  const [rates, setRates] = useState([]);
  const [deleted, setDeleted] = useState([]);
  const [newClass, setNewClass] = useState('');
  const load = () => fetchAll(wc('taxes'), { class: cls }).then((r) => { setRates(r.map((x) => ({ ...x, postcode: (x.postcodes || []).join('; '), city: (x.cities || []).join('; ') }))); setDeleted([]); });
  useEffect(() => { api.get(wc('taxes/classes')).then(setClasses).catch((e) => onNotice('error', e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch((e) => onNotice('error', e.message)); }, [cls]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!classes) return <Loading />;
  const set = (i, patch) => setRates((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch, _dirty: true } : r)));
  const body = (r) => ({ country: r.country, state: r.state, postcode: r.postcode, city: r.city, rate: String(r.rate), name: r.name, priority: Number(r.priority) || 1, compound: !!r.compound, shipping: !!r.shipping, order: r.order, class: cls });
  const save = async () => {
    try {
      const res = await api.post(wc('taxes/batch'), {
        create: rates.filter((r) => !r.id).map((r, i) => ({ ...body(r), order: i })),
        update: rates.filter((r) => r.id && r._dirty).map((r) => ({ id: r.id, ...body(r) })),
        delete: deleted,
      });
      const errs = [...(res.create || []), ...(res.update || [])].filter((x) => x.error);
      onNotice(errs.length ? 'error' : 'success', errs.length ? errs.map((x) => x.error.message).join('<br>') : 'Tax rates saved.');
      await load();
    } catch (e) { onNotice('error', e.message); }
  };
  const addClass = async () => {
    try { const c = await api.post(wc('taxes/classes'), { name: newClass }); setClasses([...classes, c]); setNewClass(''); setCls(c.slug); } catch (e) { onNotice('error', e.message); }
  };
  return (
    <>
      <h2>Tax rates</h2>
      <ul className="subsubsub">{classes.map((c) => <li key={c.slug}><a href="#" className={cls === c.slug ? 'current' : ''} onClick={(e) => { e.preventDefault(); setCls(c.slug); }}>{c.name}</a></li>)}</ul>
      <div className="flex mb">
        <input type="text" value={newClass} onChange={(e) => setNewClass(e.target.value)} placeholder="New tax class name" />
        <button type="button" className="button" disabled={!newClass.trim()} onClick={addClass}>Add class</button>
        {cls !== 'standard' && <button type="button" className="button-link-delete" onClick={() => confirmDelete(`the "${cls}" class and its rates`) && api.del(wc(`taxes/classes/${cls}`), { force: true }).then(() => { setClasses(classes.filter((c) => c.slug !== cls)); setCls('standard'); })}>Delete this class</button>}
      </div>
      <table className="wp-list-table">
        <thead><tr><th>Country code</th><th>State code</th><th>Postcode / ZIP</th><th>City</th><th>Rate %</th><th>Tax name</th><th>Priority</th><th>Compound</th><th>Shipping</th><th /></tr></thead>
        <tbody>
          {rates.map((r, i) => (
            <tr key={r.id || `n${i}`}>
              <td><input type="text" className="small-text" value={r.country} placeholder="*" onChange={(e) => set(i, { country: e.target.value.toUpperCase() })} aria-label="Country" /></td>
              <td><input type="text" className="small-text" value={r.state} placeholder="*" onChange={(e) => set(i, { state: e.target.value.toUpperCase() })} aria-label="State" /></td>
              <td><input type="text" value={r.postcode} placeholder="*" onChange={(e) => set(i, { postcode: e.target.value })} aria-label="Postcodes" /></td>
              <td><input type="text" value={r.city} placeholder="*" onChange={(e) => set(i, { city: e.target.value })} aria-label="Cities" /></td>
              <td><input type="text" className="small-text" value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} aria-label="Rate" /></td>
              <td><input type="text" value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Name" /></td>
              <td><input type="number" className="small-text" value={r.priority} onChange={(e) => set(i, { priority: e.target.value })} aria-label="Priority" /></td>
              <td><input type="checkbox" checked={!!r.compound} onChange={(e) => set(i, { compound: e.target.checked })} aria-label="Compound" /></td>
              <td><input type="checkbox" checked={!!r.shipping} onChange={(e) => set(i, { shipping: e.target.checked })} aria-label="Shipping" /></td>
              <td><button type="button" className="button-link-delete" onClick={() => { if (r.id) setDeleted((d) => [...d, r.id]); setRates(rates.filter((_, j) => j !== i)); }}>Remove</button></td>
            </tr>
          ))}
          {!rates.length && <tr className="empty"><td colSpan={10}>No rates for this class.</td></tr>}
        </tbody>
      </table>
      <p className="description">Postcodes/cities: separate with semicolons. Wildcards (90*) and ranges (2000...2999) are supported. Empty = all.</p>
      <div className="flex mt">
        <button type="button" className="button" onClick={() => setRates([...rates, { country: '', state: '', postcode: '', city: '', rate: '', name: 'Tax', priority: 1, compound: false, shipping: true }])}>Insert row</button>
        <button type="button" className="button button-primary" onClick={save}>Save rates</button>
      </div>
    </>
  );
}

// ───────── Shipping zones ─────────
function ZoneEditor({ zone, onClose, onNotice, classes }) {
  const [name, setName] = useState(zone.name);
  const [locs, setLocs] = useState(null);
  const [methods, setMethods] = useState([]);
  const [editMethod, setEditMethod] = useState(null);
  const isRest = zone.id === 0;
  const load = async () => {
    setLocs(isRest ? [] : await api.get(wc(`shipping/zones/${zone.id}/locations`)));
    setMethods(await api.get(wc(`shipping/zones/${zone.id}/methods`)));
  };
  useEffect(() => { load().catch((e) => onNotice('error', e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!locs) return <Loading />;
  const saveZone = async () => {
    try {
      if (!isRest) {
        await api.put(wc(`shipping/zones/${zone.id}`), { name });
        await api.put(wc(`shipping/zones/${zone.id}/locations`), locs.filter((l) => l.code.trim()));
      }
      onNotice('success', 'Zone saved.');
      onClose(true);
    } catch (e) { onNotice('error', e.message); }
  };
  const addMethod = async (methodId) => {
    try { await api.post(wc(`shipping/zones/${zone.id}/methods`), { method_id: methodId }); await load(); } catch (e) { onNotice('error', e.message); }
  };
  const saveMethod = async () => {
    try {
      const settings = Object.fromEntries(Object.entries(editMethod.settings).map(([k, v]) => [k, v.value]));
      await api.put(wc(`shipping/zones/${zone.id}/methods/${editMethod.instance_id}`), { enabled: editMethod.enabled, settings });
      setEditMethod(null); await load();
    } catch (e) { onNotice('error', e.message); }
  };
  return (
    <>
      <p><a href="#" onClick={(e) => { e.preventDefault(); onClose(false); }}>← Shipping zones</a></p>
      <table className="form-table"><tbody>
        <tr><th>Zone name</th><td>{isRest ? zone.name : <input type="text" className="regular-text" value={name} onChange={(e) => setName(e.target.value)} />}</td></tr>
        {!isRest && <tr><th>Zone regions</th><td>
          {locs.map((l, i) => (
            <div key={i} className="flex mb">
              <select value={l.type} onChange={(e) => setLocs(locs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} aria-label="Type">
                <option value="country">Country</option><option value="state">State (CC:ST)</option><option value="postcode">Postcode</option><option value="continent">Continent</option></select>
              <input type="text" value={l.code} placeholder={{ country: 'AU', state: 'AU:NSW', postcode: '2000...2999', continent: 'OC' }[l.type]} onChange={(e) => setLocs(locs.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} aria-label="Code" />
              <button type="button" className="button-link-delete" onClick={() => setLocs(locs.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="button" onClick={() => setLocs([...locs, { type: 'country', code: '' }])}>Add region</button>
          <p className="description">Postcode rules are matched within the country/state regions of this zone.</p>
        </td></tr>}
        <tr><th>Shipping methods</th><td>
          <table className="wp-list-table"><thead><tr><th>Title</th><th>Enabled</th><th>Method</th><th /></tr></thead><tbody>
            {methods.map((m) => (
              <tr key={m.instance_id}>
                <td>{m.title}</td>
                <td><input type="checkbox" checked={m.enabled} onChange={(e) => api.put(wc(`shipping/zones/${zone.id}/methods/${m.instance_id}`), { enabled: e.target.checked }).then(load)} aria-label="Enabled" /></td>
                <td>{m.method_title}</td>
                <td className="flex"><a href="#" onClick={(e) => { e.preventDefault(); setEditMethod(JSON.parse(JSON.stringify(m))); }}>Edit</a>
                  <button type="button" className="button-link-delete" onClick={() => confirmDelete(`"${m.title}"`) && api.del(wc(`shipping/zones/${zone.id}/methods/${m.instance_id}`)).then(load)}>Delete</button></td>
              </tr>
            ))}
            {!methods.length && <tr className="empty"><td colSpan={4}>No shipping methods offered to this zone.</td></tr>}
          </tbody></table>
          <div className="flex mt"><span>Add:</span>
            <button type="button" className="button" onClick={() => addMethod('flat_rate')}>Flat rate</button>
            <button type="button" className="button" onClick={() => addMethod('free_shipping')}>Free shipping</button>
            <button type="button" className="button" onClick={() => addMethod('local_pickup')}>Local pickup</button></div>
        </td></tr>
      </tbody></table>
      <button type="button" className="button button-primary" onClick={saveZone}>Save changes</button>
      {editMethod && (
        <Modal title={`${editMethod.method_title} settings`} onClose={() => setEditMethod(null)} width={560}
          footer={<><button type="button" className="button" onClick={() => setEditMethod(null)}>Cancel</button><button type="button" className="button button-primary" onClick={saveMethod}>Save changes</button></>}>
          {Object.values(editMethod.settings).map((s) => (
            <div key={s.id} className="field"><label>{s.label}</label>
              {s.options ? (
                <select value={s.value} onChange={(e) => setEditMethod({ ...editMethod, settings: { ...editMethod.settings, [s.id]: { ...s, value: e.target.value } } })}>
                  {Object.entries(s.options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              ) : s.type === 'checkbox' ? (
                <input type="checkbox" checked={s.value === 'yes'} onChange={(e) => setEditMethod({ ...editMethod, settings: { ...editMethod.settings, [s.id]: { ...s, value: e.target.checked ? 'yes' : 'no' } } })} />
              ) : (
                <input type="text" value={s.value ?? ''} onChange={(e) => setEditMethod({ ...editMethod, settings: { ...editMethod.settings, [s.id]: { ...s, value: e.target.value } } })} />
              )}
              {s.tip && <p className="description">{s.tip}</p>}
            </div>
          ))}
          {editMethod.method_id === 'flat_rate' && !classes.length && <p className="description">Add shipping classes under Products → Shipping classes to set per-class costs.</p>}
        </Modal>
      )}
    </>
  );
}

function ShippingZones({ onNotice }) {
  const [zones, setZones] = useState(null);
  const [methods, setMethods] = useState({});
  const [editing, setEditing] = useState(null);
  const [classes, setClasses] = useState([]);
  const load = async () => {
    const zs = await api.get(wc('shipping/zones'));
    setZones(zs);
    const entries = await Promise.all(zs.map(async (z) => [z.id, await api.get(wc(`shipping/zones/${z.id}/methods`))]));
    setMethods(Object.fromEntries(entries));
  };
  useEffect(() => { load().catch((e) => onNotice('error', e.message)); fetchAll(wc('products/shipping_classes')).then(setClasses).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!zones) return <Loading />;
  if (editing) return <ZoneEditor zone={editing} classes={classes} onNotice={onNotice} onClose={(changed) => { setEditing(null); if (changed !== undefined) load(); }} />;
  const addZone = async () => {
    const name = window.prompt('Zone name', 'New zone');
    if (!name) return;
    try { const z = await api.post(wc('shipping/zones'), { name, order: zones.length }); setEditing(z); } catch (e) { onNotice('error', e.message); }
  };
  return (
    <>
      <h2 className="flex">Shipping zones <button type="button" className="page-title-action" onClick={addZone}>Add zone</button></h2>
      <p className="muted">A shipping zone is a geographic region where a certain set of shipping methods are offered. Customers are matched to the first zone that fits their address.</p>
      <table className="wp-list-table">
        <thead><tr><th>Zone name</th><th>Region(s)</th><th>Shipping method(s)</th><th /></tr></thead>
        <tbody>
          {[...zones.filter((z) => z.id !== 0), ...zones.filter((z) => z.id === 0)].map((z) => (
            <tr key={z.id}>
              <td><a href="#" className="row-title" onClick={(e) => { e.preventDefault(); setEditing(z); }}>{z.name}</a></td>
              <td>{z.id === 0 ? <span className="muted">Everywhere else</span> : <ZoneRegions id={z.id} />}</td>
              <td>{(methods[z.id] || []).map((m) => <span key={m.instance_id} className="tag-chip" style={{ opacity: m.enabled ? 1 : 0.5 }}>{m.title}</span>)}
                {methods[z.id] && !methods[z.id].length && <span className="muted">No shipping methods</span>}</td>
              <td className="flex"><a href="#" onClick={(e) => { e.preventDefault(); setEditing(z); }}>Edit</a>
                {z.id !== 0 && <button type="button" className="button-link-delete" onClick={() => confirmDelete(`zone "${z.name}"`) && api.del(wc(`shipping/zones/${z.id}`), { force: true }).then(load)}>Delete</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
function ZoneRegions({ id }) {
  const [locs, setLocs] = useState(null);
  useEffect(() => { api.get(wc(`shipping/zones/${id}/locations`)).then(setLocs).catch(() => setLocs([])); }, [id]);
  if (!locs) return <span className="muted">…</span>;
  return locs.length ? locs.map((l) => l.code).join(', ') : <span className="muted">No regions</span>;
}

// ───────── Payment gateways ─────────
function Gateways({ onNotice }) {
  const [gateways, setGateways] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => api.get(wc('payment_gateways')).then(setGateways).catch((e) => onNotice('error', e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!gateways) return <Loading />;
  const toggle = (g) => api.put(wc(`payment_gateways/${g.id}`), { enabled: !g.enabled }).then(load).catch((e) => onNotice('error', e.message));
  const save = async () => {
    try {
      const settings = Object.fromEntries(Object.entries(editing.settings).filter(([k]) => !['title', 'description'].includes(k)).map(([k, v]) => [k, v.value]));
      await api.put(wc(`payment_gateways/${editing.id}`), { title: editing.title, description: editing.description, order: Number(editing.order) || 0, settings });
      setEditing(null); onNotice('success', 'Payment method saved.'); load();
    } catch (e) { onNotice('error', e.message); }
  };
  return (
    <>
      <h2>Payment methods</h2>
      <p className="muted">Gateway credentials imported from WordPress are kept here. Payments themselves are processed by your frontend/payment provider; mark orders paid through the API.</p>
      <table className="wp-list-table">
        <thead><tr><th>Method</th><th>Enabled</th><th>Description</th><th>Order</th><th /></tr></thead>
        <tbody>{gateways.map((g) => (
          <tr key={g.id}>
            <td><strong>{g.title}</strong><div className="muted"><code>{g.id}</code></div></td>
            <td><button type="button" className="button button-small" onClick={() => toggle(g)}>{g.enabled ? '✔ Enabled' : 'Disabled'}</button></td>
            <td>{g.description}</td>
            <td>{g.order}</td>
            <td><a href="#" onClick={(e) => { e.preventDefault(); setEditing(JSON.parse(JSON.stringify(g))); }}>Manage</a></td>
          </tr>
        ))}
        {!gateways.length && <tr className="empty"><td colSpan={5}>No payment methods. Run the seed script or import from WordPress.</td></tr>}
        </tbody>
      </table>
      {editing && (
        <Modal title={editing.method_title || editing.title} onClose={() => setEditing(null)} width={620}
          footer={<><button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="button button-primary" onClick={save}>Save changes</button></>}>
          <div className="field"><label>Title</label><input type="text" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></div>
          <div className="field"><label>Description</label><textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
          <div className="field"><label>Order</label><input type="number" value={editing.order} onChange={(e) => setEditing({ ...editing, order: e.target.value })} /></div>
          {Object.values(editing.settings).filter((s) => !['title', 'description'].includes(s.id)).map((s) => (
            <div key={s.id} className="field"><label>{s.label}</label>
              {typeof s.value === 'object' && s.value !== null ? <code>{JSON.stringify(s.value)}</code> : (
                <input type={/secret|password|key|token/i.test(s.id) ? 'password' : 'text'} autoComplete="off" value={s.value ?? ''} onChange={(e) => setEditing({ ...editing, settings: { ...editing.settings, [s.id]: { ...s, value: e.target.value } } })} />
              )}
            </div>
          ))}
        </Modal>
      )}
    </>
  );
}

export default function WooSettings() {
  const { tab = 'general' } = useParams();
  const [notice, showNotice, closeNotice] = useNotice();
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="nav-tab-wrapper">{TABS.map(([k, l]) => <Link key={k} to={`/woo/settings/${k}`} className={`nav-tab ${tab === k ? 'nav-tab-active' : ''}`}>{l}</Link>)}</nav>
      <Notice notice={notice} onClose={closeNotice} />
      {tab === 'tax' && <><SettingsForm group="tax" onNotice={showNotice} /><TaxRates onNotice={showNotice} /></>}
      {tab === 'shipping' && <><ShippingZones onNotice={showNotice} /><h2>Shipping options</h2><SettingsForm group="shipping" onNotice={showNotice} /></>}
      {tab === 'checkout' && <><Gateways onNotice={showNotice} /><h2>Checkout options</h2><SettingsForm group="checkout" onNotice={showNotice} /></>}
      {tab === 'email' && <EmailsTab onNotice={showNotice} />}
      {!['tax', 'shipping', 'checkout', 'email'].includes(tab) && <SettingsForm key={tab} group={tab} onNotice={showNotice} />}
    </>
  );
}
