// Registry of custom post types, custom taxonomies and custom field groups
// (the CPT UI + ACF equivalent). Stored in the Option table, in ACF's own JSON shapes, so
// ACF/CPT UI exports and the WordPress importer can be loaded as-is.
//
// Post type:  { name, label, singular_label, description, hierarchical, supports[], taxonomies[], rest_base, menu_icon, menu_position }
// Taxonomy:   { name, label, singular_label, hierarchical, object_types[], rest_base }
// Field group (ACF): { key, title, fields[], location: [[{ param, operator, value }]], menu_order, position, active }
// Field (ACF): { key, name, label, type, instructions, required, choices, default_value, sub_fields[], layouts[],
//               taxonomy, field_type, post_type[], multiple, return_format, conditional_logic, button_label, ... }
const options = require('./options');

const BUILTIN_TYPES = ['post', 'page', 'attachment', 'product', 'product_variation', 'shop_order', 'shop_coupon', 'nav_menu_item'];

// Defaults: "Frontend Menus" as configured on the current WordPress site (CPT UI + ACF).
// Importing from WordPress (or pasting an ACF export) replaces these with the exact definitions.
const DEFAULTS = {
  types: [
    {
      name: 'frontend_menus', label: 'Frontend Menus', singular_label: 'Frontend Menu', description: 'Header (top navigation) and footer menus used by the storefront.',
      hierarchical: false, supports: ['title', 'editor', 'excerpt', 'thumbnail', 'page-attributes'], taxonomies: ['frontend_menu_categories'],
      rest_base: 'frontend_menus', menu_icon: '📌', menu_position: 25,
    },
  ],
  taxonomies: [
    { name: 'frontend_menu_categories', label: 'Frontend Menu Categories', singular_label: 'Frontend Menu Category', hierarchical: true, object_types: ['frontend_menus'], rest_base: 'frontend_menu_categories' },
  ],
  field_groups: [
    {
      key: 'group_header_menu_fields',
      title: 'Header Menu Fields',
      menu_order: 0,
      position: 'normal',
      active: true,
      location: [[{ param: 'post_type', operator: '==', value: 'frontend_menus' }]],
      fields: [
        { key: 'field_item_type', name: 'item_type', label: 'Item Type', type: 'radio', choices: { page: 'Page', product_cat: 'Product Categories' }, default_value: 'product_cat', layout: 'vertical' },
        {
          key: 'field_page_menu', name: 'page_menu', label: 'Page Menu', type: 'post_object', post_type: ['page'], return_format: 'object',
          conditional_logic: [[{ field: 'field_item_type', operator: '==', value: 'page' }]],
        },
        {
          key: 'field_category_menu', name: 'category_menu', label: 'Category Menu', type: 'group', layout: 'block',
          conditional_logic: [[{ field: 'field_item_type', operator: '==', value: 'product_cat' }]],
          sub_fields: [
            { key: 'field_category_info', name: 'category_info', label: 'Category Info', type: 'taxonomy', taxonomy: 'product_cat', field_type: 'select', return_format: 'object' },
            {
              key: 'field_category_items', name: 'category', label: 'Category', type: 'repeater', layout: 'table', button_label: 'Add Row',
              sub_fields: [{ key: 'field_category_item', name: 'item', label: 'Item', type: 'taxonomy', taxonomy: 'product_cat', field_type: 'select', return_format: 'object' }],
            },
            {
              key: 'field_brand_items', name: 'brands', label: 'Brands', type: 'repeater', layout: 'table', button_label: 'Add Row',
              sub_fields: [{ key: 'field_brand_item', name: 'item', label: 'Item', type: 'taxonomy', taxonomy: 'pa_manufacturer', field_type: 'select', return_format: 'object' }],
            },
            {
              key: 'field_background_color', name: 'background_color', label: 'Background Color', type: 'select', allow_null: 1,
              choices: { emerald: 'Emerald' },
              instructions: 'Choices are replaced by the real list when field groups are imported from WordPress.',
            },
            {
              key: 'field_promotions', name: 'promotions', label: 'Offers', type: 'repeater', layout: 'table', button_label: 'Add Row',
              sub_fields: [
                { key: 'field_promotion_text', name: 'promotion_text', label: 'Promotion Text', type: 'text' },
                { key: 'field_promotion_image', name: 'image', label: 'Image', type: 'image', return_format: 'url' },
                { key: 'field_promotion_link', name: 'promotion_link', label: 'Promotion Link', type: 'text' },
              ],
            },
          ],
        },
      ],
    },
    // Product field groups as on the WordPress site (replaced by the real ACF export on "Import ACF")
    {
      key: 'group_product_custom_fields', title: 'Product Custom Fields', menu_order: 0, position: 'normal', active: true,
      location: [[{ param: 'post_type', operator: '==', value: 'product' }]],
      fields: [
        { key: 'field_p_barcode', name: 'barcode', label: 'Barcode', type: 'text' },
        { key: 'field_p_supplier', name: 'supplier', label: 'Supplier', type: 'select', allow_null: 1, choices: {} },
        { key: 'field_p_product_type', name: 'product_type', label: 'Product Type', type: 'select', allow_null: 1, choices: {} },
        { key: 'field_p_brand', name: 'brand', label: 'Brand', type: 'taxonomy', taxonomy: 'pa_manufacturer', field_type: 'select', return_format: 'object', allow_null: 1 },
        { key: 'field_p_wholesale_price', name: 'wholesale_price', label: 'Wholesale Price', type: 'number' },
        { key: 'field_p_weighted_average_price', name: 'weighted_average_price', label: 'Weighted Average Price', type: 'number' },
        { key: 'field_p_serving_size', name: 'serving_size', label: 'Serving Size', type: 'text' },
        { key: 'field_p_uses', name: 'uses', label: 'Uses', type: 'wysiwyg' },
        { key: 'field_p_ingredients', name: 'ingredients', label: 'Ingredients', type: 'wysiwyg' },
        { key: 'field_p_details', name: 'details', label: 'Details', type: 'wysiwyg' },
        { key: 'field_p_top_pick', name: 'show_gr8_health_nutritionlist_top_pick', label: 'Show Gr8 Health Nutritionist Top Pick', type: 'true_false', ui: 1 },
        { key: 'field_p_sale_photo', name: 'sale_photo', label: 'Sale Photo', type: 'image', return_format: 'array' },
        { key: 'field_p_redirect_enable', name: 'redirect_enable', label: 'Redirect Enable', type: 'true_false', ui: 1 },
        {
          key: 'field_p_redirect_to_url', name: 'redirect_to_url', label: 'Redirect To URL', type: 'url',
          conditional_logic: [[{ field: 'field_p_redirect_enable', operator: '==', value: '1' }]],
        },
        {
          key: 'field_p_gallary', name: 'gallary', label: 'Gallary', type: 'repeater', layout: 'table', button_label: 'Add Row',
          sub_fields: [{ key: 'field_p_gallary_image', name: 'image', label: 'Image', type: 'image', return_format: 'array' }],
        },
      ],
    },
    {
      key: 'group_product_access', title: 'Access and Interaction Settings', menu_order: 1, position: 'normal', active: true,
      location: [[{ param: 'post_type', operator: '==', value: 'product' }]],
      fields: [
        { key: 'field_p_success_message', name: 'success_message', label: 'Success Message', type: 'text', default_value: 'Product Added Successfully' },
        { key: 'field_p_related_cart', name: 'show_in_related_products_on_cart_page', label: 'Show in related products on cart page', type: 'true_false', ui: 1 },
        {
          key: 'field_p_access_level', name: 'product_access_level', label: 'Product Access Level', type: 'radio', layout: 'vertical', default_value: 'none',
          choices: { none: 'None', access_level_1: 'Access Level 1', access_level_2: 'Access Level 2' },
          instructions: 'Choices are replaced by the real list when field groups are imported from WordPress.',
        },
        { key: 'field_p_last_minute', name: 'last_minute_item', label: 'Last Minute Item', type: 'true_false', ui: 1 },
      ],
    },
    {
      key: 'group_product_related_blogs', title: 'Product Related Blogs', menu_order: 2, position: 'normal', active: true,
      location: [[{ param: 'post_type', operator: '==', value: 'product' }]],
      fields: [{ key: 'field_p_select_blog', name: 'select_blog', label: 'Select Blog', type: 'relationship', post_type: ['post'], return_format: 'object', filters: ['search'] }],
    },
    {
      key: 'group_linked_product_fields', title: 'linked Product Fields', menu_order: 3, position: 'normal', active: true,
      location: [[{ param: 'post_type', operator: '==', value: 'product' }]],
      fields: [
        {
          key: 'field_p_linked_product', name: 'linked_product', label: 'Linked Product', type: 'repeater', layout: 'table', button_label: 'Add Row',
          sub_fields: [
            { key: 'field_p_linked_product_name', name: 'product_name', label: 'Product Name', type: 'post_object', post_type: ['product'], return_format: 'object', allow_null: 1 },
            { key: 'field_p_linked_display_name', name: 'display_name', label: 'Display Name', type: 'text' },
          ],
        },
        { key: 'field_p_current_display_name', name: 'current_product_display_name', label: 'Current Product Display Name', type: 'text' },
        { key: 'field_p_linked_auto_sync', name: 'linked_product_auto_sync', label: 'Linked Product Auto Sync', type: 'true_false', ui: 1 },
      ],
    },
  ],
};

