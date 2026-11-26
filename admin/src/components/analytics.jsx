import { useEffect, useMemo, useRef, useState } from 'react';
import { price } from '../format';

// ───────── Dates (local, YYYY-MM-DD) ─────────
const pad = (x) => String(x).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const endOfMonth = (y, m) => new Date(y, m + 1, 0);
const clampDay = (y, m, day) => new Date(y, m, Math.min(day, endOfMonth(y, m).getDate()));
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

export const PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Week to date'], ['last_week', 'Last week'],
  ['month', 'Month to date'], ['last_month', 'Last month'], ['quarter', 'Quarter to date'], ['last_quarter', 'Last quarter'],
  ['year', 'Year to date'], ['last_year', 'Last year'],
];

// Primary range for a preset, plus WooCommerce's "previous period" for it
function presetRange(period, today) {
  const t = today;
  const y = t.getFullYear();
  const m = t.getMonth();
  const q = Math.floor(m / 3) * 3;
  switch (period) {
    case 'today': return [[t, t], [addDays(t, -1), addDays(t, -1)]];
    case 'yesterday': { const d = addDays(t, -1); return [[d, d], [addDays(d, -1), addDays(d, -1)]]; }
    case 'week': { const s = mondayOf(t); return [[s, t], [addDays(s, -7), addDays(t, -7)]]; }
    case 'last_week': { const s = addDays(mondayOf(t), -7); return [[s, addDays(s, 6)], [addDays(s, -7), addDays(s, -1)]]; }
    case 'month': return [[new Date(y, m, 1), t], [new Date(y, m - 1, 1), clampDay(y, m - 1, t.getDate())]];
    case 'last_month': return [[new Date(y, m - 1, 1), endOfMonth(y, m - 1)], [new Date(y, m - 2, 1), endOfMonth(y, m - 2)]];
    case 'quarter': {
      const s = new Date(y, q, 1);
      const ps = new Date(y, q - 3, 1);
      return [[s, t], [ps, addDays(ps, Math.min(daysBetween(s, t), daysBetween(ps, addDays(s, -1))))]];
    }
    case 'last_quarter': return [[new Date(y, q - 3, 1), addDays(new Date(y, q, 1), -1)], [new Date(y, q - 6, 1), addDays(new Date(y, q - 3, 1), -1)]];
    case 'year': return [[new Date(y, 0, 1), t], [new Date(y - 1, 0, 1), clampDay(y - 1, m, t.getDate())]];
    case 'last_year': return [[new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)], [new Date(y - 2, 0, 1), new Date(y - 2, 11, 31)]];
    default: return null;
  }
}

const shortRange = (a, b) => {
  const sameYear = a.getFullYear() === b.getFullYear();
  const sameMonth = sameYear && a.getMonth() === b.getMonth();
  const mo = (d) => d.toLocaleString(undefined, { month: 'short' });
  if (a.getTime() === b.getTime()) return `${mo(a)} ${a.getDate()}, ${a.getFullYear()}`;
  if (sameMonth) return `${mo(a)} ${a.getDate()} - ${b.getDate()}, ${b.getFullYear()}`;
  if (sameYear) return `${mo(a)} ${a.getDate()} - ${mo(b)} ${b.getDate()}, ${b.getFullYear()}`;
  return `${mo(a)} ${a.getDate()}, ${a.getFullYear()} - ${mo(b)} ${b.getDate()}, ${b.getFullYear()}`;
};

