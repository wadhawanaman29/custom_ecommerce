// ACF-style custom field renderer. Values are stored the way ACF stores them (IDs for terms, posts, media).
import { useEffect, useState } from 'react';
import { api, fetchAll, wc, wp } from '../api';
import { decodeHtml } from '../format';
import Editor from './Editor';
import { MediaPicker } from './media';

// ───────── Option sources (cached per session) ─────────
const cache = new Map();
const once = (key, fn) => { if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; })); return cache.get(key); };
export const clearFieldCache = () => cache.clear();

// Flattens a term tree into "- - Child" labels like ACF's taxonomy select
function hierarchical(terms) {
  const byParent = new Map();
  for (const t of terms) { const p = t.parent || 0; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(t); }
  const ids = new Set(terms.map((t) => t.id));
  const out = [];
  const walk = (parent, depth) => (byParent.get(parent) || []).forEach((t) => { out.push({ id: t.id, label: `${'- '.repeat(depth)}${decodeHtml(t.name)}` }); walk(t.id, depth + 1); });
  walk(0, 0);
  for (const t of terms) if (t.parent && !ids.has(t.parent) && !out.some((o) => o.id === t.id)) out.push({ id: t.id, label: decodeHtml(t.name) });
  return out;
}

export function termOptions(taxonomy, registry) {
  return once(`tax:${taxonomy}`, async () => {
    if (taxonomy === 'product_cat') return hierarchical(await fetchAll(wc('products/categories')));
    if (taxonomy === 'product_tag') return (await fetchAll(wc('products/tags'))).map((t) => ({ id: t.id, label: decodeHtml(t.name) }));
    if (taxonomy === 'product_shipping_class') return (await fetchAll(wc('products/shipping_classes'))).map((t) => ({ id: t.id, label: decodeHtml(t.name) }));
    if (taxonomy.startsWith('pa_')) {
      const attrs = await api.get(wc('products/attributes'));
      const a = attrs.find((x) => x.slug === taxonomy);
      return a ? (await fetchAll(wc(`products/attributes/${a.id}/terms`))).map((t) => ({ id: t.id, label: decodeHtml(t.name) })) : [];
    }
    if (taxonomy === 'category') return hierarchical(await fetchAll(wp('categories')));
    if (taxonomy === 'post_tag') return (await fetchAll(wp('tags'))).map((t) => ({ id: t.id, label: decodeHtml(t.name) }));
    const tx = registry && registry.taxonomies.find((t) => t.name === taxonomy);
    if (tx) return hierarchical(await fetchAll(wp(tx.rest_base || tx.name)));
    return [];
  });
}