async function getRegistry() {
  const [types, taxonomies, groups] = await Promise.all([
    options.getOption('content_types', null), options.getOption('content_taxonomies', null), options.getOption('field_groups', null),
  ]);
  return {
    types: Array.isArray(types) ? types : DEFAULTS.types,
    taxonomies: Array.isArray(taxonomies) ? taxonomies : DEFAULTS.taxonomies,
    field_groups: Array.isArray(groups) ? groups : DEFAULTS.field_groups,
  };
}

let version = 0;
const getVersion = () => version;

function validate(reg) {
  const errors = [];
  const names = new Set();
  for (const t of reg.types || []) {
    if (!t.name || !/^[a-z0-9_-]{1,20}$/.test(t.name)) errors.push(`Post type "${t.name}": name must be 1–20 chars of a-z, 0-9, _ or -`);
    if (BUILTIN_TYPES.includes(t.name)) errors.push(`Post type "${t.name}" is reserved`);
    if (names.has(t.name)) errors.push(`Duplicate post type "${t.name}"`);
    names.add(t.name);
  }
  for (const t of reg.taxonomies || []) {
    if (!t.name || !/^[a-z0-9_-]{1,32}$/.test(t.name)) errors.push(`Taxonomy "${t.name}": name must be 1–32 chars of a-z, 0-9, _ or -`);
  }
  const walk = (fields, path) => (fields || []).forEach((f) => {
    if (!f.name && !['tab', 'message', 'accordion'].includes(f.type)) errors.push(`${path}: field "${f.label || f.key}" has no name`);
    if (!f.type) errors.push(`${path}: field "${f.name}" has no type`);
    walk(f.sub_fields, `${path} › ${f.name}`);
    (f.layouts || []).forEach((l) => walk(l.sub_fields, `${path} › ${f.name} › ${l.name}`));
  });
  for (const g of reg.field_groups || []) {
    if (!g.key || !g.title) errors.push('Every field group needs a key and a title');
    walk(g.fields, g.title || g.key);
  }
  return errors;
}

