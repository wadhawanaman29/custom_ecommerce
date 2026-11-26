import { useEffect, useState } from 'react';
import { api, wc } from '../../api';
import { useNotice } from '../../hooks';
import { STATUS_LABELS } from '../../format';
import { Loading, Notice, PageHeader } from '../../components/ui';

const STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];

function StatusChecks({ value, onChange }) {
  return (
    <div>{STATUSES.map((s) => (
      <label key={s} className="inline" style={{ minWidth: 150 }}>
        <input type="checkbox" checked={value.includes(s)} onChange={() => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s])} /> {STATUS_LABELS[s]}
      </label>
    ))}</div>
  );
}

export default function AnalyticsSettings() {
  const [settings, setSettings] = useState(null);
  const [notice, showNotice, closeNotice] = useNotice();
  useEffect(() => {
    api.get(wc('settings/analytics')).then((list) => setSettings(Object.fromEntries(list.map((s) => [s.id, s])))).catch((e) => showNotice('error', e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!settings) return <><PageHeader title="Analytics settings" /><Notice notice={notice} onClose={closeNotice} /><Loading /></>;
  const val = (id) => settings[id].value;
  const set = (id, value) => setSettings({ ...settings, [id]: { ...settings[id], value } });
  const arr = (id) => (Array.isArray(val(id)) ? val(id).map((x) => String(x).replace(/^wc-/, '')) : []);
  const save = async () => {
    try {
      await api.post(wc('settings/analytics/batch'), { update: Object.values(settings).map((s) => ({ id: s.id, value: s.value })) });
      showNotice('success', 'Settings saved. Reports now use the new statuses.');
    } catch (e) { showNotice('error', e.message); }
  };
  return (
    <>
      <PageHeader title="Analytics settings" />
      <Notice notice={notice} onClose={closeNotice} />
      <table className="form-table"><tbody>
        <tr><th>Excluded statuses</th><td><StatusChecks value={arr('woocommerce_excluded_report_order_statuses')} onChange={(v) => set('woocommerce_excluded_report_order_statuses', v)} />
          <p className="description">Orders with these statuses are excluded from the totals in your reports. Default: Pending payment, Failed, Cancelled.</p></td></tr>
        <tr><th>Actionable statuses</th><td><StatusChecks value={arr('woocommerce_actionable_order_statuses')} onChange={(v) => set('woocommerce_actionable_order_statuses', v)} />
          <p className="description">Orders with these statuses require action on behalf of the store admin.</p></td></tr>
        <tr><th>Default date range</th><td>
          <select value={val('woocommerce_default_date_range')} onChange={(e) => set('woocommerce_default_date_range', e.target.value)}>
            {Object.entries(settings.woocommerce_default_date_range.options || {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td></tr>
      </tbody></table>
      <button type="button" className="button button-primary" onClick={save}>Save settings</button>
    </>
  );
}
