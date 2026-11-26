// Dashboard → Plugins: replacements for the WordPress plugins
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, custom, fetchAll, getToken, wc } from '../../api';
import { useNotice } from '../../hooks';
import { STATUS_LABELS, date, decodeHtml, fromLocalInput, toLocalInput } from '../../format';
import SettingsForm from '../../components/SettingsForm';
import JobProgress from '../../components/JobProgress';
import {
  Loading, Notice, PageHeader, Pagination, Postbox, TermChecklist,
} from '../../components/ui';

const P = (p) => custom(`admin/plugins/${p}`);

// ───────── Overview ─────────
const BADGE = { built: ['Built', 'completed'], planned: ['Planned', 'on-hold'], external: ['External service', 'processing'], not_needed: ['Not needed', 'cancelled'] };
export function PluginsOverview() {
  const [list, setList] = useState(null);
  useEffect(() => { api.get(P('overview')).then(setList).catch(() => setList([])); }, []);
  if (!list) return <Loading />;
  const counts = list.reduce((a, p) => ({ ...a, [p.status]: (a[p.status] || 0) + 1 }), {});
  return (
    <>
      <PageHeader title="Plugins" />
      <p className="muted">How each plugin from the WordPress site is handled. There are no plugins to install — features are built in and configured from the pages in this menu.</p>
      <ul className="subsubsub">{Object.entries(BADGE).map(([k, [l]]) => <li key={k}>{l} <span className="muted">({counts[k] || 0})</span></li>)}</ul>
      <table className="wp-list-table">
        <thead><tr><th>WordPress plugin</th><th>Status</th><th>Where / how</th></tr></thead>
        <tbody>{list.map((p) => (
          <tr key={p.name}><td><strong>{p.name}</strong></td><td><span className={`status status-${BADGE[p.status][1]}`}>{BADGE[p.status][0]}</span></td><td>{p.where}</td></tr>
        ))}</tbody>
      </table>
    </>
  );
}

