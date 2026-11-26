import { useRef, useState } from 'react';
import { api, wp } from '../api';
import { useCollection } from '../hooks';
import { Modal, Pagination, Spinner } from './ui';

export const thumbOf = (m) => {
  if (!m) return '';
  const sizes = m.media_details && m.media_details.sizes;
  return (sizes && (sizes.thumbnail || sizes.medium || sizes.woocommerce_thumbnail) || {}).source_url || m.source_url || m.src || '';
};

export async function uploadFiles(files, onProgress) {
  const out = [];
  for (const f of files) {
    const fd = new FormData();
    fd.append('file', f);
    out.push(await api.post(wp('media'), fd));
    if (onProgress) onProgress(out.length, files.length);
  }
  return out;
}

export function UploadButton({ onUploaded, multiple = true, accept = 'image/*', label = 'Upload files' }) {
  const ref = useRef();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const onChange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    setError('');
    try {
      const items = await uploadFiles(files, (n, t) => setBusy(`Uploading ${n}/${t}…`));
      onUploaded(items);
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  };
  return (
    <span className="flex">
      <input ref={ref} type="file" multiple={multiple} accept={accept} hidden onChange={onChange} />
      <button type="button" className="button" disabled={!!busy} onClick={() => ref.current.click()}>{busy || label}</button>
      {busy && <Spinner />}
      {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
    </span>
  );
}

// Media library modal: pick one or many images (returns media objects)
export function MediaPicker({ multiple = false, onSelect, onClose, title = 'Select media' }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);
  const { items, total, totalPages, loading, reload } = useCollection(wp('media'), { per_page: 40, page, search, media_type: 'image' });
  const toggle = (m) => {
    if (!multiple) { setSelected([m]); return; }
    setSelected((s) => (s.some((x) => x.id === m.id) ? s.filter((x) => x.id !== m.id) : [...s, m]));
  };
  return (
    <Modal title={title} onClose={onClose}
      footer={(
        <>
          <span className="muted" style={{ marginRight: 'auto' }}>{selected.length} selected</span>
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="button" className="button button-primary" disabled={!selected.length} onClick={() => onSelect(multiple ? selected : selected[0])}>Select</button>
        </>
      )}>
      <div className="tablenav">
        <UploadButton onUploaded={(ms) => { setSelected((s) => (multiple ? [...s, ...ms] : [ms[0]])); reload(); }} />
        <form className="flex" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(e.target.q.value); }}>
          <input type="search" name="q" placeholder="Search media" />
        </form>
      </div>
      {loading ? <div className="loading"><Spinner /></div> : (
        <div className="image-grid">
          {items.map((m) => (
            <div key={m.id} className={`tile ${selected.some((x) => x.id === m.id) ? 'selected' : ''}`} onClick={() => toggle(m)} title={m.title?.rendered}>
              {thumbOf(m) ? <img src={thumbOf(m)} alt={m.alt_text || ''} loading="lazy" /> : m.title?.rendered}
            </div>
          ))}
          {!items.length && <p className="muted">No media found.</p>}
        </div>
      )}
      <div className="tablenav"><span /><Pagination page={page} total={total} totalPages={totalPages} onPage={setPage} /></div>
    </Modal>
  );
}

// Single image field (featured image / category image)
export function ImageField({ value, onChange, label = 'Set image' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="featured-image">
      {value && value.src && <img src={value.src} alt="" />}
      <div className="flex">
        <a href="#" onClick={(e) => { e.preventDefault(); setOpen(true); }}>{value && value.id ? 'Replace image' : label}</a>
        {value && value.id && <button type="button" className="button-link-delete" onClick={() => onChange(null)}>Remove</button>}
      </div>
      {open && <MediaPicker onClose={() => setOpen(false)} onSelect={(m) => { onChange({ id: m.id, src: m.source_url, alt: m.alt_text }); setOpen(false); }} />}
    </div>
  );
}
