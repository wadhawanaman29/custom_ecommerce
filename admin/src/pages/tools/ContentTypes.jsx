import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, custom } from '../../api';
import { useNotice } from '../../hooks';
import { useContentTypes } from '../../contentTypes';
import {
  Loading, Modal, Notice, PageHeader, Postbox,
} from '../../components/ui';

const countFields = (fields) => (fields || []).reduce((n, f) => n + 1 + countFields(f.sub_fields) + (f.layouts || []).reduce((m, l) => m + countFields(l.sub_fields), 0), 0);
const describeLocation = (loc) => (loc || []).map((and) => (and || []).map((r) => `${r.param.replace('_', ' ')} ${r.operator} ${r.value}`).join(' and ')).join(' or ');

// Tools → Content Types: CPT UI + ACF equivalent (post types, taxonomies, field groups)
export default function ContentTypes() {
  const { registry, reload } = useContentTypes();
  const [notice, showNotice, closeNotice] = useNotice();
  const [paste, setPaste] = useState(null); // { kind: 'acf'|'cptui', text }
  const [json, setJson] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!registry) return <Loading />;

  const importPaste = async () => {
    setBusy(true);
    try {
      const r = await api.post(custom(`admin/content-types/import-${paste.kind}`), { json: paste.text });
      const parts = Object.entries(r.imported).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace('_', ' ')}`);
      showNotice('success', `Imported ${parts.join(', ')}.`);
      setPaste(null);
      await reload();
    } catch (e) { showNotice('error', e.message); } finally { setBusy(false); }
  };
  const saveJson = async () => {
    let data;
    try { data = JSON.parse(json); } catch (e) { showNotice('error', `Invalid JSON: ${e.message}`); return; }
    setBusy(true);
    try {
      await api.put(custom('admin/content-types'), data);
      showNotice('success', 'Content types saved.');
      setJson(null);
      await reload();
    } catch (e) { showNotice('error', (e.data && e.data.data && e.data.data.errors ? e.data.data.errors.join('<br>') : e.message)); } finally { setBusy(false); }
  };
  const loadFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setPaste((p) => ({ ...p, text: String(reader.result) }));
    reader.readAsText(f);
  };

  return (
    <>
      <PageHeader title="Content Types & Custom Fields" />
      <Notice notice={notice} onClose={closeNotice} />
      <p className="muted">Custom post types, taxonomies and ACF-style field groups. Imported automatically by <Link to="/tools/import">Import from WordPress</Link> (database); or paste exports below.</p>
      <div className="flex mb">
        <button type="button" className="button button-primary" onClick={() => setPaste({ kind: 'acf', text: '' })}>Import ACF export (JSON)</button>
        <button type="button" className="button" onClick={() => setPaste({ kind: 'cptui', text: '' })}>Import CPT UI export</button>
        <button type="button" className="button" onClick={() => setJson(JSON.stringify(registry, null, 2))}>Edit as JSON</button>
      </div>

      <div className="grid-2">
        <Postbox title={`Post types (${registry.types.length})`}>
          <table className="wp-list-table"><thead><tr><th>Label</th><th>Name</th><th>Taxonomies</th><th>Supports</th></tr></thead>
            <tbody>{registry.types.map((t) => (
              <tr key={t.name}><td><Link to={`/content/${t.name}`}>{t.label}</Link></td><td><code>{t.name}</code><div className="muted">/wp-json/wp/v2/{t.rest_base || t.name}</div></td>
                <td>{(t.taxonomies || []).join(', ') || '—'}</td><td>{(t.supports || []).join(', ')}</td></tr>
            ))}{!registry.types.length && <tr className="empty"><td colSpan={4}>None</td></tr>}</tbody></table>
        </Postbox>
        <Postbox title={`Taxonomies (${registry.taxonomies.length})`}>
          <table className="wp-list-table"><thead><tr><th>Label</th><th>Name</th><th>Post types</th></tr></thead>
            <tbody>{registry.taxonomies.map((t) => (
              <tr key={t.name}><td>{t.label}</td><td><code>{t.name}</code>{t.hierarchical && <span className="muted"> (hierarchical)</span>}</td><td>{(t.object_types || []).join(', ')}</td></tr>
            ))}{!registry.taxonomies.length && <tr className="empty"><td colSpan={3}>None</td></tr>}</tbody></table>
        </Postbox>
      </div>
      <Postbox title={`Field groups (${registry.field_groups.length})`}>
        <table className="wp-list-table"><thead><tr><th>Title</th><th>Key</th><th>Location</th><th>Fields</th><th>Status</th></tr></thead>
          <tbody>{registry.field_groups.map((g) => (
            <tr key={g.key}><td><strong>{g.title}</strong><div className="muted">{(g.fields || []).map((f) => f.name).filter(Boolean).join(', ')}</div></td>
              <td><code>{g.key}</code></td><td>{describeLocation(g.location)}</td><td>{countFields(g.fields)}</td><td>{g.active === false ? 'Inactive' : 'Active'}</td></tr>
          ))}{!registry.field_groups.length && <tr className="empty"><td colSpan={5}>None</td></tr>}</tbody></table>
      </Postbox>

      {paste && (
        <Modal title={paste.kind === 'acf' ? 'Import ACF field groups' : 'Import CPT UI post types / taxonomies'} onClose={() => setPaste(null)}
          footer={<><button type="button" className="button" onClick={() => setPaste(null)}>Cancel</button><button type="button" className="button button-primary" disabled={!paste.text.trim() || busy} onClick={importPaste}>{busy ? 'Importing…' : 'Import'}</button></>}>
          <p className="muted">{paste.kind === 'acf'
            ? 'In WordPress: Custom Fields (ACF) → Tools → Export Field Groups → select all → Export As JSON. Upload the file or paste its contents. Groups with the same key are replaced.'
            : 'In WordPress: CPT UI → Tools → Export Post Types (and Export Taxonomies). Paste the JSON. Types with the same name are updated.'}</p>
          <p><input type="file" accept=".json,application/json" onChange={loadFile} /></p>
          <textarea rows={14} className="html-editor" value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="[ { &quot;key&quot;: &quot;group_…&quot;, &quot;title&quot;: …, &quot;fields&quot;: [ … ] } ]" />
        </Modal>
      )}
      {json !== null && (
        <Modal title="Edit content types (JSON)" onClose={() => setJson(null)}
          footer={<><button type="button" className="button-link-delete" style={{ marginRight: 'auto' }} onClick={async () => { if (window.confirm('Reset post types, taxonomies and field groups to the built-in defaults (Frontend Menus)? Content is not deleted.')) { await api.post(custom('admin/content-types/reset')); setJson(null); await reload(); showNotice('success', 'Reset to defaults.'); } }}>Reset to defaults</button>
            <button type="button" className="button" onClick={() => setJson(null)}>Cancel</button><button type="button" className="button button-primary" disabled={busy} onClick={saveJson}>Save</button></>}>
          <p className="muted">{'{ "types": [...], "taxonomies": [...], "field_groups": [...] }'} — field groups use ACF's JSON format. Changing a field name does not rename stored values.</p>
          <textarea rows={24} className="html-editor" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
        </Modal>
      )}
    </>
  );
}
