import { useEffect, useRef, useState } from 'react';
import { api, custom } from '../../api';
import { useNotice } from '../../hooks';
import { date } from '../../format';
import { Notice, PageHeader, Postbox, Spinner } from '../../components/ui';

const DB_PHASES = [['options', 'Settings & payment gateways'], ['users', 'Users & customers (with passwords)'], ['media', 'Media library'], ['products', 'Products, categories, attributes, reviews'], ['coupons', 'Coupons'], ['taxes', 'Tax rates & shipping zones'], ['orders', 'Orders, notes & refunds'], ['content', 'Posts, pages, comments & menus']];
const REST_PHASES = [['settings', 'Settings & payment gateways'], ['media', 'Media library'], ['products', 'Products, categories, attributes, reviews'], ['coupons', 'Coupons'], ['taxes', 'Tax rates & shipping zones'], ['customers', 'Customers (no passwords)'], ['orders', 'Orders & refunds'], ['content', 'Posts, pages, comments & menus']];

function JobLog({ jobId, onDone }) {
  const [job, setJob] = useState(null);
  const logs = useRef([]);
  const [, force] = useState(0);
  const box = useRef();
  useEffect(() => {
    let stop = false;
    logs.current = [];
    const tick = async () => {
      try {
        const j = await api.get(custom(`admin/import/jobs/${jobId}`), { since: logs.current.length });
        logs.current = [...logs.current, ...j.logs];
        setJob(j);
        force((n) => n + 1);
        if (box.current) box.current.scrollTop = box.current.scrollHeight;
        if (j.status === 'running' && !stop) setTimeout(tick, 1500);
        else if (!stop) onDone(j);
      } catch (e) { if (!stop) setTimeout(tick, 3000); }
    };
    tick();
    return () => { stop = true; };
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Postbox title={<span className="flex">Import log {job && job.status === 'running' && <Spinner />} {job && <span className={`status status-${job.status === 'done' ? 'completed' : job.status === 'failed' ? 'failed' : 'processing'}`}>{job.status}</span>}</span>}>
      <div className="log-box" ref={box}>{logs.current.join('\n') || 'Starting…'}</div>
      {job && job.error && <p style={{ color: 'var(--danger)' }}>{job.error}</p>}
    </Postbox>
  );
}

function PhasePicker({ phases, value, onChange }) {
  return (
    <div className="grid-2">{phases.map(([k, l]) => (
      <label key={k} className="inline"><input type="checkbox" checked={value.includes(k)} onChange={() => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])} /> {l}</label>
    ))}</div>
  );
}

