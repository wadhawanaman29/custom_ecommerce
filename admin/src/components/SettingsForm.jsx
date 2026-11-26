import { useEffect, useState } from 'react';
import { api, fetchAll, wc, wp } from '../api';
import { decodeHtml } from '../format';
import { Loading } from './ui';

let pagesCache = null;
const loadPages = () => {
  if (!pagesCache) pagesCache = fetchAll(wp('pages'), { _fields: 'id,title' }).catch(() => []);
  return pagesCache;
};

// Renders one WooCommerce-style setting ({ id, label, type, options, value, description })
function SettingField({ s, value, onChange, pages }) {
  const opts = s.options ? Object.entries(s.options) : [];
  switch (s.type) {
    case 'checkbox':
      return <label className="inline"><input type="checkbox" checked={value === 'yes' || value === true} onChange={(e) => onChange(e.target.checked ? 'yes' : 'no')} /> {s.description || 'Enable'}</label>;
    case 'select':
      return opts.length ? (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>{opts.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      ) : <input type="text" className="regular-text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'radio':
      return <div>{opts.map(([k, v]) => <label key={k} style={{ display: 'block', marginBottom: 4 }}><input type="radio" checked={String(value) === k} onChange={() => onChange(k)} /> {v}</label>)}</div>;
    case 'multiselect':
      return <MultiText value={Array.isArray(value) ? value : []} onChange={onChange} />;
    case 'textarea':
      return <textarea rows={4} className="large-text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input type="number" className="small-text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'color':
      return <span className="flex"><input type="color" value={value || '#000000'} onChange={(e) => onChange(e.target.value)} /><input type="text" className="small-text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></span>;
    case 'single_select_page':
      return (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">— Select a page —</option>
          {pages.map((p) => <option key={p.id} value={String(p.id)}>{decodeHtml(p.title.rendered)}</option>)}
        </select>
      );
    case 'email':
      return <input type="email" className="regular-text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'password':
      // Stored secrets are never sent to the browser; leave empty to keep the saved value
      return <input type="password" className="regular-text" autoComplete="new-password" value={value ?? ''} placeholder={s.has_value ? '•••••••• (saved — leave empty to keep)' : ''} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input type="text" className="regular-text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

// Country-code lists etc.: comma-separated, parsed on blur
function MultiText({ value, onChange }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);
  return (
    <>
      <input type="text" className="large-text" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))} />
      <p className="description">Comma-separated codes, e.g. AU, NZ, US</p>
    </>
  );
}

// Loads wc/v3/settings/{group}, optionally limited to `only` ids, and saves changes via batch.
export default function SettingsForm({ group, only, onNotice, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [values, setValues] = useState({});
  const [pages, setPages] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSettings(null);
    api.get(wc(`settings/${group}`)).then((list) => {
      const filtered = only ? only.map((id) => list.find((s) => s.id === id)).filter(Boolean) : list;
      setSettings(filtered);
      setValues(Object.fromEntries(filtered.map((s) => [s.id, s.value])));
      if (filtered.some((s) => s.type === 'single_select_page')) loadPages().then(setPages);
    }).catch((e) => onNotice('error', e.message));
  }, [group, only && only.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings) return <Loading />;
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const changed = settings.filter((s) => JSON.stringify(values[s.id]) !== JSON.stringify(s.value)).map((s) => ({ id: s.id, value: values[s.id] }));
      if (!changed.length) { onNotice('success', 'No changes to save.'); return; }
      const r = await api.post(wc(`settings/${group}/batch`), { update: changed });
      const errors = r.update.filter((x) => x.error);
      if (errors.length) onNotice('error', errors.map((x) => `${x.id}: ${x.error.message}`).join('<br>'));
      else onNotice('success', 'Your settings have been saved.');
      const saved = Object.fromEntries(r.update.filter((x) => !x.error).map((x) => [x.id, x]));
      setSettings((ss) => ss.map((s) => (s.id in saved ? { ...s, value: saved[s.id].value, has_value: saved[s.id].has_value } : s)));
      setValues((v) => ({ ...v, ...Object.fromEntries(Object.entries(saved).map(([k, x]) => [k, x.value])) }));
      if (onSaved) onSaved();
    } catch (err) { onNotice('error', err.message); } finally { setSaving(false); }
  };
  return (
    <form onSubmit={save}>
      <table className="form-table"><tbody>
        {settings.map((s) => (
          <tr key={s.id}>
            <th scope="row">{s.label}</th>
            <td><SettingField s={s} value={values[s.id]} pages={pages} onChange={(v) => setValues((x) => ({ ...x, [s.id]: v }))} />
              {s.type !== 'checkbox' && s.description && <p className="description">{s.description}</p>}
              {s.tip && <p className="description">{s.tip}</p>}</td>
          </tr>
        ))}
      </tbody></table>
      <p><button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></p>
    </form>
  );
}
