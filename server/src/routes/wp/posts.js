// /wp-json/wp/v2/posts, /pages, /categories, /tags, /comments
const express = require('express');
const crypto = require('crypto');
const prisma = require('../../db');
const config = require('../../config');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { parseCollection, setPaginationHeaders, idList, strList } = require('../../lib/pagination');
const {
  wpDate, wpDateGmt, parseWpDate, bool, mediaUrl,
} = require('../../lib/format');
const { uniqueSlug } = require('../../lib/slug');
const { store } = require('../../lib/options');
const { cached } = require('../../lib/cache');
const { wpautop, autoExcerpt } = require('../../lib/wpautop');
const { can, userCan } = require('../../middleware/auth');

const WP = `${config.siteUrl}/wp-json/wp/v2`;
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
const gravatar = (email) => {
  const h = crypto.createHash('md5').update(String(email || '').trim().toLowerCase()).digest('hex');
  return Object.fromEntries([24, 48, 96].map((sz) => [sz, `https://secure.gravatar.com/avatar/${h}?s=${sz}&d=mm&r=g`]));
};

// ───────── Serializers (shared with media/users) ─────────
function userPublic(u) {
  return {
    id: u.id, name: u.displayName || u.login, url: u.url, description: u.description,
    link: `${config.frontendUrl}/author/${u.nicename || u.login}/`, slug: u.nicename || u.login,
    avatar_urls: gravatar(u.email), meta: [],
    _links: { self: [{ href: `${WP}/users/${u.id}` }], collection: [{ href: `${WP}/users` }] },
  };
}

function mediaOut(m, s) {
  const isImage = String(m.mimeType).startsWith('image/');
  return {
    id: m.id,
    date: wpDate(m.createdAt, s.gmtOffset),
    date_gmt: wpDateGmt(m.createdAt),
    guid: { rendered: mediaUrl(m.path) },
    modified: wpDate(m.updatedAt, s.gmtOffset),
    modified_gmt: wpDateGmt(m.updatedAt),
    slug: m.slug,
    status: 'inherit',
    type: 'attachment',
    link: mediaUrl(m.path),
    title: { rendered: m.title },
    author: m.authorId || 0,
    comment_status: 'closed',
    ping_status: 'closed',
    template: '',
    meta: [],
    description: { rendered: m.description ? wpautop(m.description) : '' },
    caption: { rendered: m.caption ? `<p>${m.caption}</p>\n` : '' },
    alt_text: m.altText,
    media_type: isImage ? 'image' : 'file',
    mime_type: m.mimeType,
    media_details: isImage
      ? { width: m.width || 0, height: m.height || 0, file: m.path, filesize: m.fileSize, sizes: sizesOut(m), image_meta: {} }
      : { filesize: m.fileSize },
    post: null,
    source_url: mediaUrl(m.path),
    _links: { self: [{ href: `${WP}/media/${m.id}` }], collection: [{ href: `${WP}/media` }] },
  };
}

function sizesOut(m) {
  const out = {};
  if (m.sizes && typeof m.sizes === 'object') {
    for (const [name, sz] of Object.entries(m.sizes)) {
      const dir = m.path.includes('/') && !/^https?:/i.test(m.path) ? m.path.slice(0, m.path.lastIndexOf('/') + 1) : '';
      const src = /^https?:/i.test(sz.file || '') ? sz.file : /^https?:/i.test(m.path) ? m.path.replace(/[^/]+$/, sz.file) : mediaUrl(dir + sz.file);
      out[name] = { file: sz.file, width: sz.width, height: sz.height, filesize: sz.filesize, mime_type: sz['mime-type'] || sz.mime_type || m.mimeType, source_url: src };
    }
  }
  out.full = { file: m.fileName, width: m.width || 0, height: m.height || 0, mime_type: m.mimeType, source_url: mediaUrl(m.path) };
  return out;
}

function termOut(t, count) {
  const isCat = t.taxonomy === 'category';
  return {
    id: t.id,
    count,
    description: t.description,
    link: `${config.frontendUrl}/${isCat ? 'category' : 'tag'}/${t.slug}/`,
    name: t.name,
    slug: t.slug,
    taxonomy: t.taxonomy,
    ...(isCat ? { parent: t.parentId } : {}),
    meta: [],
    _links: { self: [{ href: `${WP}/${isCat ? 'categories' : 'tags'}/${t.id}` }], collection: [{ href: `${WP}/${isCat ? 'categories' : 'tags'}` }] },
  };
}

