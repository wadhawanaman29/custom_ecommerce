// sanitize_title() equivalent + unique slug generation (appends -2, -3 … like WordPress)
function slugify(str) {
  return String(str || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// exists(slug) → Promise<boolean>
async function uniqueSlug(base, exists) {
  const root = slugify(base) || 'item';
  let slug = root;
  let n = 2;
  while (await exists(slug)) slug = `${root}-${n++}`;
  return slug;
}

module.exports = { slugify, uniqueSlug };
