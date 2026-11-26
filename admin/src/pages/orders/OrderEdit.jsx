import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, wc } from '../../api';
import { useNotice } from '../../hooks';
import { ORDER_EMAIL_ACTIONS, sendOrderEmail } from '../plugins/PluginPages';
import { STATUS_LABELS, date, decodeHtml, price } from '../../format';
import {
  Loading, Modal, Notice, PageHeader, Postbox, confirmDelete,
} from '../../components/ui';

const ADDR = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'postcode', 'country', 'state', 'email', 'phone'];
const emptyAddr = (withEmail) => Object.fromEntries(ADDR.filter((f) => withEmail || f !== 'email').map((f) => [f, '']));
const label = (f) => f.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).replace('Address 1', 'Address line 1').replace('Address 2', 'Address line 2');

function AddressBox({ title, value, onChange, editable, onCopy }) {
  const [edit, setEdit] = useState(false);
  const lines = [[value.first_name, value.last_name].filter(Boolean).join(' '), value.company, value.address_1, value.address_2, [value.city, value.state, value.postcode].filter(Boolean).join(' '), value.country].filter(Boolean);
  return (
    <div>
      <h3 className="flex" style={{ justifyContent: 'space-between' }}>{title}{editable && <a href="#" onClick={(e) => { e.preventDefault(); setEdit(!edit); }}>{edit ? 'Done' : 'Edit'}</a>}</h3>
      {edit ? (
        <>
          {onCopy && <p><a href="#" onClick={(e) => { e.preventDefault(); onCopy(); }}>Copy billing address</a></p>}
          <div className="grid-2">{Object.keys(value).filter((f) => ADDR.includes(f)).map((f) => (
            <div key={f} className="field"><label>{label(f)}</label><input type="text" value={value[f] || ''} onChange={(e) => onChange({ ...value, [f]: e.target.value })} /></div>
          ))}</div>
        </>
      ) : (
        <>
          {lines.length ? <p>{lines.map((l) => <span key={l}>{l}<br /></span>)}</p> : <p className="muted">No address set.</p>}
          {value.email && <p><strong>Email:</strong> <a href={`mailto:${value.email}`}>{value.email}</a></p>}
          {value.phone && <p><strong>Phone:</strong> <a href={`tel:${value.phone}`}>{value.phone}</a></p>}
        </>
      )}
    </div>
  );
}