function postOut(p, s, req, extra = {}) {
  const isPage = p.type === 'page';
  const base = isPage ? 'pages' : 'posts';
  const isProtected = !!p.password;
  const canEdit = req && req.user && (userCan(req.user, isPage ? 'edit_others_pages' : 'edit_others_posts') || p.authorId === req.user.id);
  const unlocked = !isProtected || canEdit || (req && req.query.password === p.password);
  const link = isPage ? `${config.frontendUrl}/${extra.pagePath || p.slug}/` : `${config.frontendUrl}/${p.slug}/`;
  // Content imported over REST is already rendered HTML — don't auto-paragraph it again
  const autop = Array.isArray(p.meta) && p.meta.some((m) => m.key === '_rendered_html') ? (x) => x || '' : wpautop;
  const out = {
    id: p.id,
    date: wpDate(p.createdAt, s.gmtOffset),
    date_gmt: wpDateGmt(p.createdAt),
    guid: { rendered: `${config.siteUrl}/?${isPage ? 'page_id' : 'p'}=${p.id}` },
    modified: wpDate(p.updatedAt, s.gmtOffset),
    modified_gmt: wpDateGmt(p.updatedAt),
    slug: p.slug,
    status: p.status,
    type: p.type,
    link,
    title: { rendered: p.title },
    content: { rendered: unlocked ? autop(p.content) : '', protected: isProtected },
    excerpt: { rendered: unlocked ? (p.excerpt ? autop(p.excerpt) : autoExcerpt(p.content)) : '', protected: isProtected },
    author: p.authorId || 0,
    featured_media: p.featuredMediaId || 0,
    ...(isPage ? { parent: p.parentId, menu_order: p.menuOrder } : {}),
    comment_status: p.commentStatus,
    ping_status: p.pingStatus,
    ...(isPage ? {} : { sticky: p.sticky, format: p.format }),
    template: p.template,
    meta: metaObject(p.meta),
    ...(isPage ? {} : {
      categories: (p.terms || []).filter((t) => t.taxonomy === 'category').map((t) => t.id),
      tags: (p.terms || []).filter((t) => t.taxonomy === 'post_tag').map((t) => t.id),
    }),
    acf: acfObject(p.meta),
    _links: {
      self: [{ href: `${WP}/${base}/${p.id}` }],
      collection: [{ href: `${WP}/${base}` }],
      author: [{ embeddable: true, href: `${WP}/users/${p.authorId || 0}` }],
      ...(p.featuredMediaId ? { 'wp:featuredmedia': [{ embeddable: true, href: `${WP}/media/${p.featuredMediaId}` }] } : {}),
    },
  };
  if (req && req.query.context === 'edit' && canEdit) {
    out.title.raw = p.title;
    out.content.raw = p.content;
    out.excerpt.raw = p.excerpt;
    out.password = p.password;
  }
  return out;
}

// Custom fields: public meta (not starting with "_") as an object
function metaObject(meta) {
  if (!Array.isArray(meta)) return {};
  const out = {};
  for (const m of meta) if (m.key && !m.key.startsWith('_') && !m.key.startsWith('acf:')) out[m.key] = m.value;
  return out;
}
// ACF fields migrated as "acf:<field_name>" entries (the "ACF to REST API" plugin shape)
function acfObject(meta) {
  if (!Array.isArray(meta)) return undefined;
  const acf = meta.filter((m) => m.key && m.key.startsWith('acf:'));
  if (!acf.length) return undefined;
  return Object.fromEntries(acf.map((m) => [m.key.slice(4), m.value]));
}

