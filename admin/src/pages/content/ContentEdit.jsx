import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fetchAll, wp } from '../../api';
import { useNotice } from '../../hooks';
import { decodeHtml, fromLocalInput, toLocalInput } from '../../format';
import { typeInfo, useContentTypes } from '../../contentTypes';
import Editor from '../../components/Editor';
import { ImageField } from '../../components/media';
import { FieldGroups, groupsFor } from '../../components/fields';
import {
  Loading, Notice, PageHeader, Postbox, TermChecklist, confirmDelete,
} from '../../components/ui';

// Edit screen for any registered custom post type, with its ACF field groups
export default function ContentEdit() {
  const { type } = useParams();
  const { registry } = useContentTypes();
  const info = typeInfo(registry, type);
  if (!registry) return <Loading />;
  if (!info) return <div className="notice notice-error"><span>Unknown content type “{type}”.</span></div>;
  return <EditForm key={type} info={info} registry={registry} />;
}

function EditForm({ info, registry }) {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const base = info.rest_base;
  const route = `/content/${info.name}`;
  const supports = (s) => (info.supports || []).includes(s);
  const [p, setP] = useState(null);
  const [acf, setAcf] = useState({});
  const [termsByTax, setTermsByTax] = useState({});
  const [selected, setSelected] = useState({});
  const [featured, setFeatured] = useState(null);
  const [parents, setParents] = useState([]);
  const [newTerm, setNewTerm] = useState({});
  const [notice, showNotice, closeNotice] = useNotice();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all(info.taxonomies.map(async (t) => [t.name, await fetchAll(wp(t.rest_base || t.name)).catch(() => [])])).then((l) => setTermsByTax(Object.fromEntries(l)));
    if (info.hierarchical) fetchAll(wp(base), { status: 'publish,draft,private', _fields: 'id,title' }).then(setParents).catch(() => {});
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isNew) {
      setP({ title: '', slug: '', content: '', excerpt: '', status: 'draft', date: '', menu_order: 0, parent: 0 });
      setAcf({}); setSelected({}); setFeatured(null);
      return;
    }
    api.get(wp(`${base}/${id}`), { context: 'edit' }).then((x) => {
      setP({
        title: x.title.raw ?? decodeHtml(x.title.rendered), slug: x.slug, content: x.content.raw ?? x.content.rendered, excerpt: x.excerpt.raw ?? '',
        status: x.status, date: x.date, menu_order: x.menu_order || 0, parent: x.parent || 0, link: x.link, modified: x.modified,
      });
      setAcf(x.acf && typeof x.acf === 'object' ? x.acf : {});
      setSelected(Object.fromEntries(info.taxonomies.map((t) => [t.name, x[t.rest_base || t.name] || []])));
      if (x.featured_media) api.get(wp(`media/${x.featured_media}`)).then((m) => setFeatured({ id: m.id, src: m.source_url })).catch(() => setFeatured(null));
      else setFeatured(null);
    }).catch((e) => showNotice('error', e.message));
  }, [id, base]); // eslint-disable-line react-hooks/exhaustive-deps

  // Field groups for this type (+ "post_taxonomy" rules based on the ticked terms)
  const termKeys = useMemo(() => info.taxonomies.flatMap((t) => (selected[t.name] || []).map((tid) => {
    const term = (termsByTax[t.name] || []).find((x) => x.id === tid);
    return term ? `${t.name}:${term.slug}` : null;
  }).filter(Boolean)), [selected, termsByTax, info.taxonomies]);
  const groups = useMemo(() => groupsFor(registry, { post_type: info.name, terms: termKeys }), [registry, info.name, termKeys]);

  if (!p) return <><Notice notice={notice} onClose={closeNotice} /><Loading /></>;
  const set = (patch) => setP((x) => ({ ...x, ...patch }));

  const save = async (statusOverride) => {
    if (supports('title') && !p.title.trim()) { showNotice('error', 'Please enter a title.'); return; }
    setSaving(true);
    try {
      // Only send values of fields that belong to the visible groups (others are kept on the server)
      const names = new Set(groups.flatMap((g) => (g.fields || []).map((f) => f.name)));
      const body = {
        title: p.title, slug: p.slug || undefined, status: statusOverride || p.status, menu_order: Number(p.menu_order) || 0,
        acf: Object.fromEntries(Object.entries(acf).filter(([k]) => names.has(k))),
        ...(supports('editor') ? { content: p.content } : {}),
        ...(supports('excerpt') ? { excerpt: p.excerpt } : {}),
        ...(supports('thumbnail') ? { featured_media: featured ? featured.id : 0 } : {}),
        ...(info.hierarchical ? { parent: p.parent } : {}),
        ...(p.date ? { date: p.date } : {}),
        ...Object.fromEntries(info.taxonomies.map((t) => [t.rest_base || t.name, selected[t.name] || []])),
      };
      const saved = isNew ? await api.post(wp(base), body) : await api.put(wp(`${base}/${id}`), body);
      showNotice('success', `${info.singular_label} ${saved.status === 'publish' ? 'published' : 'saved'}.`);
      if (isNew) navigate(`${route}/${saved.id}`, { replace: true });
      else { set({ status: saved.status, slug: saved.slug, link: saved.link, date: saved.date, modified: saved.modified }); setAcf(saved.acf || {}); }
    } catch (e) { showNotice('error', e.message); } finally { setSaving(false); }
  };

  const addTerm = async (t) => {
    const name = (newTerm[t.name] || '').trim();
    if (!name) return;
    try {
      const term = await api.post(wp(t.rest_base || t.name), { name });
      setTermsByTax((x) => ({ ...x, [t.name]: [...(x[t.name] || []), term] }));
      setSelected((x) => ({ ...x, [t.name]: [...(x[t.name] || []), term.id] }));
      setNewTerm((x) => ({ ...x, [t.name]: '' }));
    } catch (e) { showNotice('error', e.message); }
  };

  return (
    <>
      <PageHeader title={isNew ? `Add new ${info.singular_label}` : `Edit ${info.singular_label}`} action={`Add new ${info.singular_label}`} actionTo={`${route}/new`} />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout">
        <div>
          {supports('title') && <input className="title-input" placeholder="Add title" value={p.title} onChange={(e) => set({ title: e.target.value })} aria-label="Title" />}
          {p.link && <p className="muted" style={{ marginTop: -8 }}>Permalink: <a href={p.link} target="_blank" rel="noreferrer">{p.link}</a></p>}
          {supports('editor') && <Postbox><Editor value={p.content} onChange={(content) => set({ content })} />{p.modified && <p className="muted right" style={{ margin: '6px 0 0' }}>Last edited on {new Date(p.modified).toLocaleString()}</p>}</Postbox>}
          <FieldGroups groups={groups} values={acf} onChange={setAcf} registry={registry} />
          {!groups.length && <p className="muted">No custom field groups are assigned to {info.label}. Add them in Tools → Content Types.</p>}
          {supports('excerpt') && (
            <Postbox title="Excerpt">
              <textarea rows={3} value={p.excerpt} onChange={(e) => set({ excerpt: e.target.value })} />
              <p className="description">Excerpts are optional hand-crafted summaries of your content.</p>
            </Postbox>
          )}
          <Postbox title="Slug"><input type="text" value={p.slug} onChange={(e) => set({ slug: e.target.value })} placeholder="auto-generated from the title" style={{ width: '100%' }} /></Postbox>
        </div>
        <div>
          <Postbox title="Publish">
            <div className="field"><label>Status</label>
              <select value={p.status} onChange={(e) => set({ status: e.target.value })}><option value="draft">Draft</option><option value="pending">Pending Review</option><option value="publish">Published</option><option value="private">Private</option></select></div>
            <div className="field"><label>Publish on</label><input type="datetime-local" value={toLocalInput(p.date)} onChange={(e) => set({ date: fromLocalInput(e.target.value) })} /></div>
            <div className="flex" style={{ justifyContent: 'space-between', marginTop: 10 }}>
              {!isNew ? <button type="button" className="button-link-delete" onClick={() => api.del(wp(`${base}/${id}`)).then(() => navigate(route)).catch((e) => showNotice('error', e.message))}>Move to Trash</button>
                : <button type="button" className="button" disabled={saving} onClick={() => save('draft')}>Save Draft</button>}
              <span className="flex">
                {!isNew && p.status !== 'publish' && <button type="button" className="button" disabled={saving} onClick={() => save()}>Save Draft</button>}
                <button type="button" className="button button-primary" disabled={saving} onClick={() => save(p.status === 'draft' ? 'publish' : undefined)}>{saving ? 'Saving…' : p.status === 'publish' && !isNew ? 'Update' : 'Publish'}</button>
              </span>
            </div>
          </Postbox>
          {info.taxonomies.map((t) => (
            <Postbox key={t.name} title={t.label}>
              <TermChecklist terms={termsByTax[t.name] || []} value={selected[t.name] || []} onChange={(ids) => setSelected((x) => ({ ...x, [t.name]: ids }))} />
              <div className="flex mt"><input type="text" value={newTerm[t.name] || ''} onChange={(e) => setNewTerm((x) => ({ ...x, [t.name]: e.target.value }))} placeholder={`+ Add new ${t.singular_label}`} style={{ flex: 1 }} />
                <button type="button" className="button" onClick={() => addTerm(t)}>Add</button></div>
            </Postbox>
          ))}
          {(supports('page-attributes') || info.hierarchical) && (
            <Postbox title="Attributes">
              {info.hierarchical && <div className="field"><label>Parent</label><select value={p.parent} onChange={(e) => set({ parent: Number(e.target.value) })}><option value={0}>(no parent)</option>
                {parents.filter((x) => String(x.id) !== String(id)).map((x) => <option key={x.id} value={x.id}>{decodeHtml(x.title.rendered)}</option>)}</select></div>}
              <div className="field"><label>Order</label><input type="number" value={p.menu_order} onChange={(e) => set({ menu_order: e.target.value })} /></div>
            </Postbox>
          )}
          {supports('thumbnail') && <Postbox title="Featured image"><ImageField value={featured} onChange={setFeatured} label="Set featured image" /></Postbox>}
          {!isNew && <p><button type="button" className="button-link-delete" onClick={() => confirmDelete('this permanently') && api.del(wp(`${base}/${id}`), { force: true }).then(() => navigate(route))}>Delete permanently</button></p>}
        </div>
      </div>
    </>
  );
}
