import { useEffect, useRef, useState } from 'react';
import { api, custom } from '../api';
import { Spinner } from './ui';

// Polls a background job (storewide sale, SKU generation…) and shows progress + log
export default function JobProgress({ job, onDone }) {
  const [state, setState] = useState(job);
  const logs = useRef(job ? job.logs || [] : []);
  useEffect(() => {
    if (!job) return undefined;
    logs.current = job.logs || [];
    setState(job);
    if (job.status !== 'running') return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api.get(custom(`admin/plugins/jobs/${job.id}`), { since: logs.current.length });
        logs.current = [...logs.current, ...j.logs];
        setState({ ...j, logs: logs.current });
        if (j.status === 'running' && !stop) setTimeout(tick, 1000);
        else if (!stop && onDone) onDone(j);
      } catch { if (!stop) setTimeout(tick, 2000); }
    };
    setTimeout(tick, 600);
    return () => { stop = true; };
  }, [job && job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!state) return null;
  const pct = state.total ? Math.round((state.progress / state.total) * 100) : (state.status === 'done' ? 100 : 0);
  return (
    <div className="postbox">
      <div className="postbox-header"><span className="flex">{state.label} {state.status === 'running' && <Spinner />}</span>
        <span className={`status status-${state.status === 'done' ? 'completed' : state.status === 'failed' ? 'failed' : 'processing'}`}>{state.status}</span></div>
      <div className="inside">
        <div style={{ background: '#f0f0f1', height: 10, borderRadius: 5, overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: state.status === 'failed' ? 'var(--danger)' : 'var(--primary)', transition: 'width .3s' }} /></div>
        <p className="muted">{state.progress}{state.total ? ` / ${state.total}` : ''} processed</p>
        {state.error && <p style={{ color: 'var(--danger)' }}>{state.error}</p>}
        {(state.logs || []).length > 0 && <div className="log-box" style={{ height: 140 }}>{(state.logs || []).join('\n')}</div>}
      </div>
    </div>
  );
}