export function computeRanges({ period, compare, after, before }) {
  const today = parseYmd(ymd(new Date()));
  let primary;
  let previous;
  let label;
  if (period === 'custom' && after && before) {
    const a = parseYmd(after);
    const b = parseYmd(before);
    primary = [a, b];
    const len = daysBetween(a, b);
    previous = [addDays(a, -len - 1), addDays(a, -1)];
    label = 'Custom';
  } else {
    const p = presetRange(period, today) || presetRange('month', today);
    [primary, previous] = p;
    label = (PRESETS.find((x) => x[0] === period) || PRESETS[4])[1];
  }
  if (compare === 'previous_year') {
    previous = primary.map((d) => clampDay(d.getFullYear() - 1, d.getMonth(), d.getDate()));
  }
  const days = daysBetween(primary[0], primary[1]) + 1;
  return {
    current: { after: ymd(primary[0]), before: ymd(primary[1]) },
    previous: { after: ymd(previous[0]), before: ymd(previous[1]) },
    label: `${label} (${shortRange(primary[0], primary[1])})`,
    compareLabel: `vs. ${compare === 'previous_year' ? 'Previous year' : 'Previous period'} (${shortRange(previous[0], previous[1])})`,
    days,
    defaultInterval: days <= 31 ? 'day' : days <= 92 ? 'week' : days <= 400 ? 'month' : 'quarter',
  };
}

export const intervalsFor = (days) => [['day', 'By day'], ['week', 'By week'], ['month', 'By month'], ['quarter', 'By quarter'], ['year', 'By year']]
  .filter(([k]) => ({ day: days <= 400, week: days > 7, month: days > 27, quarter: days > 85, year: days > 360 })[k]);