export function postOptions(postTypes, registry) {
  const types = postTypes && postTypes.length ? postTypes : ['page'];
  return once(`posts:${types.join(',')}`, async () => {
    const out = [];
    for (const t of types) {
      if (t === 'product') {
        out.push(...(await fetchAll(wc('products'), { status: 'any', _fields: 'id,name,status' })).map((p) => ({ id: p.id, label: decodeHtml(p.name), group: 'Products' })));
        continue;
      }
      const base = t === 'page' ? 'pages' : t === 'post' ? 'posts' : ((registry && registry.types.find((x) => x.name === t)) || {}).rest_base || t;
      try {
        const list = await fetchAll(wp(base), { status: 'publish,draft,private', _fields: 'id,title,status' });
        out.push(...list.map((p) => ({ id: p.id, label: `${decodeHtml(p.title.rendered) || `#${p.id}`}${p.status !== 'publish' ? ` (${p.status})` : ''}`, group: t })));
      } catch { /* type without REST route */ }
    }
    return out;
  });
}

function useOptions(loader, deps) {
  const [opts, setOpts] = useState(null);
  useEffect(() => { let live = true; loader().then((o) => live && setOpts(o)).catch(() => live && setOpts([])); return () => { live = false; }; }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return opts;
}

// ───────── Conditional logic ─────────
function ruleMatches(rule, siblings, values) {
  const f = siblings.find((s) => s.key === rule.field);
  if (!f) return true;
  const v = values ? values[f.name] : undefined;
  const str = Array.isArray(v) ? v.map(String) : v === null || v === undefined ? '' : String(v === true ? '1' : v === false ? '0' : v);
  const empty = Array.isArray(str) ? !str.length : str === '';
  switch (rule.operator) {
    case '==': return Array.isArray(str) ? str.includes(String(rule.value)) : str === String(rule.value);
    case '!=': return Array.isArray(str) ? !str.includes(String(rule.value)) : str !== String(rule.value);
    case '==empty': return empty;
    case '!=empty': return !empty;
    case '==contains': return String(str).includes(String(rule.value));
    case '!=contains': return !String(str).includes(String(rule.value));
    case '==pattern': try { return new RegExp(rule.value).test(String(str)); } catch { return true; }
    default: return true;
  }
}
export function isVisible(field, siblings, values) {
  const logic = field.conditional_logic;
  if (!Array.isArray(logic) || !logic.length) return true;
  return logic.some((andGroup) => (andGroup || []).every((r) => ruleMatches(r, siblings, values)));
}

// ───────── Defaults ─────────
export function emptyValue(f) {
  if (f.default_value !== undefined && f.default_value !== '' && f.default_value !== null && !['repeater', 'group', 'flexible_content'].includes(f.type)) {
    if (f.type === 'true_false') return f.default_value === 1 || f.default_value === '1' || f.default_value === true;
    return f.default_value;
  }
  switch (f.type) {
    case 'group': return Object.fromEntries((f.sub_fields || []).map((s) => [s.name, emptyValue(s)]));
    case 'repeater': case 'flexible_content': case 'gallery': case 'relationship': case 'checkbox': return [];
    case 'true_false': return false;
    case 'link': return null;
    default: return (f.multiple === 1 || f.multiple === true || f.multiple === '1') ? [] : null;
  }
}

// ───────── Individual inputs ─────────
function ImageValue({ value, onChange, multiple, accept }) {
  const [open, setOpen] = useState(false);
  const ids = (Array.isArray(value) ? value : value ? [value] : []).map((v) => (typeof v === 'object' && v ? v.id || v.ID : v)).filter(Boolean);
  const [srcs, setSrcs] = useState({});
  useEffect(() => {
    const missing = ids.filter((id) => typeof id === 'number' && !srcs[id]);
    if (missing.length) api.get(wp('media'), { include: missing.join(','), per_page: 100 }).then((ms) => setSrcs((s) => ({ ...s, ...Object.fromEntries(ms.map((m) => [m.id, m.source_url])) }))).catch(() => {});
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = (id) => srcs[id] || (typeof id === 'string' && /^https?:/.test(id) ? id : '');
  return (
    <div>
      <div className="image-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))' }}>
        {ids.map((id, i) => (
          <div key={`${id}-${i}`} className="tile">
            {preview(id) ? <img src={preview(id)} alt="" /> : <span>#{id}</span>}
            <button type="button" className="remove" onClick={() => onChange(multiple ? ids.filter((_, j) => j !== i) : null)} aria-label="Remove">×</button>
          </div>
        ))}
      </div>
      {(multiple || !ids.length) && <button type="button" className="button button-small mt" onClick={() => setOpen(true)}>{multiple ? 'Add to gallery' : accept === 'file' ? 'Add File' : 'Add Image'}</button>}
      {open && <MediaPicker multiple={!!multiple} onClose={() => setOpen(false)} onSelect={(sel) => {
        const list = Array.isArray(sel) ? sel : [sel];
        setSrcs((s) => ({ ...s, ...Object.fromEntries(list.map((m) => [m.id, m.source_url])) }));
        onChange(multiple ? [...ids, ...list.map((m) => m.id)] : list[0].id);
        setOpen(false);
      }} />}
    </div>
  );
}

function SelectFromOptions({ options, value, onChange, multiple, allowNull = true, placeholder = '- Select -' }) {
  const [search, setSearch] = useState('');
  if (!options) return <span className="muted">Loading…</span>;
  const norm = (v) => (typeof v === 'object' && v ? v.term_id || v.ID || v.id : v);
  if (multiple) {
    const vals = (Array.isArray(value) ? value : []).map(norm);
    const shown = search ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase())) : options;
    return (
      <div>
        {options.length > 12 && <input type="search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: '100%', marginBottom: 4 }} />}
        <div className="categorychecklist" style={{ maxHeight: 180 }}>
          {shown.map((o) => <label key={o.id}><input type="checkbox" checked={vals.map(String).includes(String(o.id))} onChange={() => onChange(vals.map(String).includes(String(o.id)) ? vals.filter((x) => String(x) !== String(o.id)) : [...vals, o.id])} /> {o.label}</label>)}
        </div>
      </div>
    );
  }
  const v = norm(value);
  return (
    <select value={v === null || v === undefined ? '' : String(v)} onChange={(e) => {
      const opt = options.find((o) => String(o.id) === e.target.value);
      onChange(opt ? opt.id : null);
    }} style={{ width: '100%' }}>
      {allowNull && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.id} value={String(o.id)}>{o.label}</option>)}
      {v !== null && v !== undefined && v !== '' && !options.some((o) => String(o.id) === String(v)) && <option value={String(v)}>#{v} (missing)</option>}
    </select>
  );
}

const toInputDate = (v) => (/^\d{8}$/.test(String(v || '')) ? `${String(v).slice(0, 4)}-${String(v).slice(4, 6)}-${String(v).slice(6, 8)}` : String(v || '').slice(0, 10));

// ───────── Field ─────────
export function Field({ field: f, value, onChange, registry, siblings, values, compact }) {
  if (!isVisible(f, siblings || [], values)) return null;
  const multiple = f.multiple === 1 || f.multiple === true || f.multiple === '1';
  const choices = Array.isArray(f.choices) ? Object.fromEntries(f.choices.map((c) => [c, c])) : f.choices || {};
  let input;
  switch (f.type) {
    case 'textarea': input = <textarea rows={f.rows || 4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} />; break;
    case 'number': case 'range': input = <input type="number" value={value ?? ''} min={f.min} max={f.max} step={f.step || 'any'} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />; break;
    case 'email': input = <input type="email" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />; break;
    case 'url': case 'oembed': input = <input type="url" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="https://" />; break;
    case 'password': input = <input type="password" value={value ?? ''} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" />; break;
    case 'color_picker': input = <span className="flex"><input type="color" value={value || '#000000'} onChange={(e) => onChange(e.target.value)} /><input type="text" className="small-text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></span>; break;
    case 'date_picker': input = <input type="date" value={toInputDate(value)} onChange={(e) => onChange(e.target.value ? e.target.value.replace(/-/g, '') : '')} />; break;
    case 'date_time_picker': input = <input type="datetime-local" value={String(value || '').replace(' ', 'T').slice(0, 16)} onChange={(e) => onChange(e.target.value ? `${e.target.value.replace('T', ' ')}:00` : '')} />; break;
    case 'time_picker': input = <input type="time" value={String(value || '').slice(0, 5)} onChange={(e) => onChange(e.target.value ? `${e.target.value}:00` : '')} />; break;
    case 'true_false': input = <label className="inline"><input type="checkbox" checked={!!value && value !== '0'} onChange={(e) => onChange(e.target.checked)} /> {f.message || f.label}</label>; break;
    case 'select':
      input = multiple
        ? <SelectFromOptions multiple options={Object.entries(choices).map(([id, label]) => ({ id, label }))} value={value} onChange={onChange} />
        : (
          <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} style={{ width: '100%' }}>
            {(f.allow_null || !value) && <option value="">- Select -</option>}
            {Object.entries(choices).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            {value && !(value in choices) && <option value={value}>{value}</option>}
          </select>
        );
      break;
    case 'radio': case 'button_group':
      input = <div>{Object.entries(choices).map(([k, l]) => <label key={k} style={{ display: f.layout === 'horizontal' || f.type === 'button_group' ? 'inline-flex' : 'flex', gap: 6, marginRight: 14, marginBottom: 4 }}><input type="radio" checked={String(value ?? '') === String(k)} onChange={() => onChange(k)} /> {l}</label>)}</div>;
      break;
    case 'checkbox': {
      const vals = Array.isArray(value) ? value.map(String) : [];
      input = <div>{Object.entries(choices).map(([k, l]) => <label key={k} style={{ display: 'flex', gap: 6, marginBottom: 4 }}><input type="checkbox" checked={vals.includes(k)} onChange={() => onChange(vals.includes(k) ? vals.filter((x) => x !== k) : [...vals, k])} /> {l}</label>)}</div>;
      break;
    }
    case 'image': input = <ImageValue value={value} onChange={onChange} />; break;
    case 'file': input = <ImageValue value={value} onChange={onChange} accept="file" />; break;
    case 'gallery': input = <ImageValue value={value} onChange={onChange} multiple />; break;
    case 'wysiwyg': input = <Editor value={value || ''} onChange={onChange} />; break;
    case 'link': {
      const v = value && typeof value === 'object' ? value : { title: '', url: value || '', target: '' };
      input = (
        <div className="grid-3">
          <input type="text" placeholder="Link text" value={v.title || ''} onChange={(e) => onChange({ ...v, title: e.target.value })} />
          <input type="text" placeholder="URL" value={v.url || ''} onChange={(e) => onChange({ ...v, url: e.target.value })} />
          <label className="inline"><input type="checkbox" checked={v.target === '_blank'} onChange={(e) => onChange({ ...v, target: e.target.checked ? '_blank' : '' })} /> Open in a new tab</label>
        </div>
      );
      break;
    }
    case 'taxonomy': input = <TaxonomyInput f={f} value={value} onChange={onChange} registry={registry} />; break;
    case 'post_object': case 'page_link': case 'relationship': input = <PostInput f={f} value={value} onChange={onChange} registry={registry} multiple={multiple || f.type === 'relationship'} />; break;
    case 'user': input = <UserInput value={value} onChange={onChange} multiple={multiple} />; break;
    case 'group':
      input = <FieldList fields={f.sub_fields || []} values={value || {}} onChange={onChange} registry={registry} boxed />;
      break;
    case 'repeater': input = <Repeater f={f} value={value} onChange={onChange} registry={registry} />; break;
    case 'flexible_content': input = <Flexible f={f} value={value} onChange={onChange} registry={registry} />; break;
    case 'message': return <div className="field"><strong>{f.label}</strong><p className="description" style={{ fontStyle: 'normal' }} dangerouslySetInnerHTML={{ __html: f.message || '' }} /></div>;
    case 'tab': case 'accordion': return <h3 style={{ borderBottom: '1px solid var(--border-light)', paddingBottom: 4 }}>{f.label}</h3>;
    default: input = <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} maxLength={f.maxlength || undefined} />;
  }
  if (compact) return input;
  return (
    <div className="field acf-field">
      {f.type !== 'true_false' && <label>{f.label}{f.required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}</label>}
      {f.instructions && <p className="description" style={{ marginTop: 0 }}>{f.instructions}</p>}
      {input}
    </div>
  );
}

function TaxonomyInput({ f, value, onChange, registry }) {
  const opts = useOptions(() => termOptions(f.taxonomy, registry), [f.taxonomy]);
  const multiple = ['checkbox', 'multi_select'].includes(f.field_type);
  return <SelectFromOptions options={opts} value={value} onChange={onChange} multiple={multiple} allowNull={f.allow_null !== 0} />;
}

function PostInput({ f, value, onChange, registry, multiple }) {
  const types = Array.isArray(f.post_type) ? f.post_type : f.post_type ? [f.post_type] : [];
  const opts = useOptions(() => postOptions(types, registry), [types.join(',')]);
  return <SelectFromOptions options={opts} value={value} onChange={onChange} multiple={multiple} />;
}

function UserInput({ value, onChange, multiple }) {
  const opts = useOptions(() => once('users', async () => (await fetchAll(wp('users'), { context: 'edit' })).map((u) => ({ id: u.id, label: `${u.name} (${u.username})` }))), []);
  return <SelectFromOptions options={opts} value={value} onChange={onChange} multiple={multiple} />;
}

function Repeater({ f, value, onChange, registry }) {
  const rows = Array.isArray(value) ? value : [];
  const subs = f.sub_fields || [];
  const set = (i, row) => onChange(rows.map((r, j) => (j === i ? row : r)));
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= rows.length) return; const c = [...rows]; [c[i], c[j]] = [c[j], c[i]]; onChange(c); };
  const newRow = () => Object.fromEntries(subs.map((s) => [s.name, emptyValue(s)]));
  const max = parseInt(f.max, 10) || 0;
  const table = f.layout === 'table' && subs.every((s) => !['repeater', 'group', 'flexible_content', 'wysiwyg'].includes(s.type));
  return (
    <div className="acf-repeater">
      {table ? (
        <table className="wp-list-table acf-table">
          <thead><tr><th style={{ width: 28 }} />{subs.map((s) => <th key={s.key}>{s.label}</th>)}<th style={{ width: 70 }} /></tr></thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                {subs.map((s) => <td key={s.key}><Field compact field={s} value={row[s.name]} onChange={(v) => set(i, { ...row, [s.name]: v })} registry={registry} siblings={subs} values={row} /></td>)}
                <td className="flex"><button type="button" className="button button-small" onClick={() => move(i, -1)} aria-label="Move up">↑</button><button type="button" className="button button-small" onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  <button type="button" className="button-link-delete" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove row">−</button></td>
              </tr>
            ))}
            {!rows.length && <tr className="empty"><td colSpan={subs.length + 2}>No rows.</td></tr>}
          </tbody>
        </table>
      ) : rows.map((row, i) => (
        <div key={i} className="variation">
          <div className="variation-head"><strong>{i + 1}</strong><span style={{ marginLeft: 'auto' }} className="flex">
            <button type="button" className="button button-small" onClick={() => move(i, -1)} aria-label="Move up">↑</button><button type="button" className="button button-small" onClick={() => move(i, 1)} aria-label="Move down">↓</button>
            <button type="button" className="button-link-delete" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</button></span></div>
          <div className="variation-body"><FieldList fields={subs} values={row} onChange={(r) => set(i, r)} registry={registry} /></div>
        </div>
      ))}
      <p className="right"><button type="button" className="button button-primary" disabled={max > 0 && rows.length >= max} onClick={() => onChange([...rows, newRow()])}>{f.button_label || 'Add Row'}</button></p>
    </div>
  );
}

