import { useState } from 'react';
import { api, wp } from '../../api';
import { useCollection, useNotice, useQueryState } from '../../hooks';
import { date, decodeHtml } from '../../format';
import { UploadButton, thumbOf, uploadFiles } from '../../components/media';
import {
  Modal, Notice, PageHeader, Pagination, Spinner, confirmDelete,
} from '../../components/ui';

export default function MediaLibrary() {
  const [q, setQ] = useQueryState({ page: '1', search: '', media_type: '' });
  const { items, total, totalPages, loading, reload } = useCollection(wp('media'), { page: q.page, per_page: 60, search: q.search, media_type: q.media_type });
  const [detail, setDetail] = useState(null);
  const [notice, showNotice, closeNotice] = useNotice();
  const [dragging, setDragging] = useState(false);

  const saveDetail = async () => {
    try {
      await api.put(wp(`media/${detail.id}`), { title: detail.title, alt_text: detail.alt_text, caption: detail.caption, description: detail.description });
      showNotice('success', 'Media updated.'); setDetail(null); reload();
    } catch (e) { showNotice('error', e.message); }
  };
  const onDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    try {
      await uploadFiles(files);
      showNotice('success', `${files.length} file(s) uploaded.`); reload();
    } catch (err) { showNotice('error', err.message); }
  };

  return (
    <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <PageHeader title="Media Library"><UploadButton accept="image/*,application/pdf,video/*,audio/*" label="Add New Media File" onUploaded={(ms) => { showNotice('success', `${ms.length} file(s) uploaded.`); reload(); }} /></PageHeader>
      <Notice notice={notice} onClose={closeNotice} />
      {dragging && <div className="notice"><span>Drop files to upload</span></div>}
      <div className="tablenav">
        <div className="actions">
          <select value={q.media_type} onChange={(e) => setQ({ media_type: e.target.value })} aria-label="Filter by type"><option value="">All media items</option><option value="image">Images</option><option value="file">Other files</option></select>
          <form className="flex" onSubmit={(e) => { e.preventDefault(); setQ({ search: e.target.q.value }); }}><input type="search" name="q" defaultValue={q.search} placeholder="Search media" /></form>
        </div>
        <Pagination page={q.page} total={total} totalPages={totalPages} onPage={(page) => setQ({ page: String(page) })} />
      </div>
      {loading ? <div className="loading"><Spinner /></div> : (
        <div className="image-grid">
          {items.map((m) => (
            <div key={m.id} className="tile" onClick={() => setDetail({ id: m.id, title: decodeHtml(m.title.rendered), alt_text: m.alt_text, caption: m.caption.rendered.replace(/<\/?p>/g, '').trim(), description: m.description.rendered.replace(/<\/?p>/g, '').trim(), raw: m })} title={decodeHtml(m.title.rendered)}>
              {m.media_type === 'image' ? <img src={thumbOf(m)} alt={m.alt_text} loading="lazy" /> : <span>📄 {m.media_details && m.source_url.split('/').pop()}</span>}
            </div>
          ))}
          {!items.length && <p className="muted">No media files found. Drag files here or use “Add New Media File”.</p>}
        </div>
      )}
      {detail && (
        <Modal title="Attachment details" onClose={() => setDetail(null)}
          footer={<><button type="button" className="button-link-delete" style={{ marginRight: 'auto' }} onClick={() => confirmDelete('this file') && api.del(wp(`media/${detail.id}`), { force: true }).then(() => { setDetail(null); reload(); showNotice('success', 'Media deleted.'); }).catch((e) => showNotice('error', e.message))}>Delete permanently</button>
            <button type="button" className="button" onClick={() => setDetail(null)}>Close</button><button type="button" className="button button-primary" onClick={saveDetail}>Save</button></>}>
          <div className="grid-2">
            <div>{detail.raw.media_type === 'image' ? <img src={detail.raw.source_url} alt="" style={{ maxWidth: '100%' }} /> : <a href={detail.raw.source_url} target="_blank" rel="noreferrer">Open file</a>}
              <dl className="kv mt"><dt>Uploaded on</dt><dd>{date(detail.raw.date, true)}</dd><dt>File type</dt><dd>{detail.raw.mime_type}</dd>
                {detail.raw.media_details?.width && <><dt>Dimensions</dt><dd>{detail.raw.media_details.width} × {detail.raw.media_details.height}</dd></>}
                {detail.raw.media_details?.filesize ? <><dt>File size</dt><dd>{Math.round(detail.raw.media_details.filesize / 1024)} KB</dd></> : null}</dl></div>
            <div>
              <div className="field"><label>Alternative Text</label><textarea rows={2} value={detail.alt_text} onChange={(e) => setDetail({ ...detail, alt_text: e.target.value })} /></div>
              <div className="field"><label>Title</label><input type="text" value={detail.title} onChange={(e) => setDetail({ ...detail, title: e.target.value })} /></div>
              <div className="field"><label>Caption</label><textarea rows={2} value={detail.caption} onChange={(e) => setDetail({ ...detail, caption: e.target.value })} /></div>
              <div className="field"><label>Description</label><textarea rows={3} value={detail.description} onChange={(e) => setDetail({ ...detail, description: e.target.value })} /></div>
              <div className="field"><label>File URL</label><input type="text" readOnly value={detail.raw.source_url} onFocus={(e) => e.target.select()} /></div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
