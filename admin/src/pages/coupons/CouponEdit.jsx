import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fetchAll, wc } from '../../api';
import { useNotice } from '../../hooks';
import { decodeHtml, toDateInput } from '../../format';
import { Loading, Notice, PageHeader, Postbox } from '../../components/ui';

const EMPTY = {
  code: '', description: '', discount_type: 'fixed_cart', amount: '', free_shipping: false, date_expires: '', status: 'publish',
  minimum_amount: '', maximum_amount: '', individual_use: false, exclude_sale_items: false, product_ids: [], excluded_product_ids: [],
  product_categories: [], excluded_product_categories: [], email_restrictions: [], usage_limit: null, limit_usage_to_x_items: null, usage_limit_per_user: null,
};
const Row = ({ label, children, tip }) => <div className="options-row"><label>{label}</label><div>{children}{tip && <p className="description">{tip}</p>}</div></div>;
const ids = (s) => String(s).split(',').map((x) => parseInt(x.trim(), 10)).filter(Boolean);
// Comma-separated list input that parses on blur (so typing "12, " isn't swallowed)
function ListInput({ value, onChange, parse = ids, placeholder }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);
  return <input type="text" value={text} placeholder={placeholder} style={{ width: '100%' }} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(parse(text))} />;
}
const emails = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