async function embedFor(posts, s) {
  const authorIds = [...new Set(posts.map((p) => p.authorId).filter(Boolean))];
  const mediaIds = [...new Set(posts.map((p) => p.featuredMediaId).filter(Boolean))];
  const [authors, media, counts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: authorIds } } }),
    prisma.media.findMany({ where: { id: { in: mediaIds } } }),
    termCounts(posts.flatMap((p) => (p.terms || []).map((t) => t.id))),
  ]);
  const aMap = new Map(authors.map((u) => [u.id, userPublic(u)]));
  const mMap = new Map(media.map((m) => [m.id, mediaOut(m, s)]));
  return (p) => {
    const e = { author: [aMap.get(p.authorId) || { code: 'rest_user_invalid_id', message: 'Invalid user ID.', data: { status: 404 } }] };
    if (p.featuredMediaId && mMap.get(p.featuredMediaId)) e['wp:featuredmedia'] = [mMap.get(p.featuredMediaId)];
    if (p.type === 'post') {
      e['wp:term'] = [
        (p.terms || []).filter((t) => t.taxonomy === 'category').map((t) => termOut(t, counts.get(t.id) || 0)),
        (p.terms || []).filter((t) => t.taxonomy === 'post_tag').map((t) => termOut(t, counts.get(t.id) || 0)),
      ];
    }
    return e;
  };
}

async function termCounts(ids) {
  if (!ids.length) return new Map();
  const rows = await prisma.term.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, _count: { select: { posts: { where: { status: 'publish' } } } } } });
  return new Map(rows.map((r) => [r.id, r._count.posts]));
}

// Hierarchical page paths ("parent/child") for page links
async function pagePaths(pages) {
  const all = await prisma.post.findMany({ where: { type: 'page' }, select: { id: true, slug: true, parentId: true } });
  const byId = new Map(all.map((p) => [p.id, p]));
  const path = (p) => {
    const parts = [p.slug];
    let cur = p;
    let guard = 0;
    while (cur.parentId && byId.get(cur.parentId) && guard++ < 20) { cur = byId.get(cur.parentId); parts.unshift(cur.slug); }
    return parts.join('/');
  };
  return new Map(pages.map((p) => [p.id, path(p)]));
}