function Flexible({ f, value, onChange, registry }) {
  const rows = Array.isArray(value) ? value : [];
  const [add, setAdd] = useState('');
  const layouts = f.layouts || [];
  return (
    <div>
      {rows.map((row, i) => {
        const layout = layouts.find((l) => l.name === row.acf_fc_layout) || { label: row.acf_fc_layout, sub_fields: [] };
        return (
          <div key={i} className="variation">
            <div className="variation-head"><strong>{i + 1}. {layout.label}</strong>
              <button type="button" className="button-link-delete" style={{ marginLeft: 'auto' }} onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</button></div>
            <div className="variation-body"><FieldList fields={layout.sub_fields || []} values={row} onChange={(r) => onChange(rows.map((x, j) => (j === i ? { ...r, acf_fc_layout: row.acf_fc_layout } : x)))} registry={registry} /></div>
          </div>
        );
      })}
      <div className="flex">
        <select value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Layout"><option value="">Choose layout…</option>{layouts.map((l) => <option key={l.name} value={l.name}>{l.label}</option>)}</select>
        <button type="button" className="button button-primary" disabled={!add} onClick={() => { const l = layouts.find((x) => x.name === add); onChange([...rows, { acf_fc_layout: add, ...Object.fromEntries((l.sub_fields || []).map((s) => [s.name, emptyValue(s)])) }]); setAdd(''); }}>{f.button_label || 'Add Row'}</button>
      </div>
    </div>
  );
}

