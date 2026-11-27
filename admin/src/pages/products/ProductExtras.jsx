// Extra product edit boxes matching the WordPress plugins on the site:
// Yoast SEO, Meta for WooCommerce, Product Add-ons, Reviews, Brands
import { useEffect, useState } from 'react';
import { api, wc } from '../../api';
import { decodeHtml, date } from '../../format';
import { ImageField } from '../../components/media';
import { Postbox, TermChecklist, confirmDelete } from '../../components/ui';

const Row = ({ label, children, tip }) => (
  <div className="options-row"><label>{label}</label><div>{children}{tip && <p className="description">{tip}</p>}</div></div>
);
const stripTags = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ── Yoast SEO ──
const lengthColor = (n, good, max) => (n === 0 ? '#c3c4c7' : n > max ? '#d63638' : n >= good ? '#00a32a' : '#dba617');
function Meter({ n, good, max }) {
  return <div style={{ height: 4, background: '#f0f0f1', marginTop: 4 }}><div style={{ height: 4, width: `${Math.min(100, (n / max) * 100)}%`, background: lengthColor(n, good, max) }} /></div>;
}

export function SeoBox({ seo, onChange, name, slug, onSlug, excerpt, permalink, siteName = '' }) {
  const s = seo || {};
  const set = (patch) => onChange({ ...s, ...patch });
  const [tab, setTab] = useState('seo');
  const [advanced, setAdvanced] = useState(false);
  const resolve = (t) => String(t || '').replace(/%%title%%/g, name || '').replace(/%%sitename%%/g, siteName).replace(/%%sep%%/g, '-').replace(/%%page%%/g, '').replace(/%%[a-z_]+%%/g, '').trim();
  const title = resolve(s.title) || `${name || ''}${siteName ? ` - ${siteName}` : ''}`;
  const desc = s.description || stripTags(excerpt).slice(0, 156);
  const url = permalink ? permalink.replace(/[^/]+\/?$/, `${slug || ''}/`) : slug;
  const kw = (s.focus_keyphrase || '').toLowerCase().trim();
  const checks = kw ? [
    ['Keyphrase in SEO title', title.toLowerCase().includes(kw)],
    ['Keyphrase in meta description', (s.description || '').toLowerCase().includes(kw)],
    ['Keyphrase in slug', (slug || '').toLowerCase().includes(kw.replace(/\s+/g, '-'))],
    ['Keyphrase in introduction', stripTags(excerpt).toLowerCase().slice(0, 300).includes(kw)],
    ['Meta description length', (s.description || '').length >= 120 && (s.description || '').length <= 156],
    ['SEO title width', title.length >= 40 && title.length <= 60],
  ] : [];

  return (
    <Postbox title="Yoast SEO">
      <div className="flex mb">
        {[['seo', 'SEO'], ['social', 'Social']].map(([k, l]) => <button key={k} type="button" className={`button${tab === k ? ' button-primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'seo' && <>
        <Row label="Focus keyphrase"><input type="text" value={s.focus_keyphrase || ''} onChange={(e) => set({ focus_keyphrase: e.target.value })} style={{ width: '100%' }} /></Row>
        <div className="options-row"><label>Google preview</label>
          <div style={{ border: '1px solid #dcdcde', borderRadius: 8, padding: 12, maxWidth: 600, fontFamily: 'arial, sans-serif' }}>
            <div style={{ fontSize: 12, color: '#4d5156', wordBreak: 'break-all' }}>{url}</div>
            <div style={{ fontSize: 18, color: '#1a0dab', margin: '2px 0' }}>{title.length > 60 ? `${title.slice(0, 60)}…` : title}</div>
            <div style={{ fontSize: 13, color: '#4d5156' }}>{desc ? (desc.length > 156 ? `${desc.slice(0, 156)} …` : desc) : <span className="muted">Please provide a meta description by editing the snippet below.</span>}</div>
          </div>
        </div>
        <Row label="SEO title" tip="Variables: %%title%% %%sep%% %%sitename%%">
          <input type="text" value={s.title || ''} placeholder="%%title%% %%sep%% %%sitename%%" onChange={(e) => set({ title: e.target.value })} style={{ width: '100%' }} />
          <Meter n={title.length} good={40} max={60} />
        </Row>
        <Row label="Slug"><input type="text" value={slug || ''} onChange={(e) => onSlug(e.target.value)} style={{ width: '100%' }} /></Row>
        <Row label="Meta description">
          <textarea rows={3} value={s.description || ''} onChange={(e) => set({ description: e.target.value })} style={{ width: '100%' }} />
          <Meter n={(s.description || '').length} good={120} max={156} />
        </Row>
        {checks.length > 0 && (
          <Row label="SEO analysis">
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
              {checks.map(([l, ok]) => <li key={l}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: ok ? '#00a32a' : '#d63638', marginRight: 6 }} />{l}</li>)}
            </ul>
          </Row>
        )}
        <Row label="Cornerstone content"><label className="inline"><input type="checkbox" checked={!!s.cornerstone} onChange={(e) => set({ cornerstone: e.target.checked })} /> Mark as cornerstone content</label></Row>
        <p><a href="#" onClick={(e) => { e.preventDefault(); setAdvanced(!advanced); }}>{advanced ? '▾' : '▸'} Advanced</a></p>
        {advanced && <>
          <Row label="Allow search engines to show this in search results?">
            <select value={s.noindex || ''} onChange={(e) => set({ noindex: e.target.value })}>
              <option value="">Default for this content type</option><option value="2">Yes</option><option value="1">No</option>
            </select>
          </Row>
          <Row label="Should search engines follow links?"><label className="inline"><input type="radio" checked={s.nofollow !== '1'} onChange={() => set({ nofollow: '' })} /> Yes</label> <label className="inline"><input type="radio" checked={s.nofollow === '1'} onChange={() => set({ nofollow: '1' })} /> No</label></Row>
          <Row label="Breadcrumbs title"><input type="text" value={s.breadcrumb_title || ''} onChange={(e) => set({ breadcrumb_title: e.target.value })} style={{ width: '100%' }} /></Row>
          <Row label="Canonical URL"><input type="url" value={s.canonical || ''} onChange={(e) => set({ canonical: e.target.value })} style={{ width: '100%' }} /></Row>
        </>}
      </>}
      {tab === 'social' && <>
        <h4>Facebook / Open Graph</h4>
        <Row label="Social image"><input type="url" value={s.og_image || ''} placeholder="Image URL" onChange={(e) => set({ og_image: e.target.value })} style={{ width: '100%' }} /></Row>
        <Row label="Social title"><input type="text" value={s.og_title || ''} placeholder={title} onChange={(e) => set({ og_title: e.target.value })} style={{ width: '100%' }} /></Row>
        <Row label="Social description"><textarea rows={2} value={s.og_description || ''} placeholder={desc} onChange={(e) => set({ og_description: e.target.value })} style={{ width: '100%' }} /></Row>
        <h4>X (Twitter)</h4>
        <Row label="X image"><input type="url" value={s.twitter_image || ''} placeholder="Image URL" onChange={(e) => set({ twitter_image: e.target.value })} style={{ width: '100%' }} /></Row>
        <Row label="X title"><input type="text" value={s.twitter_title || ''} placeholder={title} onChange={(e) => set({ twitter_title: e.target.value })} style={{ width: '100%' }} /></Row>
        <Row label="X description"><textarea rows={2} value={s.twitter_description || ''} placeholder={desc} onChange={(e) => set({ twitter_description: e.target.value })} style={{ width: '100%' }} /></Row>
      </>}
    </Postbox>
  );
}

// ── Meta for WooCommerce (Facebook tab in Product data) ──
export function FacebookPanel({ value, onChange, price }) {
  const f = value || { sync: true, visibility: true };
  const set = (patch) => onChange({ ...f, ...patch });
  return <>
    <Row label="Facebook sync"><select value={f.sync === false ? 'no' : 'yes'} onChange={(e) => set({ sync: e.target.value === 'yes' })}><option value="yes">Sync and show in catalog</option><option value="no">Do not sync</option></select></Row>
    {f.sync !== false && <>
      <Row label="Visibility"><select value={f.visibility === false ? 'no' : 'yes'} onChange={(e) => set({ visibility: e.target.value === 'yes' })}><option value="yes">Show in catalog</option><option value="no">Hide in catalog</option></select></Row>
      <Row label="Facebook description" tip="Custom (plain-text only) description for the product on Facebook. Leave blank to use the product description.">
        <textarea rows={3} value={f.description || ''} onChange={(e) => set({ description: e.target.value })} style={{ width: '100%' }} />
      </Row>
      <Row label="Facebook product image" tip="Leave blank to use the product image."><input type="url" value={f.image || ''} placeholder="Image URL" onChange={(e) => set({ image: e.target.value })} style={{ width: '100%' }} /></Row>
      <Row label="Facebook price" tip="Custom price for the product on Facebook. Leave blank to use the product price."><input type="text" inputMode="decimal" value={f.price || ''} placeholder={price || ''} onChange={(e) => set({ price: e.target.value })} /></Row>
      <Row label="Google product category" tip="Google product taxonomy ID or path, e.g. 525 or Health & Beauty > Health Care > Fitness & Nutrition > Vitamins & Supplements.">
        <input type="text" value={f.google_product_category || ''} onChange={(e) => set({ google_product_category: e.target.value })} style={{ width: '100%' }} />
      </Row>
    </>}
  </>;
}

// ── WooCommerce Product Add-ons ──
const ADDON_TYPES = [['multiple_choice', 'Multiple Choice'], ['checkbox', 'Checkboxes'], ['custom_text', 'Short Text'], ['custom_textarea', 'Long Text'], ['file_upload', 'File Upload'], ['custom_price', 'Customer-defined Price'], ['input_multiplier', 'Quantity'], ['heading', 'Heading'], ['datepicker', 'Date Picker']];
const PRICE_TYPES = [['flat_fee', 'Flat Fee'], ['quantity_based', 'Quantity Based'], ['percentage_based', 'Percentage Based']];
const newAddon = () => ({ name: '', title_format: 'label', description_enable: false, description: '', type: 'multiple_choice', display: 'select', required: false, restrictions: false, min: '', max: '', adjust_price: false, price_type: 'flat_fee', price: '', options: [{ label: '', price: '', image: '', price_type: 'flat_fee' }] });

export function AddonsPanel({ addons, excludeGlobal, onChange }) {
  const list = addons || [];
  const [open, setOpen] = useState(null);
  const setAll = (next) => onChange({ addons: next });
  const setA = (i, patch) => setAll(list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const move = (i, d) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setAll(n); };
  const hasOptions = (t) => ['multiple_choice', 'checkbox'].includes(t);
  return <>
    <div className="flex mb">
      <button type="button" className="button" onClick={() => { setAll([...list, newAddon()]); setOpen(list.length); }}>Add Field</button>
      <label className="inline" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={!!excludeGlobal} onChange={(e) => onChange({ exclude_global_addons: e.target.checked })} /> Exclude add-ons — use this option to exclude all global add-ons for this product</label>
    </div>
    {!list.length && <p className="muted">No add-ons for this product yet.</p>}
    {list.map((a, i) => (
      <div key={i} className="variation">
        <div className="variation-head" onClick={() => setOpen(open === i ? null : i)}>
          <strong>{a.name || '(untitled)'}</strong> <span className="muted">{(ADDON_TYPES.find((t) => t[0] === a.type) || [, a.type])[1]}{a.required ? ' · required' : ''}</span>
          <span style={{ marginLeft: 'auto' }} className="flex">
            <button type="button" className="button-link" disabled={i === 0} onClick={(e) => { e.stopPropagation(); move(i, -1); }} aria-label="Move up">↑</button>
            <button type="button" className="button-link" disabled={i === list.length - 1} onClick={(e) => { e.stopPropagation(); move(i, 1); }} aria-label="Move down">↓</button>
            <button type="button" className="button-link-delete" onClick={(e) => { e.stopPropagation(); if (confirmDelete('this add-on')) setAll(list.filter((_, j) => j !== i)); }}>Remove</button>
          </span>
        </div>
        {open === i && (
          <div className="variation-body">
            <div className="grid-2">
              <div className="field"><label>Type</label><select value={a.type} onChange={(e) => setA(i, { type: e.target.value })}>{ADDON_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              {a.type === 'multiple_choice' && <div className="field"><label>Display as</label><select value={a.display} onChange={(e) => setA(i, { display: e.target.value })}><option value="select">Dropdown</option><option value="radiobutton">Radio Buttons</option><option value="images">Images</option></select></div>}
              <div className="field"><label>Title</label><input type="text" value={a.name} onChange={(e) => setA(i, { name: e.target.value })} /></div>
              <div className="field"><label>Format title</label><select value={a.title_format} onChange={(e) => setA(i, { title_format: e.target.value })}><option value="label">Label</option><option value="heading">Heading</option><option value="hide">Hide</option></select></div>
            </div>
            <label className="inline"><input type="checkbox" checked={a.description_enable} onChange={(e) => setA(i, { description_enable: e.target.checked })} /> Add description</label>
            {a.description_enable && <textarea rows={2} value={a.description} onChange={(e) => setA(i, { description: e.target.value })} style={{ width: '100%' }} />}
            {a.type !== 'heading' && <label className="inline"><input type="checkbox" checked={a.required} onChange={(e) => setA(i, { required: e.target.checked })} /> Required field</label>}
            {hasOptions(a.type) ? (
              <table className="widefat mt">
                <thead><tr><th>Option</th><th>Price type</th><th>Price</th>{a.display === 'images' && <th>Image</th>}<th /></tr></thead>
                <tbody>
                  {a.options.map((o, k) => {
                    const setO = (patch) => setA(i, { options: a.options.map((x, j) => (j === k ? { ...x, ...patch } : x)) });
                    return (
                      <tr key={k}>
                        <td><input type="text" value={o.label} onChange={(e) => setO({ label: e.target.value })} placeholder="Enter an option" /></td>
                        <td><select value={o.price_type} onChange={(e) => setO({ price_type: e.target.value })}>{PRICE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                        <td><input type="text" inputMode="decimal" className="small-text" value={o.price} onChange={(e) => setO({ price: e.target.value })} /></td>
                        {a.display === 'images' && <td><ImageField value={o.image ? { id: o.image } : null} onChange={(img) => setO({ image: img ? img.id : '' })} /></td>}
                        <td><button type="button" className="button-link-delete" onClick={() => setA(i, { options: a.options.filter((_, j) => j !== k) })}>×</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : a.type !== 'heading' && (
              <div className="grid-2 mt">
                <label className="inline"><input type="checkbox" checked={a.adjust_price} onChange={(e) => setA(i, { adjust_price: e.target.checked })} /> Adjust price</label>
                {a.adjust_price && <span className="flex"><select value={a.price_type} onChange={(e) => setA(i, { price_type: e.target.value })}>{PRICE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><input type="text" inputMode="decimal" className="small-text" value={a.price} onChange={(e) => setA(i, { price: e.target.value })} /></span>}
                <label className="inline"><input type="checkbox" checked={a.restrictions} onChange={(e) => setA(i, { restrictions: e.target.checked })} /> Limit {a.type === 'custom_price' || a.type === 'input_multiplier' ? 'range' : 'characters'}</label>
                {a.restrictions && <span className="flex"><input type="number" className="small-text" placeholder="Min" value={a.min} onChange={(e) => setA(i, { min: e.target.value })} /><input type="number" className="small-text" placeholder="Max" value={a.max} onChange={(e) => setA(i, { max: e.target.value })} /></span>}
              </div>
            )}
            {hasOptions(a.type) && <button type="button" className="button mt" onClick={() => setA(i, { options: [...a.options, { label: '', price: '', image: '', price_type: 'flat_fee' }] })}>Add Option</button>}
          </div>
        )}
      </div>
    ))}
  </>;
}

// ── Brands (WooCommerce Brands taxonomy) ──
export function BrandsBox({ brands, value, onChange, onCreated, onError }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const add = async () => {
    if (!name.trim()) return;
    try {
      const b = await api.post(wc('products/brands'), { name: name.trim() });
      onCreated(b);
      onChange([...value, b.id]);
      setName(''); setAdding(false);
    } catch (e) { onError(e.message); }
  };
  return (
    <Postbox title="Brands">
      <TermChecklist terms={brands} value={value} onChange={onChange} />
      {adding ? (
        <div className="flex mt"><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="New brand name" style={{ flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} /><button type="button" className="button" onClick={add}>Add</button></div>
      ) : <a href="#" className="mt" style={{ display: 'inline-block' }} onClick={(e) => { e.preventDefault(); setAdding(true); }}>+ Add new brand</a>}
    </Postbox>
  );
}

// ── Reviews ──
export function ReviewsBox({ productId, onError }) {
  const [list, setList] = useState(null);
  const [form, setForm] = useState(null);
  const load = () => api.get(wc('products/reviews'), { product: productId, per_page: 50, status: 'all' }).then(setList).catch(() => setList([]));
  useEffect(() => { if (productId) load(); }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!productId) return null;
  const submit = async () => {
    try {
      await api.post(wc('products/reviews'), { product_id: productId, review: form.review, rating: Number(form.rating), reviewer: form.reviewer || undefined, reviewer_email: form.reviewer_email || undefined, status: 'approved' });
      setForm(null); load();
    } catch (e) { onError(e.message); }
  };
  const setStatus = async (r, status) => { try { await api.put(wc(`products/reviews/${r.id}`), { status }); load(); } catch (e) { onError(e.message); } };
  const remove = async (r) => { if (!confirmDelete('this review')) return; try { await api.del(wc(`products/reviews/${r.id}`), { force: true }); load(); } catch (e) { onError(e.message); } };
  return (
    <Postbox title="Reviews">
      {!form && <button type="button" className="button mb" onClick={() => setForm({ review: '', rating: 5, reviewer: '', reviewer_email: '' })}>Add review</button>}
      {form && (
        <div className="mb">
          <div className="grid-3">
            <div className="field"><label>Name</label><input type="text" value={form.reviewer} placeholder="(you)" onChange={(e) => setForm({ ...form, reviewer: e.target.value })} /></div>
            <div className="field"><label>Email</label><input type="email" value={form.reviewer_email} placeholder="(you)" onChange={(e) => setForm({ ...form, reviewer_email: e.target.value })} /></div>
            <div className="field"><label>Rating</label><select value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value })}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}</select></div>
          </div>
          <textarea rows={3} value={form.review} onChange={(e) => setForm({ ...form, review: e.target.value })} style={{ width: '100%' }} />
          <div className="flex mt"><button type="button" className="button button-primary" disabled={!form.review.trim()} onClick={submit}>Add Review</button><button type="button" className="button" onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      )}
      {list === null ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">No reviews yet.</p> : (
        <table className="widefat">
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td style={{ width: 180 }}><strong>{decodeHtml(r.reviewer)}</strong><br /><span className="muted">{date(r.date_created)}</span>{r.verified && <><br /><span className="muted">Verified owner</span></>}</td>
                <td>
                  <span style={{ color: '#dba617' }}>{'★'.repeat(r.rating)}</span><span style={{ color: '#c3c4c7' }}>{'★'.repeat(Math.max(0, 5 - r.rating))}</span>
                  {r.status !== 'approved' && <strong className="muted"> — {r.status}</strong>}
                  <div dangerouslySetInnerHTML={{ __html: r.review }} />
                  <div className="row-actions" style={{ position: 'static', visibility: 'visible' }}>
                    {r.status === 'approved' ? <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus(r, 'hold'); }}>Unapprove</a></span> : <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus(r, 'approved'); }}>Approve</a></span>}
                    {r.status !== 'spam' && <span><a href="#" onClick={(e) => { e.preventDefault(); setStatus(r, 'spam'); }}>Spam</a></span>}
                    <span><button type="button" className="button-link-delete" onClick={() => remove(r)}>Delete</button></span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Postbox>
  );
}