export default function CouponEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [c, setC] = useState(isNew ? EMPTY : null);
  const [tab, setTab] = useState('general');
  const [cats, setCats] = useState([]);
  const [notice, showNotice, closeNotice] = useNotice();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetchAll(wc('products/categories')).then(setCats).catch(() => {});
    if (!isNew) api.get(wc(`coupons/${id}`)).then((x) => setC({ ...x, minimum_amount: Number(x.minimum_amount) ? x.minimum_amount : '', maximum_amount: Number(x.maximum_amount) ? x.maximum_amount : '' })).catch((e) => showNotice('error', e.message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <><Notice notice={notice} onClose={closeNotice} /><Loading /></>;
  const set = (patch) => setC((x) => ({ ...x, ...patch }));
  const generate = () => set({ code: Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('') });

  const save = async () => {
    if (!c.code.trim()) { showNotice('error', 'Please enter a coupon code.'); return; }
    setSaving(true);
    try {
      const body = {
        code: c.code, description: c.description, discount_type: c.discount_type, amount: String(c.amount || 0), free_shipping: c.free_shipping, status: c.status,
        date_expires: c.date_expires ? `${toDateInput(c.date_expires)}T23:59:59` : null, minimum_amount: String(c.minimum_amount || ''), maximum_amount: String(c.maximum_amount || ''),
        individual_use: c.individual_use, exclude_sale_items: c.exclude_sale_items, product_ids: c.product_ids, excluded_product_ids: c.excluded_product_ids,
        product_categories: c.product_categories, excluded_product_categories: c.excluded_product_categories, email_restrictions: c.email_restrictions,
        usage_limit: c.usage_limit || null, limit_usage_to_x_items: c.limit_usage_to_x_items || null, usage_limit_per_user: c.usage_limit_per_user || null,
      };
      const saved = isNew ? await api.post(wc('coupons'), body) : await api.put(wc(`coupons/${id}`), body);
      showNotice('success', isNew ? 'Coupon published.' : 'Coupon updated.');
      if (isNew) navigate(`/coupons/${saved.id}`, { replace: true }); else setC({ ...saved, minimum_amount: Number(saved.minimum_amount) ? saved.minimum_amount : '', maximum_amount: Number(saved.maximum_amount) ? saved.maximum_amount : '' });
    } catch (e) { showNotice('error', e.message); } finally { setSaving(false); }
  };

  const catSelect = (key) => (
    <select multiple size={6} value={c[key].map(String)} onChange={(e) => set({ [key]: [...e.target.selectedOptions].map((o) => Number(o.value)) })} style={{ width: '100%' }}>
      {cats.map((x) => <option key={x.id} value={x.id}>{decodeHtml(x.name)}</option>)}
    </select>
  );

  return (
    <>
      <PageHeader title={isNew ? 'Add coupon' : 'Edit coupon'} action="Add coupon" actionTo="/coupons/new" />
      <Notice notice={notice} onClose={closeNotice} />
      <div className="edit-layout">
        <div>
          <div className="flex mb"><input className="title-input" style={{ marginBottom: 0, flex: 1 }} placeholder="Coupon code" value={c.code} onChange={(e) => set({ code: e.target.value })} aria-label="Coupon code" />
            <button type="button" className="button" onClick={generate}>Generate coupon code</button></div>
          <div className="field"><textarea rows={2} placeholder="Description (optional)" value={c.description} onChange={(e) => set({ description: e.target.value })} aria-label="Description" /></div>
          <div className="postbox">
            <div className="postbox-header">Coupon data</div>
            <div className="product-data">
              <ul className="tabs">{[['general', 'General'], ['restriction', 'Usage restriction'], ['limits', 'Usage limits']].map(([k, l]) => <li key={k} className={tab === k ? 'active' : ''}><button type="button" onClick={() => setTab(k)}>{l}</button></li>)}</ul>
              <div className="panel">
                {tab === 'general' && <>
                  <Row label="Discount type"><select value={c.discount_type} onChange={(e) => set({ discount_type: e.target.value })}><option value="percent">Percentage discount</option><option value="fixed_cart">Fixed cart discount</option><option value="fixed_product">Fixed product discount</option></select></Row>
                  <Row label="Coupon amount"><input type="text" inputMode="decimal" value={c.amount} onChange={(e) => set({ amount: e.target.value })} /></Row>
                  <Row label="Allow free shipping" tip="A free shipping method must be enabled in your shipping zone and set to require a valid free shipping coupon."><input type="checkbox" checked={c.free_shipping} onChange={(e) => set({ free_shipping: e.target.checked })} /></Row>
                  <Row label="Coupon expiry date" tip="The coupon expires at 23:59 on this date."><input type="date" value={toDateInput(c.date_expires)} onChange={(e) => set({ date_expires: e.target.value })} /></Row>
                </>}
                {tab === 'restriction' && <>
                  <Row label="Minimum spend"><input type="text" inputMode="decimal" value={c.minimum_amount} placeholder="No minimum" onChange={(e) => set({ minimum_amount: e.target.value })} /></Row>
                  <Row label="Maximum spend"><input type="text" inputMode="decimal" value={c.maximum_amount} placeholder="No maximum" onChange={(e) => set({ maximum_amount: e.target.value })} /></Row>
                  <Row label="Individual use only"><label className="inline"><input type="checkbox" checked={c.individual_use} onChange={(e) => set({ individual_use: e.target.checked })} /> Cannot be used in conjunction with other coupons</label></Row>
                  <Row label="Exclude sale items"><label className="inline"><input type="checkbox" checked={c.exclude_sale_items} onChange={(e) => set({ exclude_sale_items: e.target.checked })} /> Not applied to items on sale</label></Row>
                  <Row label="Products (IDs)"><ListInput value={c.product_ids} onChange={(product_ids) => set({ product_ids })} placeholder="e.g. 12, 34" /></Row>
                  <Row label="Exclude products (IDs)"><ListInput value={c.excluded_product_ids} onChange={(excluded_product_ids) => set({ excluded_product_ids })} /></Row>
                  <Row label="Product categories" tip="Ctrl/Cmd-click to select several.">{catSelect('product_categories')}</Row>
                  <Row label="Exclude categories">{catSelect('excluded_product_categories')}</Row>
                  <Row label="Allowed emails" tip="Comma-separated. Wildcards like *@gmail.com are allowed."><ListInput value={c.email_restrictions} parse={emails} onChange={(email_restrictions) => set({ email_restrictions })} /></Row>
                </>}
                {tab === 'limits' && <>
                  <Row label="Usage limit per coupon"><input type="number" min={0} value={c.usage_limit || ''} placeholder="Unlimited usage" onChange={(e) => set({ usage_limit: Number(e.target.value) || null })} /></Row>
                  <Row label="Limit usage to X items"><input type="number" min={0} value={c.limit_usage_to_x_items || ''} placeholder="Apply to all qualifying items in cart" onChange={(e) => set({ limit_usage_to_x_items: Number(e.target.value) || null })} /></Row>
                  <Row label="Usage limit per user"><input type="number" min={0} value={c.usage_limit_per_user || ''} placeholder="Unlimited usage" onChange={(e) => set({ usage_limit_per_user: Number(e.target.value) || null })} /></Row>
                  {!isNew && <Row label="Used so far">{c.usage_count} time(s)</Row>}
                </>}
              </div>
            </div>
          </div>
        </div>
        <div>
          <Postbox title="Publish">
            <div className="field"><label>Status</label><select value={c.status} onChange={(e) => set({ status: e.target.value })}><option value="publish">Published</option><option value="draft">Draft</option></select></div>
            <button type="button" className="button button-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : isNew ? 'Publish' : 'Update'}</button>
          </Postbox>
        </div>
      </div>
    </>
  );
}
