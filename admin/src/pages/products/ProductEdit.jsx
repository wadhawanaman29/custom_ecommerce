import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, custom, fetchAll, wc } from '../../api';
import { useNotice } from '../../hooks';
import { decodeHtml, fromLocalInput, toDateInput, toLocalInput } from '../../format';
import { useContentTypes } from '../../contentTypes';
import { FieldGroups, groupsFor } from '../../components/fields';
import { AddonsPanel, BrandsBox, FacebookPanel, ReviewsBox, SeoBox } from './ProductExtras';
import Editor from '../../components/Editor';
import { ImageField, MediaPicker } from '../../components/media';
import {
  Loading, Notice, PageHeader, Postbox, TagInput, TermChecklist, confirmDelete,
} from '../../components/ui';

const EMPTY = {
  name: '', slug: '', type: 'simple', status: 'draft', featured: false, catalog_visibility: 'visible', description: '', short_description: '',
  sku: '', regular_price: '', sale_price: '', date_on_sale_from: '', date_on_sale_to: '', virtual: false, downloadable: false, downloads: [],
  download_limit: -1, download_expiry: -1, external_url: '', button_text: '', tax_status: 'taxable', tax_class: '', manage_stock: false,
  stock_quantity: null, stock_status: 'instock', backorders: 'no', low_stock_amount: null, sold_individually: false, weight: '',
  dimensions: { length: '', width: '', height: '' }, shipping_class: '', reviews_allowed: true, upsell_ids: [], cross_sell_ids: [],
  grouped_products: [], purchase_note: '', menu_order: 0, categories: [], tags: [], images: [], attributes: [], default_attributes: [], variations: [],
  global_unique_id: '', brands: [], acf: {}, seo: {}, addons: [], exclude_global: false, facebook: { sync: true, visibility: true },
};
const STD_STATUSES = [['publish', 'Published'], ['draft', 'Draft'], ['pending', 'Pending Review'], ['private', 'Private']];
const ucfirst = (x) => x.charAt(0).toUpperCase() + x.slice(1);

// Searchable multi-product picker (upsells, cross-sells, grouped)
function ProductPicker({ value, onChange, exclude }) {
  const [names, setNames] = useState({});
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    const missing = value.filter((id) => !names[id]);
    if (missing.length) api.get(wc('products'), { include: missing.join(','), per_page: 100, _fields: 'id,name' }).then((r) => setNames((n) => ({ ...n, ...Object.fromEntries(r.map((p) => [p.id, p.name])) }))).catch(() => {});
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (term.length < 2) { setResults([]); return undefined; }
    const t = setTimeout(() => api.get(wc('products'), { search: term, per_page: 10, _fields: 'id,name,sku' }).then(setResults).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [term]);
  return (
    <div style={{ position: 'relative' }}>
      <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search for a product…" style={{ width: '100%' }} />
      {results.length > 0 && (
        <ul className="postbox" style={{ position: 'absolute', zIndex: 5, width: '100%', margin: 0, padding: 0, listStyle: 'none', maxHeight: 220, overflow: 'auto' }}>
          {results.filter((p) => p.id !== exclude && !value.includes(p.id)).map((p) => (
            <li key={p.id}><a href="#" style={{ display: 'block', padding: '6px 10px' }} onClick={(e) => { e.preventDefault(); setNames((n) => ({ ...n, [p.id]: p.name })); onChange([...value, p.id]); setTerm(''); setResults([]); }}>{decodeHtml(p.name)} {p.sku && <span className="muted">({p.sku})</span>}</a></li>
          ))}
        </ul>
      )}
      <div className="mt">{value.map((id) => <span key={id} className="tag-chip">{decodeHtml(names[id] || `#${id}`)}<button type="button" onClick={() => onChange(value.filter((x) => x !== id))} aria-label="Remove">×</button></span>)}</div>
    </div>
  );
}

const Row = ({ label, children, tip }) => (
  <div className="options-row"><label>{label}</label><div>{children}{tip && <p className="description">{tip}</p>}</div></div>
);

// "Red | Dark Blue" textarea for custom attributes — parsed on blur so spaces/pipes can be typed
function OptionsText({ value, onChange }) {
  const [text, setText] = useState(value.join(' | '));
  useEffect(() => setText(value.join(' | ')), [value]);
  return <textarea rows={3} value={text} placeholder='Enter values separated by "|"' onChange={(e) => setText(e.target.value)}
    onBlur={() => onChange(text.split('|').map((s) => s.trim()).filter(Boolean))} />;
}