// ───────── Posts & pages ─────────
function postRouter(type) {
  const router = express.Router();
  const editCap = type === 'page' ? 'edit_pages' : 'edit_posts';
  const editOthers = type === 'page' ? 'edit_others_pages' : 'edit_others_posts';
  const publishCap = type === 'page' ? 'publish_pages' : 'publish_posts';
  const include = { terms: true };

  async function render(rows, s, req) {
    const embed = has(req.query, '_embed') ? await embedFor(rows, s) : null;
    const paths = type === 'page' ? await pagePaths(rows) : new Map();
    return rows.map((p) => {
      const o = postOut(p, s, req, { pagePath: paths.get(p.id) });
      if (embed) o._embedded = embed(p);
      return o;
    });
  }

  router.get('/', cached(), ah(async (req, res) => {
    const s = await store();
    const q = req.query;
    const c = parseCollection(q);
    const where = { type };
    const statuses = strList(q.status) || ['publish'];
    if (statuses.some((st) => st !== 'publish') && !req.can(editCap)) {
      throw new ApiError(req.user ? 403 : 400, 'rest_invalid_param', 'Invalid parameter(s): status');
    }
    if (!statuses.includes('any')) where.status = { in: statuses };
    else where.status = { not: 'trash' };
    if (c.include) where.id = { in: c.include };
    if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
    if (q.slug) where.slug = { in: strList(q.slug) };
    if (q.author) where.authorId = { in: idList(q.author) };
    if (q.author_exclude) where.NOT = [...(where.NOT || []), { authorId: { in: idList(q.author_exclude) } }];
    if (q.parent !== undefined) where.parentId = { in: idList(q.parent) || [0] };
    if (q.parent_exclude) where.NOT = [...(where.NOT || []), { parentId: { in: idList(q.parent_exclude) } }];
    if (q.menu_order !== undefined) where.menuOrder = parseInt(q.menu_order, 10) || 0;
    if (q.sticky !== undefined) where.sticky = bool(q.sticky);
    const AND = [];
    if (q.categories) AND.push({ terms: { some: { taxonomy: 'category', id: { in: idList(q.categories) || [] } } } });
    if (q.tags) AND.push({ terms: { some: { taxonomy: 'post_tag', id: { in: idList(q.tags) || [] } } } });
    if (q.categories_exclude) AND.push({ terms: { none: { taxonomy: 'category', id: { in: idList(q.categories_exclude) || [] } } } });
    if (q.tags_exclude) AND.push({ terms: { none: { taxonomy: 'post_tag', id: { in: idList(q.tags_exclude) || [] } } } });
    if (q.after) AND.push({ createdAt: { gt: parseWpDate(q.after, false, s.gmtOffset) } });
    if (q.before) AND.push({ createdAt: { lt: parseWpDate(q.before, false, s.gmtOffset) } });
    if (q.modified_after) AND.push({ updatedAt: { gt: parseWpDate(q.modified_after, false, s.gmtOffset) } });
    if (q.modified_before) AND.push({ updatedAt: { lt: parseWpDate(q.modified_before, false, s.gmtOffset) } });
    if (c.search) AND.push({ OR: [{ title: { contains: c.search } }, { excerpt: { contains: c.search } }, { content: { contains: c.search } }] });
    if (AND.length) where.AND = AND;
    const orderMap = {
      id: { id: c.order }, title: { title: c.order }, slug: { slug: c.order }, modified: { updatedAt: c.order },
      menu_order: [{ menuOrder: c.order }, { title: 'asc' }], parent: { parentId: c.order },
    };
    const orderBy = orderMap[c.orderby] || [{ createdAt: c.order }, { id: c.order }];
    const [total, rows] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({ where, include, orderBy, skip: c.skip, take: c.take }),
    ]);
    if (c.orderby === 'include' && c.include) rows.sort((a, b) => c.include.indexOf(a.id) - c.include.indexOf(b.id));
    setPaginationHeaders(req, res, total, c);
    res.json(await render(rows, s, req));
  }));

  async function find(id, req, forEdit = false) {
    const p = await prisma.post.findUnique({ where: { id: intParam(id, 'rest_post_invalid_id') }, include });
    if (!p || p.type !== type) throw new ApiError(404, 'rest_post_invalid_id', 'Invalid post ID.');
    const canEdit = req.user && (req.can(editOthers) || (req.can(editCap) && p.authorId === req.user.id));
    if (p.status !== 'publish' && !canEdit) {
      throw new ApiError(req.user ? 403 : 401, 'rest_forbidden', 'Sorry, you are not allowed to do that.');
    }
    if (forEdit && !canEdit) throw new ApiError(req.user ? 403 : 401, 'rest_cannot_edit', 'Sorry, you are not allowed to edit this post.');
    return p;
  }

  async function save(body, req, existing) {
    const s = await store();
    const d = {};
    const text = (v) => (v && typeof v === 'object' ? (v.raw ?? v.rendered ?? '') : String(v ?? ''));
    if (has(body, 'title')) d.title = text(body.title);
    if (has(body, 'content')) d.content = text(body.content);
    if (has(body, 'excerpt')) d.excerpt = text(body.excerpt);
    if (has(body, 'status')) {
      const st = String(body.status);
      if (!['publish', 'future', 'draft', 'pending', 'private'].includes(st)) throw badRequest('rest_invalid_param', 'Invalid parameter(s): status');
      if (['publish', 'future', 'private'].includes(st) && !req.can(publishCap)) throw new ApiError(403, 'rest_cannot_publish', 'Sorry, you are not allowed to publish posts in this post type.');
      d.status = st;
    }
    if (has(body, 'comment_status')) d.commentStatus = String(body.comment_status);
    if (has(body, 'ping_status')) d.pingStatus = String(body.ping_status);
    if (has(body, 'featured_media')) d.featuredMediaId = parseInt(body.featured_media, 10) || 0;
    if (has(body, 'template')) d.template = String(body.template);
    if (has(body, 'password')) d.password = String(body.password);
    if (has(body, 'parent')) d.parentId = parseInt(body.parent, 10) || 0;
    if (has(body, 'menu_order')) d.menuOrder = parseInt(body.menu_order, 10) || 0;
    if (has(body, 'sticky')) d.sticky = bool(body.sticky);
    if (has(body, 'format')) d.format = String(body.format);
    if (has(body, 'author') && req.can(editOthers)) d.authorId = parseInt(body.author, 10) || null;
    if (has(body, 'date_gmt')) d.createdAt = parseWpDate(body.date_gmt, true) || undefined;
    else if (has(body, 'date')) d.createdAt = parseWpDate(body.date, false, s.gmtOffset) || undefined;
    if (has(body, 'meta') && body.meta && typeof body.meta === 'object') {
      const list = Array.isArray(existing?.meta) ? existing.meta.filter((m) => !has(body.meta, m.key)) : [];
      let id = list.reduce((n, m) => Math.max(n, m.id || 0), 0);
      for (const [key, value] of Object.entries(body.meta)) if (value !== null) list.push({ id: ++id, key, value });
      d.meta = list;
    }
    if (!existing || has(body, 'slug') || (d.title && !existing.slug)) {
      const baseSlug = body.slug || d.title || existing?.title || `${type}-${Date.now()}`;
      d.slug = await uniqueSlug(baseSlug, async (slug) => !!(await prisma.post.findFirst({ where: { type, slug, NOT: existing ? { id: existing.id } : undefined } })));
    }
    if (type === 'post') {
      const terms = [];
      let touched = false;
      if (has(body, 'categories')) { touched = true; terms.push(...(idList(body.categories) || [])); } else if (existing) terms.push(...existing.terms.filter((t) => t.taxonomy === 'category').map((t) => t.id));
      if (has(body, 'tags')) { touched = true; terms.push(...(idList(body.tags) || [])); } else if (existing) terms.push(...existing.terms.filter((t) => t.taxonomy === 'post_tag').map((t) => t.id));
      if (!existing && !has(body, 'categories')) {
        const uncategorized = await prisma.term.findFirst({ where: { taxonomy: 'category', slug: 'uncategorized' } });
        if (uncategorized) { terms.push(uncategorized.id); touched = true; }
      }
      if (touched) d.terms = { set: [...new Set(terms)].map((id) => ({ id })) };
    }
    if (existing) return prisma.post.update({ where: { id: existing.id }, data: d, include });
    if (d.terms) d.terms = { connect: d.terms.set };
    return prisma.post.create({ data: { ...d, type, status: d.status || 'draft', authorId: d.authorId || req.user.id }, include });
  }

  router.post('/', can(editCap), ah(async (req, res) => {
    const s = await store();
    const p = await save(req.body || {}, req, null);
    res.status(201).json((await render([p], s, req))[0]);
  }));
  router.get('/:id(\\d+)', cached(), ah(async (req, res) => {
    const s = await store();
    res.json((await render([await find(req.params.id, req)], s, req))[0]);
  }));
  const update = ah(async (req, res) => {
    const s = await store();
    const existing = await find(req.params.id, req, true);
    res.json((await render([await save(req.body || {}, req, existing)], s, req))[0]);
  });
  router.post('/:id(\\d+)', can(editCap), update);
  router.put('/:id(\\d+)', can(editCap), update);
  router.patch('/:id(\\d+)', can(editCap), update);
  router.delete('/:id(\\d+)', can(editCap), ah(async (req, res) => {
    const s = await store();
    const p = await find(req.params.id, req, true);
    const out = (await render([p], s, req))[0];
    if (bool(req.query.force ?? req.body?.force)) {
      await prisma.post.delete({ where: { id: p.id } });
      return res.json({ deleted: true, previous: out });
    }
    if (p.status === 'trash') throw new ApiError(410, 'rest_already_trashed', 'The post has already been deleted.');
    const t = await prisma.post.update({ where: { id: p.id }, data: { status: 'trash' }, include });
    res.json((await render([t], s, req))[0]);
  }));
  return router;
}

