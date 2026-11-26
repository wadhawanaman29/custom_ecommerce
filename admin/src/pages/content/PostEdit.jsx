import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fetchAll, wp } from '../../api';
import { useNotice } from '../../hooks';
import { decodeHtml, fromLocalInput, toLocalInput } from '../../format';
import Editor from '../../components/Editor';
import { ImageField } from '../../components/media';
import {
  Loading, Notice, PageHeader, Postbox, TagInput, TermChecklist, confirmDelete,
} from '../../components/ui';

const blank = { title: '', slug: '', content: '', excerpt: '', status: 'draft', date: '', categories: [], tags: [], featured_media: 0, parent: 0, menu_order: 0, template: '', comment_status: 'open', sticky: false, meta: {} };

export default function PostEdit({ type }) {
  const isPage = type === 'page';
  const base = isPage ? 'pages' : 'posts';
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [p, setP] = useState(null);
  const [featured, setFeatured] = useState(null);
  const [cats, setCats] = useState([]);
  const [tags, setTags] = useState([]);
  const [pages, setPages] = useState([]);
  const [postTags, setPostTags] = useState([]);
  const [newMeta, setNewMeta] = useState({ key: '', value: '' });
  const [notice, showNotice, closeNotice] = useNotice();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isPage) fetchAll(wp('pages'), { status: 'publish,draft,private', _fields: 'id,title,parent' }).then(setPages).catch(() => {});
    else {
      fetchAll(wp('categories')).then(setCats).catch(() => {});
      fetchAll(wp('tags')).then(setTags).catch(() => {});
    }
  }, [isPage]);

  useEffect(() => {
    if (isNew) { setP(blank); setFeatured(null); setPostTags([]); return; }
    api.get(wp(`${base}/${id}`), { context: 'edit' }).then((x) => {
      setP({
        title: x.title.raw ?? decodeHtml(x.title.rendered), slug: x.slug, content: x.content.raw ?? x.content.rendered, excerpt: x.excerpt.raw ?? '',
        status: x.status, date: x.date, categories: x.categories || [], featured_media: x.featured_media, parent: x.parent || 0, menu_order: x.menu_order || 0,
        template: x.template, comment_status: x.comment_status, sticky: !!x.sticky, meta: x.meta && !Array.isArray(x.meta) ? x.meta : {}, link: x.link, password: x.password || '',
      });
      if (x.tags && x.tags.length) api.get(wp('tags'), { include: x.tags.join(','), per_page: 100 }).then(setPostTags).catch(() => {});
      else setPostTags([]);
      if (x.featured_media) api.get(wp(`media/${x.featured_media}`)).then((m) => setFeatured({ id: m.id, src: m.source_url })).catch(() => setFeatured(null));
      else setFeatured(null);
    }).catch((e) => showNotice('error', e.message));
  }, [id, base]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return <><Notice notice={notice} onClose={closeNotice} /><Loading /></>;
  const set = (patch) => setP((x) => ({ ...x, ...patch }));

  const save = async (statusOverride) => {
    setSaving(true);
    try {
      const tagIds = [];
      for (const t of postTags) tagIds.push(t.id || (await api.post(wp('tags'), { name: t.name })).id);
      const body = {
        title: p.title, slug: p.slug || undefined, content: p.content, excerpt: p.excerpt, status: statusOverride || p.status, featured_media: featured ? featured.id : 0,
        comment_status: p.comment_status, template: p.template, meta: p.meta, password: p.password || '',
        ...(p.date ? { date: p.date } : {}),
        ...(isPage ? { parent: p.parent, menu_order: p.menu_order } : { categories: p.categories, tags: tagIds, sticky: p.sticky }),
      };
      const saved = isNew ? await api.post(wp(base), body) : await api.put(wp(`${base}/${id}`), body);
      showNotice('success', `${isPage ? 'Page' : 'Post'} ${saved.status === 'publish' ? 'published' : 'saved'}.${saved.status === 'publish' ? ` <a href="${saved.link}" target="_blank" rel="noreferrer">View ${isPage ? 'page' : 'post'}</a>` : ''}`);
      if (isNew) navigate(`/${base}/${saved.id}`, { replace: true });
      else set({ status: saved.status, slug: saved.slug, link: saved.link, date: saved.date });
    } catch (e) { showNotice('error', e.message); } finally { setSaving(false); }
  };

  const metaEntries = Object.entries(p.meta || {});
  return (
    <>
      <PageHeader title={isNew ? `Add New ${isPage ? 'Page' : 'Post'}` : `Edit ${isPage ? 'Page' : 'Post'}`} action="Add New" actionTo={`/${base}/new`} />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout">
        <div>
          <input className="title-input" placeholder="Add title" value={p.title} onChange={(e) => set({ title: e.target.value })} aria-label="Title" />
          <p className="flex"><strong>Slug:</strong> <input type="text" value={p.slug} onChange={(e) => set({ slug: e.target.value })} placeholder="auto-generated" style={{ width: 320 }} aria-label="Slug" />
            {p.link && p.status === 'publish' && <a href={p.link} target="_blank" rel="noreferrer">{p.link}</a>}</p>
          <Postbox><Editor value={p.content} onChange={(content) => set({ content })} /></Postbox>
          <Postbox title="Excerpt"><textarea rows={3} value={p.excerpt} onChange={(e) => set({ excerpt: e.target.value })} /><p className="description">Optional hand-crafted summary. Leave empty to auto-generate from the content.</p></Postbox>
          <Postbox title="Custom Fields">
            {metaEntries.length > 0 && (
              <table className="wp-list-table mb"><thead><tr><th>Name</th><th>Value</th><th /></tr></thead>
                <tbody>{metaEntries.map(([k, v]) => (
                  <tr key={k}><td><code>{k}</code></td>
                    <td>{typeof v === 'object' ? <code>{JSON.stringify(v)}</code> : <textarea rows={1} value={String(v ?? '')} onChange={(e) => set({ meta: { ...p.meta, [k]: e.target.value } })} />}</td>
                    <td><button type="button" className="button-link-delete" onClick={() => set({ meta: { ...p.meta, [k]: null } })}>Delete</button></td></tr>
                ))}</tbody></table>
            )}
            <div className="flex"><input type="text" placeholder="Name" value={newMeta.key} onChange={(e) => setNewMeta({ ...newMeta, key: e.target.value })} />
              <input type="text" placeholder="Value" value={newMeta.value} onChange={(e) => setNewMeta({ ...newMeta, value: e.target.value })} style={{ flex: 1 }} />
              <button type="button" className="button" onClick={() => { if (newMeta.key.trim()) { set({ meta: { ...p.meta, [newMeta.key.trim()]: newMeta.value } }); setNewMeta({ key: '', value: '' }); } }}>Add Custom Field</button></div>
          </Postbox>
        </div>
        <div>
          <Postbox title="Publish">
            <div className="field"><label>Status</label><select value={p.status} onChange={(e) => set({ status: e.target.value })}><option value="draft">Draft</option><option value="pending">Pending Review</option><option value="publish">Published</option><option value="private">Private</option><option value="future">Scheduled</option></select></div>
            <div className="field"><label>Publish date</label><input type="datetime-local" value={toLocalInput(p.date)} onChange={(e) => set({ date: fromLocalInput(e.target.value) })} /></div>
            <div className="field"><label>Password protect</label><input type="text" value={p.password || ''} onChange={(e) => set({ password: e.target.value })} placeholder="Public" /></div>
            {!isPage && <label className="inline mb"><input type="checkbox" checked={p.sticky} onChange={(e) => set({ sticky: e.target.checked })} /> Stick to the top of the blog</label>}
            <label className="inline mb"><input type="checkbox" checked={p.comment_status === 'open'} onChange={(e) => set({ comment_status: e.target.checked ? 'open' : 'closed' })} /> Allow comments</label>
            <div className="flex" style={{ justifyContent: 'space-between', marginTop: 10 }}>
              {!isNew ? <button type="button" className="button-link-delete" onClick={() => api.del(wp(`${base}/${id}`)).then(() => navigate(`/${base}`)).catch((e) => showNotice('error', e.message))}>Move to Trash</button>
                : <button type="button" className="button" disabled={saving} onClick={() => save('draft')}>Save Draft</button>}
              <button type="button" className="button button-primary" disabled={saving} onClick={() => save(isNew && p.status === 'draft' ? 'publish' : undefined)}>{saving ? 'Saving…' : isNew ? 'Publish' : 'Update'}</button>
            </div>
          </Postbox>
          {isPage && (
            <Postbox title="Page Attributes">
              <div className="field"><label>Parent</label><select value={p.parent} onChange={(e) => set({ parent: Number(e.target.value) })}><option value={0}>(no parent)</option>
                {pages.filter((x) => String(x.id) !== String(id)).map((x) => <option key={x.id} value={x.id}>{decodeHtml(x.title.rendered)}</option>)}</select></div>
              <div className="field"><label>Template</label><input type="text" value={p.template} onChange={(e) => set({ template: e.target.value })} placeholder="Default template" /></div>
              <div className="field"><label>Order</label><input type="number" value={p.menu_order} onChange={(e) => set({ menu_order: Number(e.target.value) })} /></div>
            </Postbox>
          )}
          {!isPage && <Postbox title="Categories"><TermChecklist terms={cats} value={p.categories} onChange={(categories) => set({ categories })} /></Postbox>}
          {!isPage && <Postbox title="Tags"><TagInput value={postTags} onChange={setPostTags} suggestions={tags} /></Postbox>}
          <Postbox title="Featured image"><ImageField value={featured} onChange={setFeatured} label="Set featured image" /></Postbox>
          {!isNew && <p><button type="button" className="button-link-delete" onClick={() => confirmDelete('this permanently') && api.del(wp(`${base}/${id}`), { force: true }).then(() => navigate(`/${base}`))}>Delete permanently</button></p>}
        </div>
      </div>
    </>
  );
}
