import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

export function Notice({ notice, onClose }) {
  if (!notice) return null;
  return (
    <div className={`notice notice-${notice.type}`}>
      <span dangerouslySetInnerHTML={{ __html: notice.message }} />
      <button type="button" onClick={onClose} aria-label="Dismiss">×</button>
    </div>
  );
}

export const Spinner = () => <span className="spinner" />;
export const Loading = ({ text = 'Loading…' }) => <div className="loading"><Spinner /> {text}</div>;

export function PageHeader({ title, action, actionTo, onAction, children }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {actionTo && <Link className="page-title-action" to={actionTo}>{action}</Link>}
      {onAction && <button type="button" className="page-title-action" onClick={onAction}>{action}</button>}
      {children}
    </div>
  );
}

export function Postbox({ title, children, actions }) {
  return (
    <div className="postbox">
      {title && <div className="postbox-header"><span>{title}</span>{actions}</div>}
      <div className="inside">{children}</div>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, width }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-label={title}>
        <div className="modal-header"><h2>{title}</h2><button type="button" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// Status filter links ("All (10) | Published (8) | Draft (2)")
export function StatusLinks({ items, value, onChange }) {
  return (
    <ul className="subsubsub">
      {items.map((it) => (
        <li key={it.value}>
          <a href="#" className={value === it.value ? 'current' : ''} onClick={(e) => { e.preventDefault(); onChange(it.value); }}>
            {it.label}{it.count !== undefined && <span className="muted"> ({it.count})</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Pagination({ page, totalPages, total, onPage }) {
  const p = Number(page) || 1;
  return (
    <div className="tablenav-pages">
      <span>{total} item{total === 1 ? '' : 's'}</span>
      {totalPages > 1 && (
        <>
          <button type="button" className="button button-small" disabled={p <= 1} onClick={() => onPage(1)}>«</button>
          <button type="button" className="button button-small" disabled={p <= 1} onClick={() => onPage(p - 1)}>‹</button>
          <span>{p} of {totalPages}</span>
          <button type="button" className="button button-small" disabled={p >= totalPages} onClick={() => onPage(p + 1)}>›</button>
          <button type="button" className="button button-small" disabled={p >= totalPages} onClick={() => onPage(totalPages)}>»</button>
        </>
      )}
    </div>
  );
}

export function SearchBox({ value, onSearch, placeholder = 'Search' }) {
  const [v, setV] = useState(value || '');
  useEffect(() => setV(value || ''), [value]);
  return (
    <form className="flex" onSubmit={(e) => { e.preventDefault(); onSearch(v); }}>
      <input type="search" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} />
      <button type="submit" className="button">{placeholder}</button>
    </form>
  );
}

// Generic WP list table: columns [{key,label,render,sortable,className}], bulk actions, selection
export function ListTable({ columns, items, loading, error, rowKey = 'id', bulkActions, onBulk, sort, onSort, empty = 'No items found.' }) {
  const [selected, setSelected] = useState([]);
  const [bulk, setBulk] = useState('');
  useEffect(() => setSelected([]), [items]);
  const allChecked = items.length > 0 && selected.length === items.length;
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const header = (
    <tr>
      {bulkActions && <td className="check-column"><input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? [] : items.map((i) => i[rowKey]))} aria-label="Select all" /></td>}
      {columns.map((c) => (
        <th key={c.key} className={`${c.className || ''} ${c.sortable ? 'sortable' : ''}`} style={c.width ? { width: c.width } : undefined}
          onClick={c.sortable && onSort ? () => onSort(c.sortKey || c.key) : undefined}>
          {c.label}{sort && c.sortable && sort.orderby === (c.sortKey || c.key) ? (sort.order === 'asc' ? ' ▲' : ' ▼') : ''}
        </th>
      ))}
    </tr>
  );
  return (
    <>
      {bulkActions && (
        <div className="tablenav">
          <div className="actions">
            <select value={bulk} onChange={(e) => setBulk(e.target.value)} aria-label="Bulk actions">
              <option value="">Bulk actions</option>
              {bulkActions.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
            <button type="button" className="button" disabled={!bulk || !selected.length} onClick={() => { onBulk(bulk, selected); setBulk(''); }}>Apply</button>
            {selected.length > 0 && <span className="muted">{selected.length} selected</span>}
          </div>
        </div>
      )}
      <table className="wp-list-table">
        <thead>{header}</thead>
        <tbody>
          {loading && <tr className="empty"><td colSpan={columns.length + 1}><Spinner /></td></tr>}
          {!loading && error && <tr className="empty"><td colSpan={columns.length + 1} style={{ color: 'var(--danger)' }}>{error}</td></tr>}
          {!loading && !error && !items.length && <tr className="empty"><td colSpan={columns.length + 1}>{empty}</td></tr>}
          {!loading && !error && items.map((it) => (
            <tr key={it[rowKey]}>
              {bulkActions && <th className="check-column"><input type="checkbox" checked={selected.includes(it[rowKey])} onChange={() => toggle(it[rowKey])} aria-label="Select row" /></th>}
              {columns.map((c) => <td key={c.key} className={c.className}>{c.render ? c.render(it) : it[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
        <tfoot>{header}</tfoot>
      </table>
    </>
  );
}

// Hierarchical checkbox list (categories)
export function TermChecklist({ terms, value, onChange }) {
  const tree = useMemo(() => {
    const byParent = new Map();
    for (const t of terms) {
      const p = t.parent || 0;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(t);
    }
    return byParent;
  }, [terms]);
  const ids = new Set(terms.map((t) => t.id));
  const render = (parent) => (tree.get(parent) || []).map((t) => (
    <li key={t.id}>
      <label><input type="checkbox" checked={value.includes(t.id)} onChange={() => onChange(value.includes(t.id) ? value.filter((x) => x !== t.id) : [...value, t.id])} /> {decodeEntities(t.name)}</label>
      {tree.has(t.id) && <ul>{render(t.id)}</ul>}
    </li>
  ));
  // Orphans whose parent isn't loaded are rendered at root
  const roots = [...(tree.get(0) || []), ...terms.filter((t) => t.parent && !ids.has(t.parent))];
  return <ul className="categorychecklist">{roots.map((t) => (
    <li key={t.id}>
      <label><input type="checkbox" checked={value.includes(t.id)} onChange={() => onChange(value.includes(t.id) ? value.filter((x) => x !== t.id) : [...value, t.id])} /> {decodeEntities(t.name)}</label>
      {tree.has(t.id) && <ul>{render(t.id)}</ul>}
    </li>
  ))}</ul>;
}

export function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = String(s ?? '');
  return el.value;
}

// Tag-style input: type + Enter to add
export function TagInput({ value, onChange, suggestions = [], placeholder = 'Add tag' }) {
  const [v, setV] = useState('');
  const add = () => {
    const name = v.trim();
    if (name && !value.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      const found = suggestions.find((s) => s.name.toLowerCase() === name.toLowerCase());
      onChange([...value, found || { name }]);
    }
    setV('');
  };
  return (
    <div>
      <div className="flex">
        <input type="text" list="tag-suggestions" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} />
        <button type="button" className="button" onClick={add}>Add</button>
        <datalist id="tag-suggestions">{suggestions.map((s) => <option key={s.id} value={decodeEntities(s.name)} />)}</datalist>
      </div>
      <div className="mt">{value.map((t) => (
        <span key={t.id || t.name} className="tag-chip">{decodeEntities(t.name)}<button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t.name}`}>×</button></span>
      ))}</div>
    </div>
  );
}

export function confirmDelete(what = 'this item') {
  // eslint-disable-next-line no-alert
  return window.confirm(`Are you sure you want to permanently delete ${what}? This cannot be undone.`);
}