export default function Import() {
  const [tab, setTab] = useState('db');
  const [db, setDb] = useState({ host: 'localhost', port: '3306', user: 'root', password: '', database: '', prefix: 'wp_', remote_media: false, uploads_url: '', reset: false });
  const [rest, setRest] = useState({ site_url: '', consumer_key: '', consumer_secret: '', wp_user: '', wp_app_password: '', download_media: true, order_notes: false });
  const [dbPhases, setDbPhases] = useState(DB_PHASES.map((p) => p[0]));
  const [restPhases, setRestPhases] = useState(REST_PHASES.map((p) => p[0]));
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [history, setHistory] = useState([]);
  const [notice, showNotice, closeNotice] = useNotice();

  const loadHistory = () => api.get(custom('admin/import/jobs')).then((jobs) => {
    setHistory(jobs);
    const running = jobs.find((j) => j.status === 'running');
    if (running) setJobId(running.id);
  }).catch(() => {});
  useEffect(() => { loadHistory(); }, []);

  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      setTest(await api.post(custom(`admin/import/test-${tab}`), tab === 'db' ? db : rest));
    } catch (e) { setTest({ ok: false, message: e.data && e.data.message ? e.data.message : e.message }); } finally { setTesting(false); }
  };
  const start = async () => {
    if (tab === 'db' && db.reset && !window.confirm('RESET deletes all products, orders, posts, media records and non-admin users in this store before importing. Continue?')) return;
    try {
      const body = tab === 'db' ? { ...db, only: dbPhases } : { ...rest, only: restPhases };
      const job = await api.post(custom(`admin/import/${tab}`), body);
      setJobId(job.id);
    } catch (e) { showNotice('error', e.message); }
  };
  const running = history.some((j) => j.status === 'running') || (jobId && !history.find((j) => j.id === jobId && j.status !== 'running'));

  return (
    <>
      <PageHeader title="Import from WordPress" />
      <Notice notice={notice} onClose={closeNotice} />
      <p className="muted">Copies your WooCommerce store and WordPress content into this system. Original IDs are kept, and existing records are skipped, so you can run it again later to pick up new orders/customers (e.g. just before switching over).</p>
      <nav className="nav-tab-wrapper">
        <button type="button" className={`nav-tab ${tab === 'db' ? 'nav-tab-active' : ''}`} onClick={() => { setTab('db'); setTest(null); }}>From database (recommended)</button>
        <button type="button" className={`nav-tab ${tab === 'rest' ? 'nav-tab-active' : ''}`} onClick={() => { setTab('rest'); setTest(null); }}>From live site (REST API)</button>
      </nav>
      <div className="edit-layout">
        <div>
          {tab === 'db' ? (
            <Postbox title="WordPress database connection">
              <p className="muted">Most complete: includes password hashes (customers keep their logins), API keys and everything WooCommerce stores. Read-only access is enough. For a remote server, use a DB export imported into local MySQL, or an SSH tunnel.</p>
              <div className="grid-3">
                <div className="field"><label>Host</label><input type="text" value={db.host} onChange={(e) => setDb({ ...db, host: e.target.value })} /></div>
                <div className="field"><label>Port</label><input type="text" value={db.port} onChange={(e) => setDb({ ...db, port: e.target.value })} /></div>
                <div className="field"><label>Database name</label><input type="text" value={db.database} onChange={(e) => setDb({ ...db, database: e.target.value })} placeholder="wordpress" /></div>
                <div className="field"><label>Username</label><input type="text" value={db.user} onChange={(e) => setDb({ ...db, user: e.target.value })} autoComplete="off" /></div>
                <div className="field"><label>Password</label><input type="password" value={db.password} onChange={(e) => setDb({ ...db, password: e.target.value })} autoComplete="new-password" /></div>
                <div className="field"><label>Table prefix</label><input type="text" value={db.prefix} onChange={(e) => setDb({ ...db, prefix: e.target.value })} /></div>
              </div>
              <h3>Media files</h3>
              <label className="inline"><input type="radio" checked={!db.remote_media} onChange={() => setDb({ ...db, remote_media: false })} /> I will copy <code>wp-content/uploads</code> into <code>server/uploads</code></label><br />
              <label className="inline"><input type="radio" checked={db.remote_media} onChange={() => setDb({ ...db, remote_media: true })} /> Keep loading images from the old site</label>
              {db.remote_media && <div className="field mt"><label>Old uploads URL</label><input type="url" value={db.uploads_url} onChange={(e) => setDb({ ...db, uploads_url: e.target.value })} placeholder="https://old-site.com/wp-content/uploads" /></div>}
              <h3>What to import</h3>
              <PhasePicker phases={DB_PHASES} value={dbPhases} onChange={setDbPhases} />
              <h3>Options</h3>
              <label className="inline" style={{ color: db.reset ? 'var(--danger)' : undefined }}><input type="checkbox" checked={db.reset} onChange={(e) => setDb({ ...db, reset: e.target.checked })} /> Reset: delete existing store data before importing (administrators are kept)</label>
            </Postbox>
          ) : (
            <Postbox title="Live WordPress site">
              <p className="muted">Use when you can't reach the database. Create keys in the old site under WooCommerce → Settings → Advanced → REST API (Read access). An Application Password (Users → Profile) adds drafts, private pages, staff users and menus. Customer passwords cannot be exported over the API.</p>
              <div className="field"><label>Site URL</label><input type="url" value={rest.site_url} onChange={(e) => setRest({ ...rest, site_url: e.target.value })} placeholder="https://content.example.com" /></div>
              <div className="grid-2">
                <div className="field"><label>Consumer key</label><input type="text" value={rest.consumer_key} onChange={(e) => setRest({ ...rest, consumer_key: e.target.value })} placeholder="ck_…" autoComplete="off" /></div>
                <div className="field"><label>Consumer secret</label><input type="password" value={rest.consumer_secret} onChange={(e) => setRest({ ...rest, consumer_secret: e.target.value })} placeholder="cs_…" autoComplete="new-password" /></div>
                <div className="field"><label>WordPress username (optional)</label><input type="text" value={rest.wp_user} onChange={(e) => setRest({ ...rest, wp_user: e.target.value })} autoComplete="off" /></div>
                <div className="field"><label>Application password (optional)</label><input type="password" value={rest.wp_app_password} onChange={(e) => setRest({ ...rest, wp_app_password: e.target.value })} autoComplete="new-password" /></div>
              </div>
              <label className="inline"><input type="checkbox" checked={rest.download_media} onChange={(e) => setRest({ ...rest, download_media: e.target.checked })} /> Download media files into this server (otherwise images keep loading from the old site)</label><br />
              <label className="inline"><input type="checkbox" checked={rest.order_notes} onChange={(e) => setRest({ ...rest, order_notes: e.target.checked })} /> Import order notes (one extra request per order — slower)</label>
              <h3>What to import</h3>
              <PhasePicker phases={REST_PHASES} value={restPhases} onChange={setRestPhases} />
            </Postbox>
          )}
          {jobId && <JobLog key={jobId} jobId={jobId} onDone={(j) => { loadHistory(); showNotice(j.status === 'done' ? 'success' : 'error', j.status === 'done' ? 'Import finished.' : `Import failed: ${j.error}`); }} />}
        </div>
        <div>
          <Postbox title="Run">
            <p><button type="button" className="button" disabled={testing} onClick={runTest}>{testing ? 'Testing…' : 'Test connection'}</button></p>
            {test && (test.ok ? (
              <dl className="kv">
                {Object.entries(test).filter(([k]) => k !== 'ok').map(([k, v]) => [<dt key={`${k}-k`}>{k.replace(/_/g, ' ')}</dt>, <dd key={`${k}-v`}>{Array.isArray(v) ? v.join(', ') : String(v ?? '—')}</dd>])}
              </dl>
            ) : <div className="notice notice-error"><span>{test.message}</span></div>)}
            <button type="button" className="button button-primary" disabled={!!running || (tab === 'db' ? !db.database || !dbPhases.length : !rest.site_url || !restPhases.length)} onClick={start}>{running ? 'Import running…' : 'Start import'}</button>
            <p className="description">Credentials are used for this run only and are not stored.</p>
          </Postbox>
          <Postbox title="Previous runs">
            {history.length ? <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>{history.map((j) => (
              <li key={j.id} style={{ padding: '4px 0' }}><a href="#" onClick={(e) => { e.preventDefault(); setJobId(j.id); }}>{j.label}</a><br />
                <span className={`status status-${j.status === 'done' ? 'completed' : j.status === 'failed' ? 'failed' : 'processing'}`}>{j.status}</span> <span className="muted">{date(j.started_at, true)}</span></li>
            ))}</ul> : <p className="muted">No imports since the server started.</p>}
          </Postbox>
        </div>
      </div>
    </>
  );
}
