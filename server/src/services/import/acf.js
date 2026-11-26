// ACF + CPT UI helpers for importing from WordPress.
//  - fieldGroupsFromDb(): rebuilds ACF field groups from acf-field-group / acf-field posts
//  - postTypesFromDb():   CPT UI options + ACF 6.1 native post types/taxonomies
//  - acfValues():         ACF stores repeaters/groups flattened in postmeta
//                         (category_menu_category_0_item). This rebuilds nested values.
const { unserialize } = require('php-serialize');

function php(v) {
  if (v === null || v === undefined || v === '') return v === '' ? '' : null;
  if (typeof v !== 'string' || !/^[aOsibdN][:;]/.test(v)) return v;
  try { return unserialize(v, {}, { strict: false }); } catch { return v; }
}
const asArray = (v) => {
  const x = php(v);
  if (x === null || x === undefined || x === '') return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object') return Object.values(x);
  return [x];
};
// PHP associative arrays come back as objects; keep them, but turn numeric-keyed ones into arrays
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length && keys.every((k, i) => String(i) === k)) return keys.map((k) => normalize(v[k]));
    return Object.fromEntries(keys.map((k) => [k, normalize(v[k])]));
  }
  return v;
}

// ── Field groups ──
async function fieldGroupsFromDb(q, T) {
  const groups = await q(`SELECT ID, post_title, post_name, post_content, post_status, menu_order FROM ${T('posts')} WHERE post_type = 'acf-field-group' AND post_status IN ('publish', 'acf-disabled')`);
  if (!groups.length) return [];
  const fields = await q(`SELECT ID, post_title, post_name, post_excerpt, post_content, post_parent, menu_order FROM ${T('posts')} WHERE post_type = 'acf-field' AND post_status = 'publish' ORDER BY menu_order, ID`);
  const children = new Map();
  for (const f of fields) {
    if (!children.has(f.post_parent)) children.set(f.post_parent, []);
    children.get(f.post_parent).push(f);
  }
  const build = (f) => {
    const settings = normalize(php(f.post_content) || {});
    const field = { ...settings, key: f.post_name, label: f.post_title, name: f.post_excerpt, menu_order: f.menu_order };
    const kids = (children.get(f.ID) || []).map(build);
    if (field.type === 'flexible_content') {
      const layouts = Object.values(settings.layouts || {}).map((l) => ({ ...l, sub_fields: kids.filter((k) => k.parent_layout === l.key) }));
      field.layouts = layouts;
    } else if (kids.length) field.sub_fields = kids;
    return field;
  };
  return groups.map((g) => {
    const settings = normalize(php(g.post_content) || {});
    return {
      ...settings,
      key: g.post_name,
      title: g.post_title,
      menu_order: g.menu_order,
      active: g.post_status === 'publish',
      location: normalize(settings.location || []),
      fields: (children.get(g.ID) || []).map(build),
    };
  });
}

// ── Post types & taxonomies (CPT UI options, ACF 6.1 acf-post-type / acf-taxonomy posts) ──
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

function fromCptUi(data) {
  const types = [];
  const taxonomies = [];
  for (const v of Object.values(data || {})) {
    if (!v || typeof v !== 'object' || !v.name) continue;
    if (v.object_types !== undefined) {
      taxonomies.push({
        name: v.name, label: v.label || v.name, singular_label: v.singular_label || v.label || v.name, hierarchical: truthy(v.hierarchical),
        object_types: asArray(v.object_types), rest_base: v.rest_base || v.name,
      });
    } else {
      types.push({
        name: v.name, label: v.label || v.name, singular_label: v.singular_label || v.label || v.name, description: v.description || '',
        hierarchical: truthy(v.hierarchical), supports: asArray(v.supports).length ? asArray(v.supports) : ['title', 'editor'],
        taxonomies: asArray(v.taxonomies), rest_base: v.rest_base || v.name, menu_icon: '📄', menu_position: parseInt(v.menu_position, 10) || 25,
      });
    }
  }
  return { types, taxonomies };
}