// A list of sibling fields bound to one object value
export function FieldList({ fields, values, onChange, registry, boxed }) {
  const v = values || {};
  const body = fields.map((f) => (
    <Field key={f.key || f.name} field={f} value={v[f.name] !== undefined ? v[f.name] : emptyValue(f)} registry={registry} siblings={fields} values={v}
      onChange={(nv) => onChange({ ...v, [f.name]: nv })} />
  ));
  return boxed ? <div className="acf-group">{body}</div> : <>{body}</>;
}

// Top-level: one postbox per field group
export function FieldGroups({ groups, values, onChange, registry }) {
  return groups.map((g) => (
    <div key={g.key} className="postbox">
      <div className="postbox-header"><span>{g.title}</span></div>
      <div className="inside"><FieldList fields={g.fields || []} values={values} onChange={onChange} registry={registry} /></div>
    </div>
  ));
}

// Client-side version of the server's ACF location matcher
export function groupsFor(registry, ctx) {
  if (!registry) return [];
  return (registry.field_groups || []).filter((g) => g.active !== false && (g.location || []).some((and) => (and || []).every((r) => {
    let actual;
    if (r.param === 'post_type') actual = ctx.post_type;
    else if (r.param === 'taxonomy') actual = ctx.taxonomy;
    else if (r.param === 'post_taxonomy') { const has = (ctx.terms || []).includes(r.value); return r.operator === '!=' ? !has : has; } else if (r.param === 'page_template') actual = ctx.page_template || 'default';
    else if (r.param === 'options_page') return false;
    else return true;
    return r.operator === '!=' ? actual !== r.value : actual === r.value || (r.value === 'all' && !!actual);
  }))).sort((a, b) => (a.menu_order || 0) - (b.menu_order || 0));
}