// ───────── Date range picker ─────────
export function DateRangeFilter({ value, onChange, ranges }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(value.period === 'custom' ? 'custom' : 'presets');
  const [draft, setDraft] = useState(value);
  const ref = useRef();
  useEffect(() => { if (open) { setDraft(value); setTab(value.period === 'custom' ? 'custom' : 'presets'); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const valid = draft.period !== 'custom' || (draft.after && draft.before && draft.after <= draft.before);
  return (
    <div className="date-range" ref={ref}>
      <span className="muted">Date range:</span>
      <button type="button" className="date-range-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="primary">{ranges.label}</span>
        <span className="secondary">{ranges.compareLabel}</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="date-range-pop">
          <div className="muted" style={{ textAlign: 'center', fontSize: 11, padding: 8, textTransform: 'uppercase' }}>Select a date range</div>
          <div className="seg">
            <button type="button" className={tab === 'presets' ? 'on' : ''} onClick={() => { setTab('presets'); if (draft.period === 'custom') setDraft({ ...draft, period: 'month' }); }}>Presets</button>
            <button type="button" className={tab === 'custom' ? 'on' : ''} onClick={() => { setTab('custom'); setDraft({ ...draft, period: 'custom', after: draft.after || ranges.current.after, before: draft.before || ranges.current.before }); }}>Custom</button>
          </div>
          {tab === 'presets' ? (
            <div className="preset-grid">
              {PRESETS.map(([k, l]) => <button key={k} type="button" className={draft.period === k ? 'on' : ''} onClick={() => setDraft({ ...draft, period: k })}>{l}</button>)}
            </div>
          ) : (
            <div className="flex" style={{ padding: 12 }}>
              <input type="date" value={draft.after || ''} max={draft.before || undefined} onChange={(e) => setDraft({ ...draft, after: e.target.value })} aria-label="Start date" />
              <span>to</span>
              <input type="date" value={draft.before || ''} min={draft.after || undefined} onChange={(e) => setDraft({ ...draft, before: e.target.value })} aria-label="End date" />
            </div>
          )}
          <div className="muted" style={{ textAlign: 'center', fontSize: 11, padding: 8, textTransform: 'uppercase', borderTop: '1px solid var(--border-light)' }}>Compare to</div>
          <div className="preset-grid">
            <button type="button" className={draft.compare !== 'previous_year' ? 'on' : ''} onClick={() => setDraft({ ...draft, compare: 'previous_period' })}>Previous period</button>
            <button type="button" className={draft.compare === 'previous_year' ? 'on' : ''} onClick={() => setDraft({ ...draft, compare: 'previous_year' })}>Previous year</button>
          </div>
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button type="button" className="button button-primary" disabled={!valid} onClick={() => { onChange({ ...draft, interval: '' }); setOpen(false); }}>Update</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────── Formatting ─────────
export const fmt = {
  money: (v) => price(v),
  number: (v) => Number(v || 0).toLocaleString(),
  decimal: (v) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }),
};
export function delta(cur, prev) {
  if (prev === undefined || prev === null) return null;
  const c = Number(cur || 0);
  const p = Number(prev || 0);
  if (p === 0) return c === 0 ? 0 : null;
  return Math.round(((c - p) / Math.abs(p)) * 100);
}

// ───────── Summary numbers (cards) ─────────
// metrics: [{ key, label, format: 'money'|'number'|'decimal', lowerIsBetter? }]
export function SummaryNumbers({ metrics, totals, previous, selected, onSelect }) {
  return (
    <div className="summary-numbers">
      {metrics.map((m) => {
        const d = previous ? delta(totals[m.key], previous[m.key]) : null;
        const good = d === null || d === 0 ? null : (d > 0) !== !!m.lowerIsBetter;
        return (
          <button key={m.key} type="button" className={`summary-number ${selected === m.key ? 'selected' : ''}`} onClick={() => onSelect && onSelect(m.key)}>
            <span className="label">{m.label}</span>
            <span className="row">
              <span className="value">{fmt[m.format || 'money'](totals[m.key])}</span>
              {d !== null && <span className={`delta ${good === null ? '' : good ? 'up' : 'down'}`}>{d > 0 ? '+' : ''}{d}%</span>}
            </span>
            {previous && <span className="prev muted">Previous: {fmt[m.format || 'money'](previous[m.key])}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ───────── Chart (two series, line or bar) ─────────
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
};

export function ReportChart({ labels, current, previous, format = 'money', currentLabel, previousLabel, type = 'line' }) {
  const [hover, setHover] = useState(null);
  const wrap = useRef();
  const W = 1000;
  const H = 280;
  const L = 64;
  const R = 16;
  const T = 16;
  const B = 34;
  const n = labels.length;
  const max = niceMax(Math.max(0, ...current, ...(previous || [])));
  const x = (i) => (n <= 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (1 - Number(v || 0) / max) * (H - T - B);
  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const step = Math.max(1, Math.ceil(n / 10));
  const bw = Math.max(2, Math.min(28, ((W - L - R) / Math.max(n, 1)) * 0.35));
  const onMove = (e) => {
    const rect = wrap.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = n <= 1 ? 0 : Math.round(((px - L) / (W - L - R)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const short = (v) => (format === 'money' ? price(v).replace(/\.00$/, '') : fmt.number(v));
  return (
    <div className="report-chart" ref={wrap} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Report chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#e0e0e0" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {type === 'bar' ? labels.map((_, i) => (
          <g key={i}>
            {previous && <rect x={x(i) - bw} y={y(previous[i])} width={bw} height={H - B - y(previous[i])} fill="#5ec27e" opacity="0.8" />}
            <rect x={previous ? x(i) : x(i) - bw / 2} y={y(current[i])} width={bw} height={H - B - y(current[i])} fill="#1e4d8f" />
          </g>
        )) : (
          <>
            {previous && <path d={path(previous)} fill="none" stroke="#5ec27e" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
            <path d={path(current)} fill="none" stroke="#1e4d8f" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            {n <= 62 && current.map((v, i) => <circle key={`c${i}`} cx={x(i)} cy={y(v)} r="3.5" fill="#1e4d8f" />)}
            {previous && n <= 62 && previous.map((v, i) => <circle key={`p${i}`} cx={x(i)} cy={y(v)} r="3.5" fill="#5ec27e" />)}
          </>
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#999" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="#999" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-yaxis">{ticks.map((t) => <span key={t} style={{ top: `${(y(t) / H) * 100}%` }}>{short(t)}</span>)}</div>
      <div className="chart-xaxis">{labels.map((l, i) => (i % step === 0 || i === n - 1) && <span key={i} style={{ left: `${(x(i) / W) * 100}%` }}>{l}</span>)}</div>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, transform: x(hover) > W * 0.7 ? 'translateX(-105%)' : 'translateX(8px)' }}>
          <strong>{labels[hover]}</strong>
          <div><span className="dot" style={{ background: '#1e4d8f' }} /> {currentLabel}: {fmt[format](current[hover])}</div>
          {previous && <div><span className="dot" style={{ background: '#5ec27e' }} /> {previousLabel}: {fmt[format](previous[hover])}</div>}
        </div>
      )}
    </div>
  );
}

// ───────── Report table (client-side sort/pagination + CSV) ─────────
// columns: [{ key, label, render?, value?, numeric?, format?, sortable? }]
export function ReportTable({
  title, columns, rows, defaultSort, summary, csvName, serverPage, emptyText = 'No data recorded for the selected time period.',
}) {
  const [sort, setSort] = useState(defaultSort || { key: columns[0].key, order: 'desc' });
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  useEffect(() => setPage(1), [rows]);
  const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);
  const sorted = useMemo(() => {
    if (serverPage) return rows;
    const c = columns.find((x) => x.key === sort.key);
    if (!c) return rows;
    return [...rows].sort((a, b) => {
      const va = valueOf(c, a);
      const vb = valueOf(c, b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''));
      return sort.order === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns, serverPage]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = serverPage ? serverPage.total : sorted.length;
  const pp = serverPage ? serverPage.perPage : perPage;
  const pg = serverPage ? serverPage.page : page;
  const pages = Math.max(1, Math.ceil(total / pp));
  const visible = serverPage ? sorted : sorted.slice((pg - 1) * pp, pg * pp);
  const onSort = (c) => {
    if (c.sortable === false) return;
    const next = { key: c.key, order: sort.key === c.key && sort.order === 'desc' ? 'asc' : 'desc' };
    setSort(next);
    if (serverPage && serverPage.onSort) serverPage.onSort(next);
  };
  const goto = (p) => (serverPage ? serverPage.onPage(p) : setPage(p));
  const download = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [columns.map((c) => esc(c.label)).join(','), ...sorted.map((r) => columns.map((c) => esc(c.csv ? c.csv(r) : valueOf(c, r))).join(','))];
    const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${csvName || 'report'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="report-table postbox">
      <div className="postbox-header">
        <span>{title}</span>
        <button type="button" className="button button-small" onClick={download} disabled={!rows.length} title={serverPage ? 'Downloads the rows on this page' : 'Download all rows as CSV'}>⬇ Download</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="wp-list-table" style={{ border: 0 }}>
          <thead><tr>{columns.map((c) => (
            <th key={c.key} className={`${c.numeric ? 'right' : ''} ${c.sortable === false ? '' : 'sortable'}`} onClick={() => onSort(c)} aria-sort={sort.key === c.key ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}
              style={sort.key === c.key ? { background: '#f0f0f1' } : undefined}>
              {sort.key === c.key && c.sortable !== false ? (sort.order === 'asc' ? '▴ ' : '▾ ') : ''}{c.label}
            </th>
          ))}</tr></thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={r.id || r.key || i}>{columns.map((c) => <td key={c.key} className={c.numeric ? 'right' : ''} style={sort.key === c.key ? { background: 'rgba(0,0,0,.025)' } : undefined}>{c.render ? c.render(r) : c.format ? fmt[c.format](valueOf(c, r)) : valueOf(c, r)}</td>)}</tr>
            ))}
            {!visible.length && <tr className="empty"><td colSpan={columns.length}>{emptyText}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="report-pager">
        <span>Page {pg} of {pages}</span>
        <button type="button" className="button button-small" disabled={pg <= 1} onClick={() => goto(pg - 1)} aria-label="Previous page">‹</button>
        <button type="button" className="button button-small" disabled={pg >= pages} onClick={() => goto(pg + 1)} aria-label="Next page">›</button>
        <label className="inline">Go to page <input type="number" className="small-text" min={1} max={pages} value={pg} onChange={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= pages) goto(v); }} /></label>
        {!serverPage && <label className="inline">Rows per page <select value={perPage} onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}>{[25, 50, 75, 100].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>}
      </div>
      {summary && <div className="report-summary">{summary.map(([v, l]) => <span key={l}><strong>{v}</strong> {l}</span>)}</div>}
    </div>
  );
}