// ───────── Order numbers ─────────
export function OrderNumbers() {
  const [notice, showNotice, closeNotice] = useNotice();
  const [st, setSt] = useState(null);
  const [counter, setCounter] = useState('');
  const load = () => api.get(P('ordernumbers')).then((s) => { setSt(s); setCounter(String(s.current)); }).catch((e) => showNotice('error', e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Order Numbers" />
      <p className="muted">Replaces <em>WooCommerce Basic Ordernumbers</em>. Existing (imported) order numbers never change; new orders get the next number.</p>
      <Notice notice={notice} onClose={closeNotice} />
      {st && (
        <div className="cards">
          <div className="card"><div className="label">Next order number</div><div className="value">{st.next_number}</div></div>
          <div className="card"><div className="label">Current counter ({st.counter_name})</div><div className="value">{st.current}</div></div>
        </div>
      )}
      <SettingsForm group="ordernumbers" onNotice={showNotice} onSaved={load} />
      {st && st.enabled && (
        <Postbox title="Set counter">
          <p className="muted">The next order uses counter + 1. On first use the counter continues after the highest existing order number.</p>
          <div className="flex"><input type="number" min={0} value={counter} onChange={(e) => setCounter(e.target.value)} />
            <button type="button" className="button" onClick={() => api.post(P('ordernumbers/counter'), { value: counter }).then((s) => { setSt(s); showNotice('success', 'Counter updated.'); }).catch((e) => showNotice('error', e.message))}>Set counter</button></div>
        </Postbox>
      )}
    </>
  );
}

// ───────── Storewide sale ─────────
export function StorewideSale() {
  const [notice, showNotice, closeNotice] = useNotice();
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState(null);
  const [job, setJob] = useState(null);
  const [cats, setCats] = useState([]);
  const load = () => Promise.all([api.get(wc('settings/storewide_sale')), api.get(P('storewide-sale'))]).then(([s, st]) => {
    setCfg(Object.fromEntries(s.map((x) => [x.id.replace('storewide_sale_', ''), x.value])));
    setStatus(st);
    if (st.job) setJob(st.job);
  }).catch((e) => showNotice('error', e.message));
  useEffect(() => { load(); fetchAll(wc('products/categories')).then(setCats).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cfg) return <><PageHeader title="Storewide Sale" /><Loading /></>;
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const save = async () => {
    const update = Object.entries(cfg).map(([k, value]) => ({ id: `storewide_sale_${k}`, value }));
    const r = await api.post(wc('settings/storewide_sale/batch'), { update });
    const errors = r.update.filter((x) => x.error);
    if (errors.length) throw new Error(errors.map((x) => x.error.message).join(', '));
  };
  const run = async (action) => {
    try {
      if (action === 'apply') await save();
      const j = await api.post(P(`storewide-sale/${action}`));
      setJob(j);
    } catch (e) { showNotice('error', e.message); }
  };
  const ids = (v) => (Array.isArray(v) ? v.map(Number) : []);
  const active = status && status.products_on_storewide_sale > 0;
  const running = job && job.status === 'running';
  return (
    <>
      <PageHeader title="Storewide Sale" />
      <p className="muted">Replaces <em>Storewide Sale</em>. Applying writes real sale prices (with your schedule) to every matching product and variation — prices, sorting, filters, feeds and the cart all stay consistent. "End sale" restores each product's own previous sale exactly.</p>
      <Notice notice={notice} onClose={closeNotice} />
      <div className={`notice ${active ? 'notice-success' : ''}`}><span>{active ? <>Storewide sale is <strong>active</strong> on {status.products_on_storewide_sale} products/variations{status.applied_at ? ` (applied ${date(status.applied_at, true)})` : ''}.</> : 'No storewide sale is running.'}</span></div>
      <div className="edit-layout">
        <div>
          <Postbox title="Sale settings">
            <table className="form-table"><tbody>
              <tr><th>Discount</th><td className="flex">
                <input type="number" min={0} step="0.01" value={cfg.amount} onChange={(e) => set({ amount: e.target.value })} style={{ width: 100 }} />
                <select value={cfg.discount_type} onChange={(e) => set({ discount_type: e.target.value })}><option value="percent">% off</option><option value="fixed">amount off</option></select></td></tr>
              <tr><th>Apply to</th><td>
                <select value={cfg.scope} onChange={(e) => set({ scope: e.target.value })}><option value="all">All products</option><option value="categories">Only these categories</option><option value="exclude_categories">All except these categories</option></select>
                {cfg.scope !== 'all' && <div className="mt"><TermChecklist terms={cats} value={ids(cfg.categories)} onChange={(v) => set({ categories: v })} /></div>}</td></tr>
              <tr><th>Exclude product IDs</th><td><input type="text" className="regular-text" value={ids(cfg.exclude_products).join(', ')} onChange={(e) => set({ exclude_products: e.target.value.split(',').map((x) => parseInt(x, 10)).filter(Boolean) })} placeholder="e.g. 123, 456" /></td></tr>
              <tr><th>Products already on sale</th><td><label className="inline"><input type="checkbox" checked={cfg.skip_on_sale !== 'no'} onChange={(e) => set({ skip_on_sale: e.target.checked ? 'yes' : 'no' })} /> Leave their own sale price unchanged</label></td></tr>
              <tr><th>Schedule</th><td className="flex">
                <label className="inline">Starts <input type="datetime-local" value={toLocalInput(cfg.start)} onChange={(e) => set({ start: e.target.value ? fromLocalInput(e.target.value) : '' })} /></label>
                <label className="inline">Ends <input type="datetime-local" value={toLocalInput(cfg.end)} onChange={(e) => set({ end: e.target.value ? fromLocalInput(e.target.value) : '' })} /></label>
                <p className="description">Leave empty to start now / run until you end it. Prices switch automatically at these times.</p></td></tr>
              <tr><th>Rounding</th><td><select value={cfg.rounding} onChange={(e) => set({ rounding: e.target.value })}><option value="none">No rounding</option><option value="whole">Whole number</option><option value="99">End in .99</option><option value="95">End in .95</option></select></td></tr>
            </tbody></table>
            <div className="flex">
              <button type="button" className="button button-primary" disabled={running} onClick={() => run('apply')}>{active ? 'Save & re-apply sale' : 'Save & apply sale'}</button>
              <button type="button" className="button" disabled={running} onClick={() => save().then(() => showNotice('success', 'Settings saved (not applied).')).catch((e) => showNotice('error', e.message))}>Save settings only</button>
              {active && <button type="button" className="button-link-delete" disabled={running} onClick={() => window.confirm('End the storewide sale and restore all original prices?') && run('remove')}>End sale</button>}
            </div>
          </Postbox>
        </div>
        <div>{job && <JobProgress job={job} onDone={(j) => { load(); showNotice(j.status === 'done' ? 'success' : 'error', j.status === 'done' ? 'Finished.' : j.error); }} />}</div>
      </div>
    </>
  );
}

// ───────── Auto SKU ─────────
export function AutoSku() {
  const [notice, showNotice, closeNotice] = useNotice();
  const [st, setSt] = useState(null);
  const [job, setJob] = useState(null);
  const load = () => api.get(P('auto-sku')).then((s) => { setSt(s); if (s.job) setJob(s.job); }).catch(() => {});
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Auto SKU" />
      <p className="muted">Replaces <em>Easy Auto SKU Generator</em>. When enabled, products/variations saved without a SKU get one automatically (always unique).</p>
      <Notice notice={notice} onClose={closeNotice} />
      <SettingsForm group="auto_sku" onNotice={showNotice} onSaved={load} />
      <Postbox title="Existing products">
        <p>{st ? `${st.missing} products/variations have no SKU.` : '…'}</p>
        <button type="button" className="button" disabled={!st || !st.missing || (job && job.status === 'running')}
          onClick={() => api.post(P('auto-sku/generate')).then(setJob).catch((e) => showNotice('error', e.message))}>Generate missing SKUs</button>
      </Postbox>
      {job && <JobProgress job={job} onDone={() => load()} />}
    </>
  );
}

// ───────── Email (SMTP) ─────────
export function Smtp() {
  const [notice, showNotice, closeNotice] = useNotice();
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true);
    try {
      const r = await api.post(P('smtp/test'), { to });
      showNotice(r.ok ? 'success' : 'error', r.message);
    } catch (e) { showNotice('error', e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Email (SMTP)"><Link to="/plugins/email-log">Email log</Link> · <Link to="/woo/settings/email">WooCommerce emails</Link></PageHeader>
      <p className="muted">Replaces <em>SMTP for AmazonSES – YaySMTP</em>. Emails are queued and sent in the background with automatic retries, so a slow mail server never slows checkout.</p>
      <Notice notice={notice} onClose={closeNotice} />
      <SettingsForm group="smtp" onNotice={showNotice} />
      <Postbox title="Send a test email">
        <div className="flex"><input type="email" className="regular-text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
          <button type="button" className="button" disabled={busy || !to} onClick={test}>{busy ? 'Sending…' : 'Send test'}</button></div>
        <p className="description">The "From" name and address are set in WooCommerce → Settings → Emails. With Amazon SES the From address (or its domain) must be verified in SES.</p>
      </Postbox>
    </>
  );
}

// ───────── Email log ─────────
export function EmailLog() {
  const [notice, showNotice, closeNotice] = useNotice();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState({ rows: [], total: 0, pages: 0, loading: true });
  const load = () => api.list(P('email-log'), { page, status, search }).then((r) => setData({ rows: r.data, total: r.total, pages: r.totalPages, loading: false })).catch((e) => showNotice('error', e.message));
  useEffect(() => { load(); }, [page, status, search]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Email log"><Link to="/plugins/smtp">SMTP settings</Link></PageHeader>
      <Notice notice={notice} onClose={closeNotice} />
      <div className="tablenav">
        <div className="actions">
          <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} aria-label="Status"><option value="">All statuses</option><option value="sent">Sent</option><option value="queued">Queued</option><option value="failed">Failed</option><option value="skipped">Logged only</option></select>
          <form className="flex" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(e.target.q.value); }}><input type="search" name="q" placeholder="Recipient starts with…" /><button type="submit" className="button">Search</button></form>
          <button type="button" className="button" onClick={load}>Refresh</button>
        </div>
        <Pagination page={page} total={data.total} totalPages={data.pages} onPage={setPage} />
      </div>
      <table className="wp-list-table">
        <thead><tr><th>Date</th><th>Email</th><th>To</th><th>Subject</th><th>Status</th><th /></tr></thead>
        <tbody>
          {data.loading && <tr className="empty"><td colSpan={6}><Loading /></td></tr>}
          {data.rows.map((r) => (
            <tr key={r.id}>
              <td>{date(r.createdAt, true)}</td>
              <td><code>{r.template}</code>{r.orderId && <div><Link to={`/orders/${r.orderId}`}>Order #{r.orderId}</Link></div>}</td>
              <td>{r.to}</td>
              <td>{r.subject || <span className="muted">—</span>}</td>
              <td><span className={`status status-${{ sent: 'completed', failed: 'failed', queued: 'pending', skipped: 'on-hold' }[r.status]}`}>{r.status === 'skipped' ? 'logged only' : r.status}</span>
                {r.error && <div className="muted" style={{ maxWidth: 320 }}>{r.error}</div>}{r.attempts > 1 && <div className="muted">{r.attempts} attempts</div>}</td>
              <td>{r.template !== 'test' && <button type="button" className="button button-small" onClick={() => api.post(P(`email-log/${r.id}/resend`)).then(() => { showNotice('success', 'Queued for sending.'); setTimeout(load, 1500); }).catch((e) => showNotice('error', e.message))}>Resend</button>}</td>
            </tr>
          ))}
          {!data.loading && !data.rows.length && <tr className="empty"><td colSpan={6}>No emails yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

// ───────── Order export ─────────
const ALL_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];
export function OrderExport() {
  const [notice, showNotice, closeNotice] = useNotice();
  const [cols, setCols] = useState(null);
  const [mode, setMode] = useState('orders');
  const [selected, setSelected] = useState({ orders: [], items: [] });
  const [statuses, setStatuses] = useState(['processing', 'completed', 'on-hold']);
  const today = new Date().toISOString().slice(0, 10);
  const [after, setAfter] = useState(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [before, setBefore] = useState(today);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(P('export/columns')).then((c) => { setCols(c); setSelected({ orders: c.orders.map((x) => x.key), items: c.items.map((x) => x.key) }); }).catch((e) => showNotice('error', e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cols) return <><PageHeader title="Order Export" /><Loading /></>;
  const toggle = (key) => setSelected((s) => ({ ...s, [mode]: s[mode].includes(key) ? s[mode].filter((k) => k !== key) : [...s[mode], key] }));
  const download = async () => {
    setBusy(true);
    try {
      const qs = new URLSearchParams({ mode, after, before, status: statuses.join(','), columns: selected[mode].join(',') });
      const res = await fetch(`/wp-json/${P('export/orders')}?${qs}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${mode}-export-${after}-to-${before}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { showNotice('error', e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Order Export" />
      <p className="muted">Replaces <em>Advanced Order Export For WooCommerce</em>. Exports CSV (opens in Excel/Google Sheets). Large exports are streamed, so any number of orders works.</p>
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout">
        <div>
          <Postbox title="Filter">
            <table className="form-table"><tbody>
              <tr><th>Order date</th><td className="flex"><input type="date" value={after} max={before} onChange={(e) => setAfter(e.target.value)} aria-label="From" /> to <input type="date" value={before} min={after} onChange={(e) => setBefore(e.target.value)} aria-label="To" /></td></tr>
              <tr><th>Statuses</th><td>{ALL_STATUSES.map((s) => <label key={s} className="inline"><input type="checkbox" checked={statuses.includes(s)} onChange={() => setStatuses(statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s])} /> {STATUS_LABELS[s]}</label>)}</td></tr>
              <tr><th>One row per</th><td><label className="inline"><input type="radio" checked={mode === 'orders'} onChange={() => setMode('orders')} /> Order</label><label className="inline"><input type="radio" checked={mode === 'items'} onChange={() => setMode('items')} /> Order item (product line)</label></td></tr>
            </tbody></table>
          </Postbox>
          <Postbox title="Columns" actions={<span className="flex"><a href="#" onClick={(e) => { e.preventDefault(); setSelected((s) => ({ ...s, [mode]: cols[mode].map((c) => c.key) })); }}>All</a><a href="#" onClick={(e) => { e.preventDefault(); setSelected((s) => ({ ...s, [mode]: [] })); }}>None</a></span>}>
            <div className="grid-3">{cols[mode].map((c) => <label key={c.key} className="inline"><input type="checkbox" checked={selected[mode].includes(c.key)} onChange={() => toggle(c.key)} /> {c.label}</label>)}</div>
          </Postbox>
        </div>
        <div>
          <Postbox title="Export">
            <button type="button" className="button button-primary" disabled={busy || !statuses.length || !selected[mode].length} onClick={download}>{busy ? 'Exporting…' : 'Export CSV'}</button>
          </Postbox>
        </div>
      </div>
    </>
  );
}

// ───────── WooCommerce → Settings → Emails (list + edit + preview) ─────────
export function EmailsTab({ onNotice }) {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const load = () => api.get(P('emails')).then(setList).catch((e) => onNotice('error', e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <Loading />;
  const save = async () => {
    try {
      await api.put(P(`emails/${editing.id}`), { enabled: editing.enabled, recipient: editing.recipient, subject: editing.subject, heading: editing.heading, additional_content: editing.additional_content });
      onNotice('success', `${editing.title} saved.`);
      setEditing(null);
      load();
    } catch (e) { onNotice('error', e.message); }
  };
  const showPreview = async (id) => {
    try { setPreview(await api.get(P(`emails/${id}/preview`))); } catch (e) { onNotice('error', e.message); }
  };
  if (editing) {
    return (
      <>
        <p><a href="#" onClick={(e) => { e.preventDefault(); setEditing(null); setPreview(null); }}>← Emails</a></p>
        <h2>{editing.title}</h2>
        <p className="muted">{editing.description}</p>
        <table className="form-table"><tbody>
          {!editing.manual && <tr><th>Enable/Disable</th><td><label className="inline"><input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> Enable this email notification</label></td></tr>}
          {!editing.is_customer_email && <tr><th>Recipient(s)</th><td><input type="text" className="regular-text" value={editing.recipient} onChange={(e) => setEditing({ ...editing, recipient: e.target.value })} /><p className="description">Comma-separated.</p></td></tr>}
          <tr><th>Subject</th><td><input type="text" className="large-text" value={editing.subject} placeholder={editing.default_subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /><p className="description">Placeholders: {'{site_title}'}, {'{order_number}'}, {'{order_date}'}</p></td></tr>
          <tr><th>Email heading</th><td><input type="text" className="large-text" value={editing.heading} placeholder={editing.default_heading} onChange={(e) => setEditing({ ...editing, heading: e.target.value })} /></td></tr>
          <tr><th>Additional content</th><td><textarea rows={4} className="large-text" value={editing.additional_content} onChange={(e) => setEditing({ ...editing, additional_content: e.target.value })} /></td></tr>
        </tbody></table>
        <div className="flex"><button type="button" className="button button-primary" onClick={save}>Save changes</button>
          <button type="button" className="button" onClick={() => showPreview(editing.id)}>Preview (saved version)</button></div>
        {preview && <iframe title="Email preview" srcDoc={preview} style={{ width: '100%', height: 700, border: '1px solid var(--border)', marginTop: 16, background: '#fff' }} sandbox="" />}
      </>
    );
  }
  return (
    <>
      <h2>Email notifications</h2>
      <p className="muted">Emails sent by the store. Sending is configured in <Link to="/plugins/smtp">Plugins → Email (SMTP)</Link>; every email is recorded in the <Link to="/plugins/email-log">Email log</Link>.</p>
      <table className="wp-list-table">
        <thead><tr><th>Email</th><th>Enabled</th><th>Recipient(s)</th><th /></tr></thead>
        <tbody>{list.map((e) => (
          <tr key={e.id}>
            <td><a href="#" className="row-title" onClick={(ev) => { ev.preventDefault(); setEditing(e); setPreview(null); }}>{e.title}</a><div className="muted">{e.description}</div></td>
            <td>{e.manual ? <span className="muted">Manually sent</span> : <input type="checkbox" checked={e.enabled} aria-label={`Enable ${e.title}`} onChange={(ev) => api.put(P(`emails/${e.id}`), { enabled: ev.target.checked }).then(load)} />}</td>
            <td>{e.is_customer_email ? 'Customer' : e.recipient}</td>
            <td><button type="button" className="button button-small" onClick={() => { setEditing(e); setPreview(null); }}>Manage</button></td>
          </tr>
        ))}</tbody>
      </table>
      <h2>Email sender options &amp; template</h2>
      <SettingsForm group="email" onNotice={onNotice} />
    </>
  );
}

// Order screen → "Order actions" (resend / send emails)
export const ORDER_EMAIL_ACTIONS = [
  ['customer_invoice', 'Email invoice / order details to customer'],
  ['new_order', 'Resend new order notification'],
  ['customer_processing_order', 'Resend processing order email'],
  ['customer_completed_order', 'Resend completed order email'],
];
export const sendOrderEmail = (orderId, email) => api.post(P('emails/send'), { order_id: orderId, email });
export { decodeHtml };