function AddProductModal({ onAdd, onClose }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [variations, setVariations] = useState(null);
  const [qty, setQty] = useState(1);
  useEffect(() => {
    if (term.length < 2) { setResults([]); return undefined; }
    const t = setTimeout(() => api.get(wc('products'), { search: term, per_page: 15 }).then(setResults).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [term]);
  const pick = (p) => {
    if (p.type === 'variable') api.get(wc(`products/${p.id}/variations`), { per_page: 100 }).then((v) => setVariations({ parent: p, list: v }));
    else onAdd({ product_id: p.id, quantity: qty, name: p.name, price: p.price });
  };
  return (
    <Modal title="Add products" onClose={onClose} width={620}>
      <div className="flex mb"><input type="search" autoFocus value={term} onChange={(e) => { setTerm(e.target.value); setVariations(null); }} placeholder="Search for a product…" style={{ flex: 1 }} />
        <label className="inline">Qty <input type="number" min={1} className="small-text" value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} /></label></div>
      {variations ? (
        <>
          <p><a href="#" onClick={(e) => { e.preventDefault(); setVariations(null); }}>← back</a> <strong>{decodeHtml(variations.parent.name)}</strong></p>
          <ul style={{ listStyle: 'none', padding: 0 }}>{variations.list.map((v) => (
            <li key={v.id}><a href="#" onClick={(e) => { e.preventDefault(); onAdd({ product_id: variations.parent.id, variation_id: v.id, quantity: qty, name: v.name }); }}>
              {v.attributes.map((a) => `${a.name}: ${a.option || 'any'}`).join(', ')} — {price(v.price)} {v.stock_status === 'outofstock' && <span className="stock-out">(out of stock)</span>}</a></li>
          ))}</ul>
        </>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>{results.map((p) => (
          <li key={p.id} style={{ padding: '4px 0' }}><a href="#" onClick={(e) => { e.preventDefault(); pick(p); }}>{decodeHtml(p.name)}</a> <span className="muted">{p.sku && `(${p.sku}) `}{p.type === 'variable' ? 'choose variation →' : price(p.price)}</span></li>
        ))}</ul>
      )}
    </Modal>
  );
}

export default function OrderEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [o, setO] = useState(null);
  const [notes, setNotes] = useState([]);
  const [noteText, setNoteText] = useState('');
  const [noteType, setNoteType] = useState('private');
  const [pending, setPending] = useState({ line_items: [], shipping_lines: [], fee_lines: [], coupon_lines: [] });
  const [addProduct, setAddProduct] = useState(false);
  const [refund, setRefund] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [gateways, setGateways] = useState([]);
  const [saving, setSaving] = useState(false);
  const [notice, showNotice, closeNotice] = useNotice();

  const load = () => {
    if (isNew) {
      setO({ status: 'pending', billing: emptyAddr(true), shipping: emptyAddr(false), customer_id: 0, line_items: [], shipping_lines: [], fee_lines: [], coupon_lines: [], tax_lines: [], refunds: [], payment_method: '', payment_method_title: '', transaction_id: '', customer_note: '' });
      return;
    }
    api.get(wc(`orders/${id}`)).then(setO).catch((e) => showNotice('error', e.message));
    api.get(wc(`orders/${id}/notes`)).then(setNotes).catch(() => {});
  };
  useEffect(() => { load(); api.get(wc('payment_gateways')).then(setGateways).catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (customerSearch.length < 2) { setCustomers([]); return undefined; }
    const t = setTimeout(() => api.get(wc('customers'), { search: customerSearch, per_page: 10, role: 'all' }).then(setCustomers).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);

  if (!o) return <><Notice notice={notice} onClose={closeNotice} /><Loading /></>;
  const set = (patch) => setO((x) => ({ ...x, ...patch }));
  const editable = isNew || o.is_editable;
  const hasPending = Object.values(pending).some((l) => l.length);

  const save = async (extra = {}) => {
    setSaving(true);
    try {
      const body = {
        status: o.status, billing: o.billing, shipping: o.shipping, customer_id: o.customer_id || 0, customer_note: o.customer_note,
        payment_method: o.payment_method, payment_method_title: o.payment_method_title || (gateways.find((g) => g.id === o.payment_method) || {}).title || '',
        transaction_id: o.transaction_id, ...extra,
      };
      for (const k of Object.keys(pending)) if (pending[k].length) body[k] = pending[k];
      const saved = isNew ? await api.post(wc('orders'), { ...body, status: undefined, ...(o.status !== 'pending' ? { status: o.status } : {}) }) : await api.put(wc(`orders/${id}`), body);
      setPending({ line_items: [], shipping_lines: [], fee_lines: [], coupon_lines: [] });
      showNotice('success', isNew ? 'Order created.' : 'Order updated.');
      if (isNew) navigate(`/orders/${saved.id}`, { replace: true }); else { setO(saved); api.get(wc(`orders/${id}/notes`)).then(setNotes).catch(() => {}); }
    } catch (e) { showNotice('error', e.message); } finally { setSaving(false); }
  };

  // Item changes are queued and sent with the next save (server recalculates totals)
  const queue = (key, item) => setPending((p) => ({ ...p, [key]: [...p[key], item] }));
  const removeLine = (key, line) => {
    const removeField = { line_items: { quantity: 0 }, shipping_lines: { method_id: null }, fee_lines: { name: null }, coupon_lines: { code: null } }[key];
    queue(key, { id: line.id, ...removeField });
    set({ [key]: o[key].filter((l) => l.id !== line.id) });
  };
  const addNote = async () => {
    if (!noteText.trim()) return;
    try {
      await api.post(wc(`orders/${id}/notes`), { note: noteText, customer_note: noteType === 'customer', added_by_user: true });
      setNoteText('');
      setNotes(await api.get(wc(`orders/${id}/notes`)));
    } catch (e) { showNotice('error', e.message); }
  };
  const doRefund = async () => {
    try {
      await api.post(wc(`orders/${id}/refunds`), { amount: String(refund.amount), reason: refund.reason, api_restock: refund.restock, line_items: refund.restock ? o.line_items.filter((l) => refund.qty[l.id] > 0).map((l) => ({ id: l.id, quantity: refund.qty[l.id] })) : [] });
      setRefund(null);
      showNotice('success', 'Refund recorded.');
      load();
    } catch (e) { showNotice('error', e.message); }
  };

  const refunded = (o.refunds || []).reduce((n, r) => n + Math.abs(Number(r.total)), 0);
  const subtotal = o.line_items.reduce((n, l) => n + Number(l.subtotal), 0);

  return (
    <>
      <PageHeader title={isNew ? 'Add new order' : `Order #${o.number}`} action="Add order" actionTo="/orders/new" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout">
        <div>
          <Postbox>
            {!isNew && <p className="muted" style={{ marginTop: 0 }}>Payment via {o.payment_method_title || o.payment_method || '—'}{o.transaction_id && ` (${o.transaction_id})`}{o.date_paid && `. Paid on ${date(o.date_paid, true)}`}. Customer IP: {o.customer_ip_address || '—'}</p>}
            <div className="grid-3">
              <div>
                <h3>General</h3>
                {!isNew && <div className="field"><label>Date created</label><span>{date(o.date_created, true)}</span></div>}
                <div className="field"><label>Status</label>
                  <select value={o.status} onChange={(e) => set({ status: e.target.value })}>{Object.entries(STATUS_LABELS).filter(([k]) => !['trash', 'checkout-draft'].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div className="field"><label>Customer</label>
                  {o.customer_id ? <p className="flex">#{o.customer_id} <Link to={`/customers/${o.customer_id}`}>Profile</Link> <Link to={`/orders?customer=${o.customer_id}`}>View other orders</Link> <a href="#" onClick={(e) => { e.preventDefault(); set({ customer_id: 0 }); }}>Change</a></p> : (
                    <div style={{ position: 'relative' }}>
                      <input type="search" value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} placeholder="Guest — search customers" />
                      {customers.length > 0 && <ul className="postbox" style={{ position: 'absolute', zIndex: 5, margin: 0, padding: 0, listStyle: 'none', width: '100%' }}>
                        {customers.map((c) => <li key={c.id}><a href="#" style={{ display: 'block', padding: '6px 10px' }} onClick={(e) => {
                          e.preventDefault();
                          set({ customer_id: c.id, billing: { ...o.billing, ...Object.fromEntries(Object.entries(c.billing).filter(([, v]) => v)) }, shipping: { ...o.shipping, ...Object.fromEntries(Object.entries(c.shipping).filter(([, v]) => v)) } });
                          setCustomers([]); setCustomerSearch('');
                        }}>{c.first_name} {c.last_name} ({c.email})</a></li>)}
                      </ul>}
                    </div>
                  )}
                </div>
              </div>
              <AddressBox title="Billing" value={{ ...emptyAddr(true), ...o.billing }} onChange={(billing) => set({ billing })} editable />
              <AddressBox title="Shipping" value={{ ...emptyAddr(false), ...o.shipping }} onChange={(shipping) => set({ shipping })} editable onCopy={() => { const { email, ...rest } = o.billing; set({ shipping: { ...o.shipping, ...rest } }); }} />
            </div>
            <div className="grid-2">
              <div className="field"><label>Payment method</label>
                <select value={o.payment_method} onChange={(e) => set({ payment_method: e.target.value, payment_method_title: (gateways.find((g) => g.id === e.target.value) || {}).title || e.target.value })}>
                  <option value="">N/A</option>{gateways.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                  {o.payment_method && !gateways.some((g) => g.id === o.payment_method) && <option value={o.payment_method}>{o.payment_method_title || o.payment_method}</option>}
                  <option value="other">Other</option>
                </select></div>
              <div className="field"><label>Transaction ID</label><input type="text" value={o.transaction_id} onChange={(e) => set({ transaction_id: e.target.value })} /></div>
            </div>
            <div className="field"><label>Customer provided note</label><textarea rows={2} value={o.customer_note} onChange={(e) => set({ customer_note: e.target.value })} /></div>
          </Postbox>

          <Postbox title="Items">
            <table className="order-items">
              <thead><tr><th>Item</th><th className="right">Cost</th><th className="right">Qty</th><th className="right">Total</th><th className="right">Tax</th>{editable && <th />}</tr></thead>
              <tbody>
                {o.line_items.map((l) => (
                  <tr key={l.id}>
                    <td className="flex">{l.image && l.image.src && <img src={l.image.src} alt="" width={36} height={36} style={{ objectFit: 'cover' }} />}
                      <div><Link to={`/products/${l.product_id}`}>{decodeHtml(l.name)}</Link>{l.sku && <div className="muted">SKU: {l.sku}</div>}
                        {l.meta_data.map((m) => <div key={m.id} className="muted">{m.display_key || m.key}: {String(m.display_value ?? m.value)}</div>)}</div></td>
                    <td className="right">{price(l.price)}</td>
                    <td className="right">× {l.quantity}</td>
                    <td className="right">{price(l.total)}{Number(l.subtotal) !== Number(l.total) && <div className="muted"><del>{price(l.subtotal)}</del></div>}</td>
                    <td className="right">{price(l.total_tax)}</td>
                    {editable && <td><button type="button" className="button-link-delete" onClick={() => removeLine('line_items', l)} aria-label="Remove item">×</button></td>}
                  </tr>
                ))}
                {pending.line_items.filter((l) => !l.id).map((l, i) => <tr key={`new-${i}`}><td><em>{decodeHtml(l.name)} (new)</em></td><td /><td className="right">× {l.quantity}</td><td colSpan={3} className="muted">calculated on save</td></tr>)}
                {o.fee_lines.map((f) => <tr key={f.id}><td>Fee: {f.name}</td><td /><td /><td className="right">{price(f.total)}</td><td className="right">{price(f.total_tax)}</td>{editable && <td><button type="button" className="button-link-delete" onClick={() => removeLine('fee_lines', f)} aria-label="Remove fee">×</button></td>}</tr>)}
                {pending.fee_lines.filter((f) => !f.id).map((f, i) => <tr key={`nf-${i}`}><td><em>Fee: {f.name} (new)</em></td><td /><td /><td className="right">{price(f.total)}</td><td colSpan={2} /></tr>)}
                {o.shipping_lines.map((s) => <tr key={s.id}><td>Shipping: {s.method_title}</td><td /><td /><td className="right">{price(s.total)}</td><td className="right">{price(s.total_tax)}</td>{editable && <td><button type="button" className="button-link-delete" onClick={() => removeLine('shipping_lines', s)} aria-label="Remove shipping">×</button></td>}</tr>)}
                {pending.shipping_lines.filter((s) => !s.id).map((s, i) => <tr key={`ns-${i}`}><td><em>Shipping: {s.method_title} (new)</em></td><td /><td /><td className="right">{price(s.total)}</td><td colSpan={2} /></tr>)}
              </tbody>
            </table>
            {(o.coupon_lines.length > 0 || pending.coupon_lines.some((c) => c.code)) && (
              <p>Coupon(s): {o.coupon_lines.map((c) => <span key={c.id} className="tag-chip">{c.code} (−{price(c.discount)}){editable && <button type="button" onClick={() => removeLine('coupon_lines', c)} aria-label="Remove coupon">×</button>}</span>)}
                {pending.coupon_lines.filter((c) => !c.id && c.code).map((c) => <span key={c.code} className="tag-chip">{c.code} (new)</span>)}</p>
            )}
            {editable && (
              <div className="flex mt">
                <button type="button" className="button" onClick={() => setAddProduct(true)}>Add product(s)</button>
                <button type="button" className="button" onClick={() => { const code = window.prompt('Enter a coupon code to apply'); if (code) queue('coupon_lines', { code: code.trim() }); }}>Apply coupon</button>
                <button type="button" className="button" onClick={() => { const name = window.prompt('Fee name', 'Fee'); if (!name) return; const total = window.prompt('Fee amount (negative for discount)', '0'); if (total !== null) queue('fee_lines', { name, total: String(Number(total) || 0) }); }}>Add fee</button>
                <button type="button" className="button" onClick={() => { const t = window.prompt('Shipping method name', 'Flat rate'); if (!t) return; const total = window.prompt('Shipping cost', '0'); if (total !== null) queue('shipping_lines', { method_id: 'flat_rate', method_title: t, total: String(Number(total) || 0) }); }}>Add shipping</button>
                {hasPending && <button type="button" className="button button-primary" disabled={saving} onClick={() => save()}>Save &amp; recalculate</button>}
              </div>
            )}
            {!isNew && (
              <table className="order-totals mt">
                <tbody>
                  <tr><td>Items subtotal:</td><td>{price(subtotal)}</td></tr>
                  {Number(o.discount_total) > 0 && <tr><td>Coupon(s):</td><td>−{price(o.discount_total)}</td></tr>}
                  {o.fee_lines.length > 0 && <tr><td>Fees:</td><td>{price(o.fee_lines.reduce((n, f) => n + Number(f.total), 0))}</td></tr>}
                  {Number(o.shipping_total) > 0 && <tr><td>Shipping:</td><td>{price(o.shipping_total)}</td></tr>}
                  {o.tax_lines.map((t) => <tr key={t.id}><td>{t.label}:</td><td>{price(Number(t.tax_total) + Number(t.shipping_tax_total))}</td></tr>)}
                  <tr><td><strong>Order total:</strong></td><td><strong>{price(o.total)}</strong></td></tr>
                  {refunded > 0 && <><tr><td style={{ color: 'var(--danger)' }}>Refunded:</td><td style={{ color: 'var(--danger)' }}>−{price(refunded)}</td></tr><tr><td><strong>Net payment:</strong></td><td><strong>{price(Number(o.total) - refunded)}</strong></td></tr></>}
                </tbody>
              </table>
            )}
            {!isNew && Number(o.total) - refunded > 0 && ['processing', 'completed', 'on-hold'].includes(o.status) && (
              <p className="right"><button type="button" className="button" onClick={() => setRefund({ amount: '', reason: '', restock: true, qty: {} })}>Refund</button></p>
            )}
          </Postbox>
        </div>

        <div>
          <Postbox title="Order actions">
            <div className="flex" style={{ justifyContent: 'space-between' }}>
              {!isNew && <button type="button" className="button-link-delete" onClick={() => confirmDelete(`order #${o.number}`) && api.del(wc(`orders/${id}`), { force: true }).then(() => navigate('/orders')).catch((e) => showNotice('error', e.message))}>Delete permanently</button>}
              <button type="button" className="button button-primary" disabled={saving} onClick={() => save()}>{saving ? 'Saving…' : isNew ? 'Create' : 'Update'}</button>
            </div>
            {!isNew && (
              <div className="flex mt">
                <select defaultValue="" aria-label="Order action" id="order-action" style={{ flex: 1 }}>
                  <option value="">Choose an action…</option>
                  {ORDER_EMAIL_ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <button type="button" className="button" onClick={() => {
                  const sel = document.getElementById('order-action');
                  if (!sel.value) return;
                  sendOrderEmail(o.id, sel.value).then(() => { showNotice('success', 'Email queued. See Plugins → Email Log.'); sel.value = ''; api.get(wc(`orders/${id}/notes`)).then(setNotes).catch(() => {}); }).catch((e) => showNotice('error', e.message));
                }}>Apply</button>
              </div>
            )}
            {!isNew && ['pending', 'failed', 'on-hold'].includes(o.status) && (
              <p className="mt"><button type="button" className="button" disabled={saving} onClick={() => save({ set_paid: true })}>Mark as paid</button></p>
            )}
          </Postbox>
          {!isNew && (
            <Postbox title="Order notes">
              {notes.map((n) => (
                <div key={n.id}>
                  <div className={`note ${n.customer_note ? 'customer-note' : n.author === 'system' ? 'system-note' : ''}`} dangerouslySetInnerHTML={{ __html: n.note }} />
                  <div className="note-meta">{date(n.date_created, true)} by {n.author}{' '}
                    <button type="button" className="button-link-delete" onClick={() => api.del(wc(`orders/${id}/notes/${n.id}`), { force: true }).then(() => setNotes(notes.filter((x) => x.id !== n.id)))}>Delete note</button></div>
                </div>
              ))}
              {!notes.length && <p className="muted">There are no notes yet.</p>}
              <div className="field mt"><label>Add note</label><textarea rows={3} value={noteText} onChange={(e) => setNoteText(e.target.value)} /></div>
              <div className="flex"><select value={noteType} onChange={(e) => setNoteType(e.target.value)} aria-label="Note type"><option value="private">Private note</option><option value="customer">Note to customer</option></select>
                <button type="button" className="button" onClick={addNote}>Add</button></div>
            </Postbox>
          )}
        </div>
      </div>

      {addProduct && <AddProductModal onClose={() => setAddProduct(false)} onAdd={(item) => { queue('line_items', item); setAddProduct(false); }} />}
      {refund && (
        <Modal title="Refund" onClose={() => setRefund(null)} width={560}
          footer={<><button type="button" className="button" onClick={() => setRefund(null)}>Cancel</button><button type="button" className="button button-primary" disabled={!(Number(refund.amount) > 0)} onClick={doRefund}>Refund {price(refund.amount || 0)} manually</button></>}>
          <p className="muted">Records a refund. Money must be returned through your payment provider (no gateway refunds yet).</p>
          <table className="order-items mb"><thead><tr><th>Item</th><th className="right">Qty to restock</th></tr></thead>
            <tbody>{o.line_items.map((l) => <tr key={l.id}><td>{decodeHtml(l.name)} × {l.quantity}</td><td className="right"><input type="number" min={0} max={l.quantity} className="small-text" value={refund.qty[l.id] || 0}
              onChange={(e) => {
                const qty = { ...refund.qty, [l.id]: Math.min(l.quantity, Math.max(0, Number(e.target.value))) };
                const amount = o.line_items.reduce((n, x) => n + (qty[x.id] || 0) * ((Number(x.total) + Number(x.total_tax)) / x.quantity), 0);
                setRefund({ ...refund, qty, amount: amount.toFixed(2) });
              }} /></td></tr>)}</tbody></table>
          <div className="field"><label>Refund amount (max {price(Number(o.total) - refunded)})</label><input type="number" step="0.01" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} /></div>
          <div className="field"><label>Reason (optional)</label><input type="text" value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} /></div>
          <label className="inline"><input type="checkbox" checked={refund.restock} onChange={(e) => setRefund({ ...refund, restock: e.target.checked })} /> Restock refunded items</label>
        </Modal>
      )}
    </>
  );
}
