// API client for the dashboard. Uses the JWT from login (Bearer) against the same server.
const TOKEN_KEY = 'ce_admin_token';

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

export class ApiError extends Error {
  constructor(message, status, code, data) { super(message); this.status = status; this.code = code; this.data = data; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

function qs(params) {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function request(method, path, { params, body, raw } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/wp-json/${path.replace(/^\//, '')}${qs(params)}`, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 || (res.status === 403 && data && String(data.code).startsWith('jwt_auth'))) onUnauthorized();
    throw new ApiError((data && data.message) || `Request failed (${res.status})`, res.status, data && data.code, data);
  }
  if (raw) return { data, total: parseInt(res.headers.get('X-WP-Total') || '0', 10), totalPages: parseInt(res.headers.get('X-WP-TotalPages') || '0', 10) };
  return data;
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  list: (path, params) => request('GET', path, { params, raw: true }),
  post: (path, body, params) => request('POST', path, { body, params }),
  put: (path, body, params) => request('PUT', path, { body, params }),
  del: (path, params) => request('DELETE', path, { params }),
};

// Fetches every page of a collection (for dropdowns/checklists). Capped at 50 pages.
export async function fetchAll(path, params = {}) {
  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const r = await request('GET', path, { params: { per_page: 100, ...params, page }, raw: true });
    out.push(...(r.data || []));
    totalPages = r.totalPages || 1;
    page++;
  } while (page <= totalPages && page <= 50);
  return out;
}

export const wc = (p) => `wc/v3/${p}`;
export const wp = (p) => `wp/v2/${p}`;
export const custom = (p) => `custom/v1/${p}`;
