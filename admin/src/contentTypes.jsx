// Content-type registry (custom post types, taxonomies, ACF field groups) shared across the dashboard
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, custom } from './api';
import { clearFieldCache } from './components/fields';

const Ctx = createContext({ registry: null, reload: () => {} });

export function ContentTypesProvider({ children }) {
  const [registry, setRegistry] = useState(null);
  const reload = useCallback(() => api.get(custom('admin/content-types')).then((r) => { clearFieldCache(); setRegistry(r); return r; }).catch(() => setRegistry({ types: [], taxonomies: [], field_groups: [] })), []);
  useEffect(() => { reload(); }, [reload]);
  return <Ctx.Provider value={{ registry, reload }}>{children}</Ctx.Provider>;
}

export const useContentTypes = () => useContext(Ctx);

export function typeInfo(registry, name) {
  if (!registry) return null;
  const t = registry.types.find((x) => x.name === name);
  if (!t) return null;
  const taxonomies = registry.taxonomies.filter((x) => (t.taxonomies || []).includes(x.name) || (x.object_types || []).includes(t.name));
  return { ...t, rest_base: t.rest_base || t.name, taxonomies };
}