// ───────── Categories & tags ─────────
function taxonomyRouter(taxonomy) {
  const router = express.Router();
  const base = taxonomy === 'category' ? 'categories' : 'tags';
  const find = async (id) => {
    const t = await prisma.term.findUnique({ where: { id: intParam(id, 'rest_term_invalid') } });
    if (!t || t.taxonomy !== taxonomy) throw new ApiError(404, 'rest_term_invalid', 'Term does not exist.');
    return t;
  };
  const countOf = async (t) => (await termCounts([t.id])).get(t.id) || 0;

  router.get('/', cached(), ah(async (req, res) => {
    const q = req.query;
    const c = parseCollection(q, { defaultOrder: 'asc' });
    const where = { taxonomy };
    if (c.include) where.id = { in: c.include };
    if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
    if (c.search) where.OR = [{ name: { contains: c.search } }, { slug: { contains: c.search } }];
    if (q.slug) where.slug = { in: strList(q.slug) };
    if (taxonomy === 'category' && q.parent !== undefined) where.parentId = parseInt(q.parent, 10) || 0;
    if (q.post) where.posts = { some: { id: parseInt(q.post, 10) } };
    if (bool(q.hide_empty)) where.posts = { some: { status: 'publish' } };
    const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'slug' ? { slug: c.order } : c.orderby === 'count' ? { posts: { _count: c.order } } : { name: c.order };
    const [total, rows] = await Promise.all([
      prisma.term.count({ where }),
      prisma.term.findMany({ where, orderBy, skip: c.skip, take: c.take, include: { _count: { select: { posts: { where: { status: 'publish' } } } } } }),
    ]);
    setPaginationHeaders(req, res, total, c);
    res.json(rows.map((t) => termOut(t, t._count.posts)));
  }));
  async function save(body, existing) {
    const d = {};
    if (has(body, 'name')) d.name = String(body.name);
    if (!existing && !d.name) throw badRequest('rest_missing_callback_param', 'Missing parameter(s): name');
    if (has(body, 'description')) d.description = String(body.description);
    if (taxonomy === 'category' && has(body, 'parent')) d.parentId = parseInt(body.parent, 10) || 0;
    if (!existing || has(body, 'slug')) {
      d.slug = await uniqueSlug(body.slug || d.name, async (slug) => !!(await prisma.term.findFirst({ where: { taxonomy, slug, NOT: existing ? { id: existing.id } : undefined } })));
    }
    return existing ? prisma.term.update({ where: { id: existing.id }, data: d }) : prisma.term.create({ data: { ...d, taxonomy } });
  }
  router.post('/', can('manage_categories'), ah(async (req, res) => { const t = await save(req.body || {}, null); res.status(201).json(termOut(t, 0)); }));
  router.get('/:id(\\d+)', cached(), ah(async (req, res) => { const t = await find(req.params.id); res.json(termOut(t, await countOf(t))); }));
  const update = ah(async (req, res) => { const t = await save(req.body || {}, await find(req.params.id)); res.json(termOut(t, await countOf(t))); });
  router.post('/:id(\\d+)', can('manage_categories'), update);
  router.put('/:id(\\d+)', can('manage_categories'), update);
  router.patch('/:id(\\d+)', can('manage_categories'), update);
  router.delete('/:id(\\d+)', can('manage_categories'), ah(async (req, res) => {
    if (!bool(req.query.force ?? req.body?.force)) throw new ApiError(501, 'rest_trash_not_supported', `Terms do not support trashing. Set 'force=true' to delete.`);
    const t = await find(req.params.id);
    const out = termOut(t, await countOf(t));
    await prisma.term.delete({ where: { id: t.id } });
    res.json({ deleted: true, previous: out });
  }));
  router.base = base;
  return router;
}

