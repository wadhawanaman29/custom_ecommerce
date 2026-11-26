import { lazy, Suspense, useState } from 'react';
import { Spinner } from './ui';

// Visual (Quill) / Text (raw HTML) editor, like the WordPress classic editor
const Quill = lazy(async () => {
  await import('react-quill/dist/quill.snow.css');
  return import('react-quill');
});

const modules = {
  toolbar: [
    [{ header: [2, 3, 4, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['blockquote', 'link', 'image'],
    [{ align: [] }],
    ['clean'],
  ],
};

export default function Editor({ value, onChange, height }) {
  // Block-editor (Gutenberg) markup would be mangled by the visual editor → default to Text mode
  const [mode, setMode] = useState(String(value || '').includes('<!-- wp:') ? 'text' : 'visual');
  return (
    <div>
      <div className="editor-tabs">
        <button type="button" className={mode === 'visual' ? 'active' : ''} onClick={() => setMode('visual')}>Visual</button>
        <button type="button" className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>Text</button>
      </div>
      {mode === 'visual' ? (
        <Suspense fallback={<div className="loading"><Spinner /></div>}>
          <Quill theme="snow" value={value || ''} onChange={(v) => onChange(v === '<p><br></p>' ? '' : v)} modules={modules} style={height ? { minHeight: height } : undefined} />
        </Suspense>
      ) : (
        <textarea className="html-editor" rows={14} value={value || ''} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