function cartesian(lists) {
  return lists.reduce((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);
}

export default function ProductEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [p, setP] = useState(isNew ? EMPTY : null);
  const [vars, setVars] = useState([]);
  const [deletedVars, setDeletedVars] = useState([]);
  const [openVar, setOpenVar] = useState(null);
  const [tab, setTab] = useState('general');
  const [notice, showNotice, closeNotice] = useNotice();
  const [saving, setSaving] = useState(false);
  const [cats, setCats] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [taxClasses, setTaxClasses] = useState([{ slug: '', name: 'Standard' }]);
  const [shipClasses, setShipClasses] = useState([]);
  const [globalAttrs, setGlobalAttrs] = useState([]);
  const [attrTerms, setAttrTerms] = useState({});
  const [gallery, setGallery] = useState(false);
  const [newCat, setNewCat] = useState('');
  const [newAttr, setNewAttr] = useState('0');
  const [brands, setBrands] = useState([]);
  const [extraStatuses, setExtraStatuses] = useState([]);
  const { registry } = useContentTypes();

  useEffect(() => {
    fetchAll(wc('products/categories')).then(setCats).catch(() => {});
    fetchAll(wc('products/tags')).then(setAllTags).catch(() => {});
    api.get(wc('taxes/classes')).then((c) => setTaxClasses(c.map((x) => ({ slug: x.slug === 'standard' ? '' : x.slug, name: x.name })))).catch(() => {});
    fetchAll(wc('products/shipping_classes')).then(setShipClasses).catch(() => {});
    api.get(wc('products/attributes')).then(setGlobalAttrs).catch(() => {});
    fetchAll(wc('products/brands')).then(setBrands).catch(() => {});
    // Custom post statuses in use on the site (e.g. redirect, protection)
    api.get(custom('admin/plugins/products/status-counts')).then((c) => setExtraStatuses(Object.keys(c).filter((k) => !['all', 'trash', 'auto-draft', 'future', ...STD_STATUSES.map((x) => x[0])].includes(k)))).catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) { setP(EMPTY); setVars([]); return; }
    setP(null);
    api.get(wc(`products/${id}`)).then((prod) => {
      setP(prod);
      if (prod.type === 'variable') fetchAll(wc(`products/${id}/variations`), { status: 'any' }).then(setVars).catch(() => {});
      for (const a of prod.attributes) if (a.id) loadTerms(a.id);
    }).catch((e) => showNotice('error', e.message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTerms = (attrId) => {
    if (attrTerms[attrId]) return;
    fetchAll(wc(`products/attributes/${attrId}/terms`)).then((t) => setAttrTerms((s) => ({ ...s, [attrId]: t }))).catch(() => {});
  };

  const set = (patch) => setP((x) => ({ ...x, ...patch }));
  const setVar = (i, patch) => setVars((vs) => vs.map((v, idx) => (idx === i ? { ...v, ...patch, _dirty: true } : v)));
  const variationAttrs = useMemo(() => (p ? p.attributes.filter((a) => a.variation) : []), [p]);
  // ACF "post_taxonomy" rules use "taxonomy:slug"
  const termKeys = p ? p.categories.map((c) => `product_cat:${c.slug || (cats.find((x) => x.id === c.id) || {}).slug}`).join(',') : '';
  const groups = useMemo(() => groupsFor(registry, { post_type: 'product', terms: termKeys ? termKeys.split(',') : [] }), [registry, termKeys]);

  if (!p) return <><Notice notice={notice} onClose={closeNotice} /><Loading /></>;

  const addCategory = async () => {
    if (!newCat.trim()) return;
    try {
      const c = await api.post(wc('products/categories'), { name: newCat.trim() });
      setCats((cs) => [...cs, c]);
      set({ categories: [...p.categories, { id: c.id, name: c.name }] });
      setNewCat('');
    } catch (e) { showNotice('error', e.message); }
  };

  const addAttribute = () => {
    const gid = Number(newAttr);
    if (gid && p.attributes.some((a) => a.id === gid)) return;
    const g = globalAttrs.find((a) => a.id === gid);
    if (gid) loadTerms(gid);
    set({ attributes: [...p.attributes, { id: gid, name: g ? g.name : '', position: p.attributes.length, visible: true, variation: p.type === 'variable', options: [] }] });
  };
  const setAttr = (i, patch) => set({ attributes: p.attributes.map((a, idx) => (idx === i ? { ...a, ...patch } : a)) });

  const generateVariations = () => {
    const lists = variationAttrs.map((a) => a.options.map((o) => ({ id: a.id, name: a.name, option: o })));
    if (!lists.length || lists.some((l) => !l.length)) { showNotice('error', 'Add attribute values marked "Used for variations" first (and save the attributes).'); return; }
    const existing = new Set(vars.map((v) => JSON.stringify(v.attributes.map((a) => a.option))));
    const combos = cartesian(lists).filter((c) => !existing.has(JSON.stringify(c.map((a) => a.option))));
    if (combos.length > 100) { showNotice('error', `That would create ${combos.length} variations; the limit is 100 at a time.`); return; }
    setVars((vs) => [...vs, ...combos.map((attrs) => ({ attributes: attrs, regular_price: '', sale_price: '', sku: '', status: 'publish', manage_stock: false, stock_quantity: null, stock_status: 'instock', _dirty: true, _new: true }))]);
    showNotice('success', `${combos.length} variation(s) added. Set prices, then click Update.`);
  };

  const payload = () => {
    const body = { ...p };
    ['id', 'permalink', 'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'price', 'price_html', 'on_sale', 'purchasable', 'total_sales',
      'backorders_allowed', 'backordered', 'shipping_required', 'shipping_taxable', 'shipping_class_id', 'average_rating', 'rating_count', 'related_ids', 'parent_id',
      'variations', 'has_options', 'post_password', '_links', 'date_on_sale_from_gmt', 'date_on_sale_to_gmt', 'meta_data', 'out_of_stock_date', 'exclude_global',
      'date_created', 'date_created_gmt'].forEach((k) => delete body[k]);
    if (p._dateChanged && p.date_created) body.date_created = p.date_created;
    delete body._dateChanged;
    body.brands = (p.brands || []).map((b) => ({ id: b.id }));
    body.exclude_global_addons = !!p.exclude_global;
    const names = new Set(groups.flatMap((g) => (g.fields || []).map((f) => f.name)));
    body.acf = Object.fromEntries(Object.entries(p.acf || {}).filter(([k]) => names.has(k)));
    body.categories = p.categories.map((c) => ({ id: c.id }));
    body.images = p.images.map((img) => ({ id: img.id }));
    body.date_on_sale_from = p.date_on_sale_from || null;
    body.date_on_sale_to = p.date_on_sale_to ? `${toDateInput(p.date_on_sale_to)}T23:59:59` : null;
    return body;
  };

  const save = async (statusOverride) => {
    if (!p.name.trim()) { showNotice('error', 'Please enter a product name.'); return; }
    setSaving(true);
    try {
      // New tags are created first so they can be attached by ID
      const tags = [];
      for (const t of p.tags) tags.push(t.id ? { id: t.id } : { id: (await api.post(wc('products/tags'), { name: t.name })).id });
      const body = { ...payload(), tags, ...(statusOverride ? { status: statusOverride } : {}) };
      const saved = isNew ? await api.post(wc('products'), body) : await api.put(wc(`products/${id}`), body);
      if (saved.type === 'variable') {
        const create = vars.filter((v) => v._new).map(varPayload);
        const update = vars.filter((v) => v._dirty && !v._new).map((v) => ({ id: v.id, ...varPayload(v) }));
        if (create.length || update.length || deletedVars.length) {
          const r = await api.post(wc(`products/${saved.id}/variations/batch`), { create, update, delete: deletedVars });
          const errors = [...(r.create || []), ...(r.update || [])].filter((x) => x.error).map((x) => x.error.message);
          if (errors.length) showNotice('error', `Some variations failed: ${errors.join('; ')}`);
        }
        setDeletedVars([]);
      }
      showNotice('success', isNew ? 'Product published.' : 'Product updated.');
      if (isNew) navigate(`/products/${saved.id}`, { replace: true });
      else {
        const fresh = await api.get(wc(`products/${id}`));
        setP(fresh);
        if (fresh.type === 'variable') setVars(await fetchAll(wc(`products/${id}/variations`), { status: 'any' }));
      }
    } catch (e) {
      showNotice('error', e.message);
    } finally { setSaving(false); }
  };

  const varPayload = (v) => ({
    attributes: v.attributes.map((a) => ({ id: a.id, name: a.name, option: a.option })), sku: v.sku || '', regular_price: v.regular_price ?? '', sale_price: v.sale_price ?? '',
    status: v.status, manage_stock: v.manage_stock, stock_quantity: v.manage_stock ? Number(v.stock_quantity || 0) : null, stock_status: v.stock_status,
    backorders: v.backorders || 'no', weight: v.weight || '', dimensions: v.dimensions || { length: '', width: '', height: '' }, description: v.description || '',
    shipping_class: v.shipping_class || '', tax_class: v.tax_class || '', virtual: !!v.virtual, downloadable: !!v.downloadable,
    image: v.image && v.image.id ? { id: v.image.id } : null,
  });

  const copyToDraft = async () => {
    try {
      const copy = { ...payload(), name: `${p.name} (Copy)`, status: 'draft', sku: '', slug: '', global_unique_id: '' };
      delete copy.date_created;
      const created = await api.post(wc('products'), copy);
      if (p.type === 'variable' && vars.length) {
        await api.post(wc(`products/${created.id}/variations/batch`), { create: vars.map((v) => ({ ...varPayload(v), sku: '' })) });
      }
      navigate(`/products/${created.id}`);
      showNotice('success', 'Draft copy created.');
    } catch (e) { showNotice('error', e.message); }
  };

  const trash = async () => {
    try { await api.del(wc(`products/${id}`)); navigate('/products'); } catch (e) { showNotice('error', e.message); }
  };

  const tabs = [
    ['general', 'General', p.type !== 'grouped' && p.type !== 'variable'],
    ['inventory', 'Inventory', true],
    ['shipping', 'Shipping', !p.virtual && p.type !== 'grouped' && p.type !== 'external'],
    ['linked', 'Linked Products', true],
    ['attributes', 'Attributes', true],
    ['variations', 'Variations', p.type === 'variable'],
    ['advanced', 'Advanced', true],
    ['facebook', 'Facebook', true],
    ['addons', 'Add-ons', true],
  ].filter((t) => t[2]);
  const activeTab = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];

  return (
    <>
      <PageHeader title={isNew ? 'Add new product' : 'Edit product'} action="Add New" actionTo="/products/new" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout">
        <div>
          <input className="title-input" placeholder="Product name" value={decodeHtml(p.name)} onChange={(e) => set({ name: e.target.value })} aria-label="Product name" />
          <p className="flex"><strong>Slug:</strong> <input type="text" value={p.slug} onChange={(e) => set({ slug: e.target.value })} placeholder="auto-generated" style={{ width: 320 }} aria-label="Slug" />
            {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer">View product</a>}</p>
          <Postbox title="Description"><Editor value={p.description} onChange={(description) => set({ description })} /></Postbox>

          <div className="postbox">
            <div className="postbox-header">
              <span className="flex">Product data —
                <select value={p.type} onChange={(e) => set({ type: e.target.value })} aria-label="Product type">
                  <option value="simple">Simple product</option><option value="grouped">Grouped product</option>
                  <option value="external">External/Affiliate product</option><option value="variable">Variable product</option>
                </select>
                {(p.type === 'simple' || p.type === 'variable') && <>
                  <label className="inline"><input type="checkbox" checked={p.virtual} onChange={(e) => set({ virtual: e.target.checked })} /> Virtual</label>
                  <label className="inline"><input type="checkbox" checked={p.downloadable} onChange={(e) => set({ downloadable: e.target.checked })} /> Downloadable</label>
                </>}
              </span>
            </div>
            <div className="product-data">
              <ul className="tabs">{tabs.map(([k, label]) => <li key={k} className={activeTab === k ? 'active' : ''}><button type="button" onClick={() => setTab(k)}>{label}</button></li>)}</ul>
              <div className="panel">
                {activeTab === 'general' && <>
                  {p.type === 'external' && <>
                    <Row label="Product URL"><input type="url" value={p.external_url} onChange={(e) => set({ external_url: e.target.value })} placeholder="https://" style={{ width: '100%' }} /></Row>
                    <Row label="Button text"><input type="text" value={p.button_text} onChange={(e) => set({ button_text: e.target.value })} placeholder="Buy product" /></Row>
                  </>}
                  <Row label="Regular price"><input type="text" inputMode="decimal" value={p.regular_price} onChange={(e) => set({ regular_price: e.target.value })} /></Row>
                  <Row label="Sale price"><input type="text" inputMode="decimal" value={p.sale_price} onChange={(e) => set({ sale_price: e.target.value })} /></Row>
                  <Row label="Sale price dates" tip="Leave empty for no schedule. The sale ends at 23:59 on the end date.">
                    <span className="flex"><input type="date" value={toDateInput(p.date_on_sale_from)} onChange={(e) => set({ date_on_sale_from: e.target.value ? fromLocalInput(`${e.target.value}T00:00`) : '' })} aria-label="Sale from" />
                      <input type="date" value={toDateInput(p.date_on_sale_to)} onChange={(e) => set({ date_on_sale_to: e.target.value })} aria-label="Sale to" /></span>
                  </Row>
                  {p.downloadable && <Row label="Downloadable files">
                    {p.downloads.map((d, i) => (
                      <div key={d.id || i} className="flex mb">
                        <input type="text" placeholder="File name" value={d.name} onChange={(e) => set({ downloads: p.downloads.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                        <input type="url" placeholder="https://" value={d.file} onChange={(e) => set({ downloads: p.downloads.map((x, j) => (j === i ? { ...x, file: e.target.value } : x)) })} style={{ flex: 1 }} />
                        <button type="button" className="button-link-delete" onClick={() => set({ downloads: p.downloads.filter((_, j) => j !== i) })}>Remove</button>
                      </div>
                    ))}
                    <button type="button" className="button" onClick={() => set({ downloads: [...p.downloads, { name: '', file: '' }] })}>Add File</button>
                    <div className="grid-2 mt"><div className="field"><label>Download limit</label><input type="number" value={p.download_limit} onChange={(e) => set({ download_limit: Number(e.target.value) })} /></div>
                      <div className="field"><label>Download expiry (days)</label><input type="number" value={p.download_expiry} onChange={(e) => set({ download_expiry: Number(e.target.value) })} /></div></div>
                  </Row>}
                  <Row label="Tax status"><select value={p.tax_status} onChange={(e) => set({ tax_status: e.target.value })}><option value="taxable">Taxable</option><option value="shipping">Shipping only</option><option value="none">None</option></select></Row>
                  <Row label="Tax class"><select value={p.tax_class} onChange={(e) => set({ tax_class: e.target.value })}>{taxClasses.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}</select></Row>
                </>}

                {activeTab === 'inventory' && <>
                  <Row label="SKU"><input type="text" value={p.sku} onChange={(e) => set({ sku: e.target.value })} /></Row>
                  <Row label="GTIN, UPC, EAN, or ISBN" tip="Enter a barcode or any other identifier unique to this product. It can help you list this product on other channels or marketplaces.">
                    <input type="text" value={p.global_unique_id || ''} onChange={(e) => set({ global_unique_id: e.target.value.replace(/[^0-9-]/g, '') })} />
                  </Row>
                  {p.out_of_stock_date && <Row label="Out of stock date"><span>{p.out_of_stock_date.replace('T', ' ')}</span></Row>}
                  {p.type !== 'external' && <Row label="Stock management"><label className="inline"><input type="checkbox" checked={p.manage_stock} onChange={(e) => set({ manage_stock: e.target.checked })} /> Track stock quantity for this product</label></Row>}
                  {p.manage_stock ? <>
                    <Row label="Quantity"><input type="number" value={p.stock_quantity ?? 0} onChange={(e) => set({ stock_quantity: Number(e.target.value) })} /></Row>
                    <Row label="Allow backorders?"><select value={p.backorders} onChange={(e) => set({ backorders: e.target.value })}><option value="no">Do not allow</option><option value="notify">Allow, but notify customer</option><option value="yes">Allow</option></select></Row>
                    <Row label="Low stock threshold"><input type="number" value={p.low_stock_amount ?? ''} placeholder="Store-wide threshold" onChange={(e) => set({ low_stock_amount: e.target.value === '' ? null : Number(e.target.value) })} /></Row>
                  </> : p.type !== 'variable' && p.type !== 'grouped' && (
                    <Row label="Stock status"><select value={p.stock_status} onChange={(e) => set({ stock_status: e.target.value })}><option value="instock">In stock</option><option value="outofstock">Out of stock</option><option value="onbackorder">On backorder</option></select></Row>
                  )}
                  <Row label="Sold individually"><label className="inline"><input type="checkbox" checked={p.sold_individually} onChange={(e) => set({ sold_individually: e.target.checked })} /> Limit purchases to 1 item per order</label></Row>
                </>}

                {activeTab === 'shipping' && <>
                  <Row label="Weight"><input type="text" inputMode="decimal" value={p.weight} onChange={(e) => set({ weight: e.target.value })} /></Row>
                  <Row label="Dimensions (L×W×H)"><span className="flex">{['length', 'width', 'height'].map((d) => <input key={d} type="text" className="small-text" placeholder={d} value={p.dimensions[d]} onChange={(e) => set({ dimensions: { ...p.dimensions, [d]: e.target.value } })} aria-label={d} />)}</span></Row>
                  <Row label="Shipping class"><select value={p.shipping_class} onChange={(e) => set({ shipping_class: e.target.value })}><option value="">No shipping class</option>{shipClasses.map((c) => <option key={c.id} value={c.slug}>{decodeHtml(c.name)}</option>)}</select></Row>
                </>}

                {activeTab === 'linked' && <>
                  {p.type === 'grouped' && <Row label="Grouped products"><ProductPicker value={p.grouped_products} onChange={(grouped_products) => set({ grouped_products })} exclude={p.id} /></Row>}
                  <Row label="Upsells"><ProductPicker value={p.upsell_ids} onChange={(upsell_ids) => set({ upsell_ids })} exclude={p.id} /></Row>
                  <Row label="Cross-sells"><ProductPicker value={p.cross_sell_ids} onChange={(cross_sell_ids) => set({ cross_sell_ids })} exclude={p.id} /></Row>
                </>}

                {activeTab === 'attributes' && <>
                  <div className="flex mb">
                    <select value={newAttr} onChange={(e) => setNewAttr(e.target.value)} aria-label="Attribute">
                      <option value="0">Custom product attribute</option>
                      {globalAttrs.map((a) => <option key={a.id} value={a.id} disabled={p.attributes.some((x) => x.id === a.id)}>{a.name}</option>)}
                    </select>
                    <button type="button" className="button" onClick={addAttribute}>Add</button>
                  </div>
                  {p.attributes.map((a, i) => (
                    <div key={`${a.id}-${i}`} className="variation">
                      <div className="variation-head"><strong>{a.name || 'Custom attribute'}</strong><button type="button" className="button-link-delete" style={{ marginLeft: 'auto' }} onClick={() => set({ attributes: p.attributes.filter((_, j) => j !== i) })}>Remove</button></div>
                      <div className="variation-body grid-2">
                        <div>
                          {!a.id && <div className="field"><label>Name</label><input type="text" value={a.name} onChange={(e) => setAttr(i, { name: e.target.value })} /></div>}
                          <label className="inline"><input type="checkbox" checked={a.visible} onChange={(e) => setAttr(i, { visible: e.target.checked })} /> Visible on the product page</label>
                          {p.type === 'variable' && <label className="inline"><input type="checkbox" checked={a.variation} onChange={(e) => setAttr(i, { variation: e.target.checked })} /> Used for variations</label>}
                        </div>
                        <div className="field">
                          <label>Value(s)</label>
                          {a.id ? (
                            <div className="categorychecklist" style={{ maxHeight: 140 }}>
                              {(attrTerms[a.id] || []).map((t) => (
                                <label key={t.id}><input type="checkbox" checked={a.options.includes(t.name)} onChange={() => setAttr(i, { options: a.options.includes(t.name) ? a.options.filter((o) => o !== t.name) : [...a.options, t.name] })} /> {decodeHtml(t.name)}</label>
                              ))}
                              {attrTerms[a.id] && !attrTerms[a.id].length && <span className="muted">No terms. <Link to={`/products/attributes/${a.id}`}>Add terms</Link></span>}
                            </div>
                          ) : (
                            <OptionsText value={a.options} onChange={(options) => setAttr(i, { options })} />
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {!p.attributes.length && <p className="muted">Add descriptive pieces of information that customers can use to search for this product, like "Color" or "Size".</p>}
                </>}

                {activeTab === 'variations' && <>
                  {!variationAttrs.length ? <p className="muted">Before you can add a variation, add some attributes on the Attributes tab and tick "Used for variations".</p> : <>
                    <div className="flex mb">
                      <button type="button" className="button" onClick={generateVariations}>Generate variations</button>
                      <button type="button" className="button" onClick={() => setVars((vs) => [...vs, { attributes: variationAttrs.map((a) => ({ id: a.id, name: a.name, option: '' })), regular_price: '', sale_price: '', sku: '', status: 'publish', manage_stock: false, stock_status: 'instock', _new: true, _dirty: true }])}>Add manually</button>
                      <span className="muted">{vars.length} variation(s)</span>
                    </div>
                    {p.attributes.some((a) => a.variation) && (
                      <div className="flex mb"><strong>Default form values:</strong>
                        {variationAttrs.map((a) => (
                          <select key={a.name} value={(p.default_attributes.find((d) => d.name === a.name) || {}).option || ''} aria-label={`Default ${a.name}`}
                            onChange={(e) => set({ default_attributes: [...p.default_attributes.filter((d) => d.name !== a.name), ...(e.target.value ? [{ id: a.id, name: a.name, option: e.target.value }] : [])] })}>
                            <option value="">No default {a.name}…</option>{a.options.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ))}
                      </div>
                    )}
                    {vars.map((v, i) => (
                      <div key={v.id || `new-${i}`} className="variation">
                        <div className="variation-head" onClick={() => setOpenVar(openVar === i ? null : i)}>
                          <strong>#{v.id || 'new'}</strong>
                          {variationAttrs.map((a) => {
                            const cur = (v.attributes.find((x) => x.name === a.name) || {}).option || '';
                            return (
                              <select key={a.name} value={cur} onClick={(e) => e.stopPropagation()} aria-label={a.name}
                                onChange={(e) => setVar(i, { attributes: [...v.attributes.filter((x) => x.name !== a.name), { id: a.id, name: a.name, option: e.target.value }] })}>
                                <option value="">Any {a.name}…</option>{a.options.map((o) => <option key={o} value={o}>{o}</option>)}
                              </select>
                            );
                          })}
                          <span className="muted" style={{ marginLeft: 'auto' }}>{v.regular_price ? `Price ${v.sale_price || v.regular_price}` : 'No price'}{v.status !== 'publish' ? ' · disabled' : ''}</span>
                          <button type="button" className="button-link-delete" onClick={(e) => { e.stopPropagation(); if (v.id) setDeletedVars((d) => [...d, v.id]); setVars((vs) => vs.filter((_, j) => j !== i)); }}>Remove</button>
                        </div>
                        {openVar === i && (
                          <div className="variation-body">
                            <div className="grid-3">
                              <div className="field"><label>Image</label><ImageField value={v.image} onChange={(image) => setVar(i, { image })} /></div>
                              <div className="field"><label>SKU</label><input type="text" value={v.sku || ''} onChange={(e) => setVar(i, { sku: e.target.value })} placeholder={p.sku} /></div>
                              <div>
                                <label className="inline"><input type="checkbox" checked={v.status === 'publish'} onChange={(e) => setVar(i, { status: e.target.checked ? 'publish' : 'private' })} /> Enabled</label>
                                <label className="inline"><input type="checkbox" checked={!!v.manage_stock} onChange={(e) => setVar(i, { manage_stock: e.target.checked })} /> Manage stock?</label>
                                <label className="inline"><input type="checkbox" checked={!!v.virtual} onChange={(e) => setVar(i, { virtual: e.target.checked })} /> Virtual</label>
                              </div>
                            </div>
                            <div className="grid-2">
                              <div className="field"><label>Regular price</label><input type="text" inputMode="decimal" value={v.regular_price || ''} onChange={(e) => setVar(i, { regular_price: e.target.value })} /></div>
                              <div className="field"><label>Sale price</label><input type="text" inputMode="decimal" value={v.sale_price || ''} onChange={(e) => setVar(i, { sale_price: e.target.value })} /></div>
                              {v.manage_stock ? <>
                                <div className="field"><label>Stock quantity</label><input type="number" value={v.stock_quantity ?? 0} onChange={(e) => setVar(i, { stock_quantity: Number(e.target.value) })} /></div>
                                <div className="field"><label>Allow backorders?</label><select value={v.backorders || 'no'} onChange={(e) => setVar(i, { backorders: e.target.value })}><option value="no">Do not allow</option><option value="notify">Allow, but notify customer</option><option value="yes">Allow</option></select></div>
                              </> : (
                                <div className="field"><label>Stock status</label><select value={v.stock_status} onChange={(e) => setVar(i, { stock_status: e.target.value })}><option value="instock">In stock</option><option value="outofstock">Out of stock</option><option value="onbackorder">On backorder</option></select></div>
                              )}
                              <div className="field"><label>Weight</label><input type="text" value={v.weight || ''} onChange={(e) => setVar(i, { weight: e.target.value })} placeholder={p.weight} /></div>
                              <div className="field"><label>Dimensions (L×W×H)</label><span className="flex">{['length', 'width', 'height'].map((d) => <input key={d} type="text" className="small-text" placeholder={p.dimensions[d] || d} value={(v.dimensions || {})[d] || ''} onChange={(e) => setVar(i, { dimensions: { length: '', width: '', height: '', ...(v.dimensions || {}), [d]: e.target.value } })} aria-label={d} />)}</span></div>
                              <div className="field"><label>Shipping class</label><select value={v.shipping_class || ''} onChange={(e) => setVar(i, { shipping_class: e.target.value })}><option value="">Same as parent</option>{shipClasses.map((c) => <option key={c.id} value={c.slug}>{decodeHtml(c.name)}</option>)}</select></div>
                              <div className="field"><label>Tax class</label><select value={v.tax_class || ''} onChange={(e) => setVar(i, { tax_class: e.target.value })}>{taxClasses.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}</select></div>
                            </div>
                            <div className="field"><label>Description</label><textarea rows={2} value={v.description || ''} onChange={(e) => setVar(i, { description: e.target.value })} /></div>
                          </div>
                        )}
                      </div>
                    ))}
                    {(vars.some((v) => v._dirty) || deletedVars.length > 0) && <p className="description">Unsaved variation changes — click Update to save.</p>}
                  </>}
                </>}

                {activeTab === 'advanced' && <>
                  <Row label="Purchase note"><textarea rows={3} value={p.purchase_note} onChange={(e) => set({ purchase_note: e.target.value })} /></Row>
                  <Row label="Menu order"><input type="number" value={p.menu_order} onChange={(e) => set({ menu_order: Number(e.target.value) })} /></Row>
                  <Row label="Enable reviews"><input type="checkbox" checked={p.reviews_allowed} onChange={(e) => set({ reviews_allowed: e.target.checked })} /></Row>
                </>}

                {activeTab === 'facebook' && <FacebookPanel value={p.facebook} onChange={(facebook) => set({ facebook })} price={p.sale_price || p.regular_price} />}

                {activeTab === 'addons' && <AddonsPanel addons={p.addons} excludeGlobal={p.exclude_global}
                  onChange={(patch) => set({ ...(patch.addons ? { addons: patch.addons } : {}), ...('exclude_global_addons' in patch ? { exclude_global: patch.exclude_global_addons } : {}) })} />}
              </div>
            </div>
          </div>

          <Postbox title="Product short description"><Editor value={p.short_description} onChange={(short_description) => set({ short_description })} /></Postbox>
          <FieldGroups groups={groups} values={p.acf || {}} onChange={(acf) => set({ acf })} registry={registry} />
          <SeoBox seo={p.seo} onChange={(seo) => set({ seo })} name={decodeHtml(p.name)} slug={p.slug} onSlug={(slug) => set({ slug })} excerpt={p.short_description || p.description} permalink={p.permalink} />
          {!isNew && <ReviewsBox productId={p.id} onError={(m) => showNotice('error', m)} />}
        </div>

        <div>
          <Postbox title="Publish">
            {!isNew && <div className="flex mb" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="button" disabled={saving} onClick={() => save('draft')}>Save Draft</button>
              <a className="button" href={p.permalink} target="_blank" rel="noreferrer">{p.status === 'publish' ? 'View' : 'Preview'}</a>
            </div>}
            <div className="field"><label>Status</label>
              <select value={p.status} onChange={(e) => set({ status: e.target.value })}>
                {STD_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                {[...new Set([...extraStatuses, ...(STD_STATUSES.some((x) => x[0] === p.status) ? [] : [p.status])])].map((v) => <option key={v} value={v}>{ucfirst(v)}</option>)}
              </select></div>
            <div className="field"><label>{isNew ? 'Publish' : p.status === 'publish' ? 'Published on' : 'Created on'}</label>
              <input type="datetime-local" value={toLocalInput(p.date_created)} onChange={(e) => set({ date_created: fromLocalInput(e.target.value), _dateChanged: true })} />
              {isNew && !p.date_created && <p className="description">Leave empty to publish immediately.</p>}
            </div>
            <div className="field"><label>Catalog visibility</label>
              <select value={p.catalog_visibility} onChange={(e) => set({ catalog_visibility: e.target.value })}><option value="visible">Shop and search results</option><option value="catalog">Shop only</option><option value="search">Search results only</option><option value="hidden">Hidden</option></select></div>
            <label className="inline mb"><input type="checkbox" checked={p.featured} onChange={(e) => set({ featured: e.target.checked })} /> This is a featured product</label>
            <div className="flex" style={{ justifyContent: 'space-between', marginTop: 10 }}>
              {!isNew ? <span className="flex" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <a href="#" onClick={(e) => { e.preventDefault(); copyToDraft(); }}>Copy to a new draft</a>
                <button type="button" className="button-link-delete" onClick={() => confirmDelete('nothing — it will move to the Trash') && trash()}>Move to Trash</button>
              </span> : <button type="button" className="button" disabled={saving} onClick={() => save('draft')}>Save Draft</button>}
              <button type="button" className="button button-primary" disabled={saving} onClick={() => save(isNew && p.status === 'draft' ? 'publish' : undefined)}>{saving ? 'Saving…' : isNew ? 'Publish' : 'Update'}</button>
            </div>
          </Postbox>
          <Postbox title="Product categories">
            <TermChecklist terms={cats} value={p.categories.map((c) => c.id)} onChange={(ids) => set({ categories: ids.map((cid) => cats.find((c) => c.id === cid) || { id: cid }) })} />
            <div className="flex mt"><input type="text" value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="New category name" style={{ flex: 1 }} /><button type="button" className="button" onClick={addCategory}>Add</button></div>
            {p.categories.length > 1 && (
              <div className="field mt"><label>Primary category (Yoast)</label>
                <select value={(p.seo || {}).primary_category || ''} onChange={(e) => set({ seo: { ...(p.seo || {}), primary_category: Number(e.target.value) || 0 } })}>
                  <option value="">— Not set —</option>
                  {p.categories.map((c) => <option key={c.id} value={c.id}>{decodeHtml(c.name || (cats.find((x) => x.id === c.id) || {}).name || String(c.id))}</option>)}
                </select>
              </div>
            )}
          </Postbox>
          <BrandsBox brands={brands} value={(p.brands || []).map((b) => b.id)} onChange={(ids) => set({ brands: ids.map((bid) => brands.find((b) => b.id === bid) || { id: bid }) })}
            onCreated={(b) => setBrands((bs) => [...bs, b])} onError={(m) => showNotice('error', m)} />
          <Postbox title="Product tags"><TagInput value={p.tags} onChange={(tags) => set({ tags })} suggestions={allTags} /></Postbox>
          <Postbox title="Product image">
            <ImageField value={p.images[0]} label="Set product image" onChange={(img) => set({ images: img ? [img, ...p.images.slice(1)] : p.images.slice(1) })} />
          </Postbox>
          <Postbox title="Product gallery">
            <div className="image-grid">
              {p.images.slice(1).map((img, i) => (
                <div key={img.id} className="tile"><img src={img.src} alt="" /><button type="button" className="remove" onClick={() => set({ images: p.images.filter((_, j) => j !== i + 1) })} aria-label="Remove">×</button></div>
              ))}
            </div>
            <a href="#" className="mt" style={{ display: 'inline-block' }} onClick={(e) => { e.preventDefault(); setGallery(true); }}>Add product gallery images</a>
            {gallery && <MediaPicker multiple title="Add images to product gallery" onClose={() => setGallery(false)} onSelect={(ms) => {
              const add = ms.filter((m) => !p.images.some((x) => x.id === m.id)).map((m) => ({ id: m.id, src: m.source_url }));
              set({ images: p.images.length ? [...p.images, ...add] : [...add] });
              setGallery(false);
            }} />}
          </Postbox>
        </div>
      </div>
    </>
  );
}