// ───────── Comments ─────────
const comments = express.Router();
function commentOut(c, s) {
  return {
    id: c.id, post: c.postId, parent: c.parentId, author: c.authorId, author_name: c.authorName, author_url: c.authorUrl,
    date: wpDate(c.createdAt, s.gmtOffset), date_gmt: wpDateGmt(c.createdAt),
    content: { rendered: wpautop(c.content) }, link: `${config.frontendUrl}/?p=${c.postId}#comment-${c.id}`,
    status: c.status, type: 'comment', author_avatar_urls: gravatar(c.authorEmail), meta: [],
    _links: { self: [{ href: `${WP}/comments/${c.id}` }], collection: [{ href: `${WP}/comments` }], up: [{ embeddable: true, post_type: 'post', href: `${WP}/posts/${c.postId}` }] },
  };
}
comments.get('/', cached(), ah(async (req, res) => {
  const s = await store();
  const q = req.query;
  const c = parseCollection(q);
  const mod = req.can('moderate_comments');
  const where = {};
  if (!mod) where.status = 'approved';
  else if (q.status && q.status !== 'all') where.status = q.status === 'approve' ? 'approved' : String(q.status);
  else where.status = 'approved';
  if (q.post) where.postId = { in: idList(q.post) };
  if (q.parent !== undefined) where.parentId = { in: idList(q.parent) || [0] };
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  if (c.search) where.content = { contains: c.search };
  const orderBy = c.orderby === 'id' ? { id: c.order } : { createdAt: c.order };
  const [total, rows] = await Promise.all([prisma.comment.count({ where }), prisma.comment.findMany({ where, orderBy, skip: c.skip, take: c.take })]);
  setPaginationHeaders(req, res, total, c);
  res.json(rows.map((x) => commentOut(x, s)));
}));
comments.post('/', ah(async (req, res) => {
  const s = await store();
  const b = req.body || {};
  const post = await prisma.post.findUnique({ where: { id: parseInt(b.post, 10) || 0 } });
  if (!post || post.status !== 'publish') throw new ApiError(403, 'rest_comment_invalid_post_id', 'Sorry, you are not allowed to create this comment without a post.');
  if (post.commentStatus !== 'open') throw new ApiError(403, 'rest_comment_closed', 'Sorry, comments are closed for this item.');
  const content = String((b.content && b.content.raw) || b.content || '').trim();
  if (!content) throw badRequest('rest_comment_content_invalid', 'Invalid comment content.');
  const u = req.user;
  const authorName = u ? u.displayName : String(b.author_name || '').trim();
  const authorEmail = u ? u.email : String(b.author_email || '').trim();
  if (!u && (!authorName || !authorEmail)) throw badRequest('rest_comment_author_data_required', 'Creating a comment requires valid author name and email values.');
  const cmt = await prisma.comment.create({
    data: {
      postId: post.id, parentId: parseInt(b.parent, 10) || 0, authorId: u ? u.id : 0, authorName, authorEmail,
      authorUrl: String(b.author_url || ''), content, status: req.can('moderate_comments') ? (b.status === 'hold' ? 'hold' : 'approved') : 'hold',
    },
  });
  res.status(201).json(commentOut(cmt, s));
}));
comments.get('/:id(\\d+)', ah(async (req, res) => {
  const c = await prisma.comment.findUnique({ where: { id: intParam(req.params.id, 'rest_comment_invalid_id') } });
  if (!c || (c.status !== 'approved' && !req.can('moderate_comments'))) throw new ApiError(404, 'rest_comment_invalid_id', 'Invalid comment ID.');
  res.json(commentOut(c, await store()));
}));
const updComment = ah(async (req, res) => {
  const c = await prisma.comment.findUnique({ where: { id: intParam(req.params.id, 'rest_comment_invalid_id') } });
  if (!c) throw new ApiError(404, 'rest_comment_invalid_id', 'Invalid comment ID.');
  const b = req.body || {};
  const d = {};
  if (has(b, 'status')) d.status = b.status === 'approve' ? 'approved' : String(b.status);
  if (has(b, 'content')) d.content = String((b.content && b.content.raw) || b.content);
  if (has(b, 'author_name')) d.authorName = String(b.author_name);
  res.json(commentOut(await prisma.comment.update({ where: { id: c.id }, data: d }), await store()));
});
comments.post('/:id(\\d+)', can('moderate_comments'), updComment);
comments.put('/:id(\\d+)', can('moderate_comments'), updComment);
comments.patch('/:id(\\d+)', can('moderate_comments'), updComment);
comments.delete('/:id(\\d+)', can('moderate_comments'), ah(async (req, res) => {
  const s = await store();
  const c = await prisma.comment.findUnique({ where: { id: intParam(req.params.id, 'rest_comment_invalid_id') } });
  if (!c) throw new ApiError(404, 'rest_comment_invalid_id', 'Invalid comment ID.');
  if (bool(req.query.force ?? req.body?.force)) {
    await prisma.comment.delete({ where: { id: c.id } });
    return res.json({ deleted: true, previous: commentOut(c, s) });
  }
  res.json(commentOut(await prisma.comment.update({ where: { id: c.id }, data: { status: 'trash' } }), s));
}));

module.exports = {
  posts: postRouter('post'), pages: postRouter('page'), categories: taxonomyRouter('category'), tags: taxonomyRouter('post_tag'),
  comments, mediaOut, userPublic, gravatar,
};