async function saveRegistry(reg) {
  const current = await getRegistry();
  const next = {
    types: reg.types !== undefined ? reg.types : current.types,
    taxonomies: reg.taxonomies !== undefined ? reg.taxonomies : current.taxonomies,
    field_groups: reg.field_groups !== undefined ? reg.field_groups : current.field_groups,
  };
  for (const t of next.types) {
    t.rest_base = t.rest_base || t.name;
    t.label = t.label || t.name;
    t.singular_label = t.singular_label || t.label;
    t.supports = Array.isArray(t.supports) ? t.supports : ['title', 'editor'];
    t.taxonomies = Array.isArray(t.taxonomies) ? t.taxonomies : [];
  }
  for (const t of next.taxonomies) {
    t.rest_base = t.rest_base || t.name;
    t.label = t.label || t.name;
    t.singular_label = t.singular_label || t.label;
    t.object_types = Array.isArray(t.object_types) ? t.object_types : [];
  }
  const errors = validate(next);
  if (errors.length) {
    const e = new Error(errors.join('\n'));
    e.validation = errors;
    throw e;
  }
  await options.setOption('content_types', next.types);
  await options.setOption('content_taxonomies', next.taxonomies);
  await options.setOption('field_groups', next.field_groups);
  version++;
  return next;
}

// Does an ACF location rule set match? ctx: { post_type, taxonomy, terms: ['tax:slug'], page_template }
function locationMatches(location, ctx) {
  if (!Array.isArray(location) || !location.length) return false;
  return location.some((andRules) => (andRules || []).every((r) => {
    let actual;
    if (r.param === 'post_type') actual = ctx.post_type;
    else if (r.param === 'taxonomy') actual = ctx.taxonomy;
    else if (r.param === 'post_taxonomy') {
      const has = (ctx.terms || []).includes(r.value);
      return r.operator === '!=' ? !has : has;
    } else if (r.param === 'page_template') actual = ctx.page_template || 'default';
    else if (r.param === 'options_page') return false;
    else return true; // unknown rule types don't block
    return r.operator === '!=' ? actual !== r.value : actual === r.value || (r.value === 'all' && !!actual);
  }));
}

async function groupsFor(ctx) {
  const reg = await getRegistry();
  return reg.field_groups.filter((g) => g.active !== false && locationMatches(g.location, ctx))
    .sort((a, b) => (a.menu_order || 0) - (b.menu_order || 0));
}

module.exports = { getRegistry, saveRegistry, groupsFor, locationMatches, getVersion, BUILTIN_TYPES, DEFAULTS };