async function postTypesFromDb(q, T) {
  const out = { types: [], taxonomies: [] };
  const opts = await q(`SELECT option_name AS n, option_value AS v FROM ${T('options')} WHERE option_name IN ('cptui_post_types', 'cptui_taxonomies')`);
  for (const o of opts) {
    const r = fromCptUi(normalize(php(o.v) || {}));
    out.types.push(...r.types);
    out.taxonomies.push(...r.taxonomies);
  }
  // ACF 6.1+ native post types / taxonomies
  const acf = await q(`SELECT post_type, post_content, post_title FROM ${T('posts')} WHERE post_type IN ('acf-post-type', 'acf-taxonomy') AND post_status = 'publish'`);
  for (const p of acf) {
    const s = normalize(php(p.post_content) || {});
    if (p.post_type === 'acf-post-type' && s.post_type) {
      out.types.push({
        name: s.post_type, label: (s.labels && s.labels.name) || p.post_title, singular_label: (s.labels && s.labels.singular_name) || p.post_title,
        hierarchical: truthy(s.hierarchical), supports: asArray(s.supports), taxonomies: asArray(s.taxonomies), rest_base: s.rest_base || s.post_type, menu_icon: '📄',
      });
    } else if (p.post_type === 'acf-taxonomy' && s.taxonomy) {
      out.taxonomies.push({
        name: s.taxonomy, label: (s.labels && s.labels.name) || p.post_title, singular_label: (s.labels && s.labels.singular_name) || p.post_title,
        hierarchical: truthy(s.hierarchical), object_types: asArray(s.object_type), rest_base: s.rest_base || s.taxonomy,
      });
    }
  }
  return out;
}

// ── Values ──
const ID_TYPES = ['image', 'file', 'post_object', 'page_link', 'user', 'taxonomy', 'relationship', 'gallery'];
const MULTI_TYPES = ['checkbox', 'relationship', 'gallery'];

function readField(meta, prefix, f) {
  const key = `${prefix}${f.name}`;
  switch (f.type) {
    case 'group': {
      const o = {};
      for (const sub of f.sub_fields || []) o[sub.name] = readField(meta, `${key}_`, sub);
      return o;
    }
    case 'repeater': {
      const n = parseInt(meta.get(key), 10) || 0;
      const rows = [];
      for (let i = 0; i < n; i++) {
        const row = {};
        for (const sub of f.sub_fields || []) row[sub.name] = readField(meta, `${key}_${i}_`, sub);
        rows.push(row);
      }
      return rows;
    }
    case 'flexible_content': {
      return asArray(meta.get(key)).map((layoutName, i) => {
        const layout = (f.layouts || []).find((l) => l.name === layoutName);
        const row = { acf_fc_layout: layoutName };
        for (const sub of (layout && layout.sub_fields) || []) row[sub.name] = readField(meta, `${key}_${i}_`, sub);
        return row;
      });
    }
    case 'tab': case 'message': case 'accordion':
      return undefined;
    default: {
      if (!meta.has(key)) return f.default_value !== undefined && f.default_value !== '' ? f.default_value : null;
      let v = normalize(php(meta.get(key)));
      const multi = MULTI_TYPES.includes(f.type) || truthy(f.multiple) || (f.type === 'taxonomy' && ['checkbox', 'multi_select'].includes(f.field_type));
      if (multi && !Array.isArray(v)) v = v === '' || v === null ? [] : [v];
      if (f.type === 'true_false') return v === '1' || v === 1 || v === true;
      if (ID_TYPES.includes(f.type)) {
        const toNum = (x) => (/^\d+$/.test(String(x)) ? Number(x) : x);
        return Array.isArray(v) ? v.map(toNum) : v === '' ? null : toNum(v);
      }
      if (f.type === 'number' || f.type === 'range') return v === '' || v === null ? null : Number(v);
      return v;
    }
  }
}

// meta: Map(key → raw value). fields: top-level ACF fields from all groups.
// Returns { values: { name: value }, managedKeys: Set } — managedKeys are the flat meta keys ACF owns.
function acfValues(meta, fields) {
  const values = {};
  for (const f of fields) {
    if (!f.name || ['tab', 'message', 'accordion'].includes(f.type)) continue;
    // ACF writes "_<name>" = field key for every saved field
    if (meta.get(`_${f.name}`) !== f.key && !meta.has(f.name)) continue;
    const v = readField(meta, '', f);
    if (v !== undefined) values[f.name] = v;
  }
  const managedKeys = new Set();
  for (const [k, v] of meta) {
    if (k.startsWith('_') && String(v).startsWith('field_')) { managedKeys.add(k); managedKeys.add(k.slice(1)); }
  }
  return { values, managedKeys };
}

const topLevelFields = (groups) => groups.flatMap((g) => g.fields || []);

module.exports = {
  fieldGroupsFromDb, postTypesFromDb, fromCptUi, acfValues, topLevelFields, readField, php, normalize,
};
