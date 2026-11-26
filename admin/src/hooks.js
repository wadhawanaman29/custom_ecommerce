import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from './api';

// Loads a collection with WP pagination headers. params change → reload.
export function useCollection(path, params) {
  const [state, setState] = useState({ items: [], total: 0, totalPages: 0, loading: true, error: null });
  const key = JSON.stringify([path, params]);
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    return api.list(path, params)
      .then((r) => setState({ items: r.data || [], total: r.total, totalPages: r.totalPages, loading: false, error: null }))
      .catch((e) => setState({ items: [], total: 0, totalPages: 0, loading: false, error: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

// Loads one resource; returns [data, setData, {loading, error, reload}]
export function useResource(path, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    if (!path) { setLoading(false); return Promise.resolve(); }
    setLoading(true);
    return api.get(path).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { reload(); }, [reload]);
  return [data, setData, { loading, error, reload }];
}

// URL-synced query state for list pages (page, search, status, …)
export function useQueryState(defaults) {
  const [sp, setSp] = useSearchParams();
  const state = { ...defaults };
  for (const k of Object.keys(defaults)) if (sp.get(k) !== null) state[k] = sp.get(k);
  const update = (patch) => {
    const next = { ...state, ...patch };
    if ('page' in defaults && !('page' in patch)) next.page = '1';
    const out = {};
    for (const [k, v] of Object.entries(next)) if (v !== '' && v !== undefined && v !== null && String(v) !== String(defaults[k])) out[k] = v;
    setSp(out, { replace: true });
  };
  return [state, update];
}

export function useNotice() {
  const [notice, setNotice] = useState(null);
  const timer = useRef(null);
  const show = (type, message) => {
    setNotice({ type, message });
    clearTimeout(timer.current);
    if (type === 'success') timer.current = setTimeout(() => setNotice(null), 5000);
  };
  return [notice, show, () => setNotice(null)];
}
