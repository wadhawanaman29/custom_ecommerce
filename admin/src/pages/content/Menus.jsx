import { useEffect, useState } from 'react';
import { api, fetchAll, wc, wp } from '../../api';
import { useNotice } from '../../hooks';
import { decodeHtml } from '../../format';
import { Loading, Notice, PageHeader, Postbox, confirmDelete } from '../../components/ui';

// Appearance → Menus: pick a menu, add pages/posts/categories/custom links, reorder and nest items.
export default function Menus() {
  const [menus, setMenus] = useState(null);
  const [menuId, setMenuId] = useState(null);
  const [items, setItems] = useState([]);
  const [deleted, setDeleted] = useState([]);
  const [name, setName] = useState('');
  const [locations, setLocations] = useState('');
  const [sources, setSources] = useState({ pages: [], posts: [], categories: [], product_cats: [] });
  const [custom, setCustom] = useState({ url: '', title: '' });
  const [notice, showNotice, closeNotice] = useNotice();

  const loadMenus = (selectId) => api.get(wp('menus')).then((ms) => {
    setMenus(ms);
    const pick = selectId || menuId || (ms[0] && ms[0].id);
    if (pick) selectMenu(ms.find((m) => m.id === pick) || ms[0]);
  });
  const selectMenu = async (m) => {
    if (!m) return;
    setMenuId(m.id); setName(m.name); setLocations((m.locations || []).join(', ')); setDeleted([]);
    const its = await api.get(wp('menu-items'), { menus: m.id, per_page: 100 });
    setItems(its.sort((a, b) => a.menu_order - b.menu_order).map((i) => ({ id: i.id, title: decodeHtml(i.title.rendered), url: i.url, type: i.type, object: i.object, object_id: i.object_id, parent: i.parent, target: i.target })));
  };
  useEffect(() => {
    loadMenus().catch((e) => showNotice('error', e.message));
    Promise.all([
      fetchAll(wp('pages'), { _fields: 'id,title' }), api.get(wp('posts'), { per_page: 30, _fields: 'id,title' }),
      fetchAll(wp('categories')), fetchAll(wc('products/categories')).catch(() => []),
    ]).then(([pages, posts, categories, productCats]) => setSources({ pages, posts, categories, product_cats: productCats })).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (item) => setItems((is) => [...is, { ...item, parent: 0, target: '' }]);
  const move = (i, dir) => setItems((is) => {
    const j = i + dir;
    if (j < 0 || j >= is.length) return is;
    const copy = [...is];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  });
  const indent = (i, dir) => setItems((is) => is.map((it, idx) => {
    if (idx !== i) return it;
    if (dir > 0) { const prev = is[i - 1]; return prev && prev.id ? { ...it, parent: prev.id } : it; }
    return { ...it, parent: 0 };
  }));

  const save = async () => {
    try {
      let id = menuId;
      const locs = locations.split(',').map((s) => s.trim()).filter(Boolean);
      if (!id) id = (await api.post(wp('menus'), { name, locations: locs })).id;
      else await api.put(wp(`menus/${id}`), { name, locations: locs });
      for (const d of deleted) await api.del(wp(`menu-items/${d}`), { force: true });
      // Save in order; new items get IDs so children added in the same session can point to them
      const idMap = {};
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const body = { menus: id, title: it.title, url: it.url, type: it.type, object: it.object, object_id: it.object_id, parent: idMap[it.parent] || it.parent || 0, menu_order: i + 1, target: it.target };
        if (it.id) await api.put(wp(`menu-items/${it.id}`), body);
        else { const created = await api.post(wp('menu-items'), body); idMap[it.tmp] = created.id; }
      }
      showNotice('success', 'Menu saved.');
      await loadMenus(id);
    } catch (e) { showNotice('error', e.message); }
  };

  if (!menus) return <><Notice notice={notice} onClose={closeNotice} /><Loading /></>;
  const depth = (it) => { let d = 0; let p = it.parent; while (p && d < 5) { d++; const parent = items.find((x) => x.id === p); p = parent ? parent.parent : 0; } return d; };

  const sourceBox = (title, list, map) => (
    <Postbox title={title}>
      <div className="categorychecklist" style={{ maxHeight: 160 }}>
        {list.map((x) => <div key={x.id} className="flex" style={{ justifyContent: 'space-between' }}><span>{decodeHtml(x.title ? x.title.rendered : x.name)}</span><button type="button" className="button button-small" onClick={() => add(map(x))}>Add</button></div>)}
        {!list.length && <span className="muted">Nothing found.</span>}
      </div>
    </Postbox>
  );

  return (
    <>
      <PageHeader title="Menus" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="flex mb">
        <label htmlFor="menu-select">Select a menu to edit:</label>
        <select id="menu-select" value={menuId || ''} onChange={(e) => (e.target.value ? selectMenu(menus.find((m) => m.id === Number(e.target.value))) : (setMenuId(null), setItems([]), setName(''), setLocations('')))}>
          <option value="">— Create a new menu —</option>{menus.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      <div className="edit-layout" style={{ gridTemplateColumns: '280px minmax(0, 1fr)' }}>
        <div>
          {sourceBox('Pages', sources.pages, (x) => ({ title: decodeHtml(x.title.rendered), type: 'post_type', object: 'page', object_id: x.id, url: '' }))}
          {sourceBox('Posts', sources.posts, (x) => ({ title: decodeHtml(x.title.rendered), type: 'post_type', object: 'post', object_id: x.id, url: '' }))}
          {sourceBox('Product categories', sources.product_cats, (x) => ({ title: decodeHtml(x.name), type: 'taxonomy', object: 'product_cat', object_id: x.id, url: '' }))}
          {sourceBox('Categories', sources.categories, (x) => ({ title: decodeHtml(x.name), type: 'taxonomy', object: 'category', object_id: x.id, url: '' }))}
          <Postbox title="Custom Links">
            <div className="field"><label>URL</label><input type="url" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} placeholder="https://" /></div>
            <div className="field"><label>Link Text</label><input type="text" value={custom.title} onChange={(e) => setCustom({ ...custom, title: e.target.value })} /></div>
            <button type="button" className="button" onClick={() => { if (custom.url) { add({ title: custom.title || custom.url, url: custom.url, type: 'custom', object: 'custom', object_id: 0 }); setCustom({ url: '', title: '' }); } }}>Add to Menu</button>
          </Postbox>
        </div>
        <div>
          <Postbox title="Menu structure">
            <div className="grid-2 mb">
              <div className="field"><label>Menu Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="field"><label>Display locations (comma-separated)</label><input type="text" value={locations} onChange={(e) => setLocations(e.target.value)} placeholder="primary, footer" /></div>
            </div>
            {items.map((it, i) => (
              <div key={it.id || `n${i}`} className="variation" style={{ marginLeft: depth(it) * 28 }}>
                <div className="variation-head">
                  <input type="text" value={it.title} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} aria-label="Navigation label" style={{ flex: 1 }} />
                  {it.type === 'custom' && <input type="url" value={it.url} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} aria-label="URL" />}
                  <span className="muted">{it.type === 'custom' ? 'Custom Link' : it.object}</span>
                  <button type="button" className="button button-small" onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                  <button type="button" className="button button-small" onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  <button type="button" className="button button-small" onClick={() => indent(i, 1)} disabled={!it.id || i === 0 || !items[i - 1].id} title="Make sub-item (save new items first)">→</button>
                  <button type="button" className="button button-small" onClick={() => indent(i, -1)} aria-label="Out one level">←</button>
                  <label className="inline"><input type="checkbox" checked={it.target === '_blank'} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, target: e.target.checked ? '_blank' : '' } : x)))} /> New tab</label>
                  <button type="button" className="button-link-delete" onClick={() => { if (it.id) setDeleted((d) => [...d, it.id]); setItems(items.filter((_, j) => j !== i)); }}>Remove</button>
                </div>
              </div>
            ))}
            {!items.length && <p className="muted">Add menu items from the column on the left.</p>}
            <div className="flex mt" style={{ justifyContent: 'space-between' }}>
              {menuId ? <button type="button" className="button-link-delete" onClick={() => confirmDelete(`menu "${name}"`) && api.del(wp(`menus/${menuId}`)).then(() => { setMenuId(null); setItems([]); loadMenus(); })}>Delete Menu</button> : <span />}
              <button type="button" className="button button-primary" disabled={!name.trim()} onClick={save}>{menuId ? 'Save Menu' : 'Create Menu'}</button>
            </div>
          </Postbox>
        </div>
      </div>
    </>
  );
}
