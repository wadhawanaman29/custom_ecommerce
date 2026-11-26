// /wp-json/wp/v2/media — upload (multipart "file" or raw body + Content-Disposition), list, update, delete
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const prisma = require('../../db');
const config = require('../../config');
const { ah, intParam, ApiError, badRequest } = require('../../lib/http');
const { parseCollection, setPaginationHeaders } = require('../../lib/pagination');
const { bool } = require('../../lib/format');
const { slugify } = require('../../lib/slug');
const { store } = require('../../lib/options');
const { cached } = require('../../lib/cache');
const { imageSize } = require('../../lib/image-size');
const { can } = require('../../middleware/auth');
const { mediaOut } = require('./posts');

const router = express.Router();
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);

const ALLOWED = /^(image\/(jpeg|png|gif|webp|avif|svg\+xml)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|wav|ogg)|text\/(plain|csv)|application\/(zip|msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel))$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });

async function storeFile(buffer, originalName, mimeType, authorId, fields = {}) {
  if (!ALLOWED.test(mimeType)) throw badRequest('rest_upload_sideload_error', 'Sorry, you are not allowed to upload this file type.');
  const now = new Date();
  const sub = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(config.uploadsDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(originalName).toLowerCase();
  const base = slugify(path.basename(originalName, ext)) || 'file';
  let name = `${base}${ext}`;
  let n = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}${ext}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  const dims = mimeType.startsWith('image/') ? imageSize(buffer) : { width: null, height: null };
  return prisma.media.create({
    data: {
      title: fields.title || path.basename(originalName, ext),
      slug: slugify(path.basename(name, ext)),
      fileName: name,
      path: `${sub}/${name}`,
      mimeType,
      fileSize: buffer.length,
      width: dims.width,
      height: dims.height,
      altText: fields.alt_text || '',
      caption: fields.caption || '',
      description: fields.description || '',
      authorId,
    },
  });
}

router.get('/', cached(), ah(async (req, res) => {
  const s = await store();
  const q = req.query;
  const c = parseCollection(q);
  const where = {};
  if (c.include) where.id = { in: c.include };
  if (c.exclude) where.id = { ...(where.id || {}), notIn: c.exclude };
  if (q.media_type) where.mimeType = q.media_type === 'image' ? { startsWith: 'image/' } : { not: { startsWith: 'image/' } };
  if (q.mime_type) where.mimeType = String(q.mime_type);
  if (q.slug) where.slug = String(q.slug);
  if (q.author) where.authorId = parseInt(q.author, 10);
  if (c.search) where.OR = [{ title: { startsWith: c.search } }, { fileName: { startsWith: c.search } }, { slug: { startsWith: c.search } }];
  const orderBy = c.orderby === 'id' ? { id: c.order } : c.orderby === 'title' ? { title: c.order } : { createdAt: c.order };
  const [total, rows] = await Promise.all([prisma.media.count({ where }), prisma.media.findMany({ where, orderBy, skip: c.skip, take: c.take })]);
  setPaginationHeaders(req, res, total, c);
  res.json(rows.map((m) => mediaOut(m, s)));
}));

// multipart/form-data with "file", or raw binary body with Content-Disposition (WP REST style)
router.post('/', can('upload_files'), upload.single('file'), express.raw({ type: () => true, limit: `${config.maxUploadMb}mb` }), ah(async (req, res) => {
  let buffer;
  let name;
  let mime;
  if (req.file) {
    buffer = req.file.buffer; name = req.file.originalname; mime = req.file.mimetype;
  } else if (Buffer.isBuffer(req.body) && req.body.length) {
    const disp = req.get('content-disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
    if (!m) throw badRequest('rest_upload_no_content_disposition', 'No Content-Disposition supplied.');
    buffer = req.body; name = decodeURIComponent(m[1]); mime = (req.get('content-type') || '').split(';')[0];
  } else {
    throw badRequest('rest_upload_no_data', 'No data supplied.');
  }
  const fields = req.file ? req.body : req.query;
  const media = await storeFile(buffer, name, mime, req.user.id, fields || {});
  res.status(201).json(mediaOut(media, await store()));
}));

async function find(id) {
  const m = await prisma.media.findUnique({ where: { id: intParam(id, 'rest_post_invalid_id') } });
  if (!m) throw new ApiError(404, 'rest_post_invalid_id', 'Invalid post ID.');
  return m;
}
router.get('/:id(\\d+)', cached(), ah(async (req, res) => res.json(mediaOut(await find(req.params.id), await store()))));
const update = ah(async (req, res) => {
  const m = await find(req.params.id);
  const b = req.body || {};
  const txt = (v) => (v && typeof v === 'object' ? (v.raw ?? v.rendered ?? '') : String(v ?? ''));
  const d = {};
  if (has(b, 'title')) d.title = txt(b.title);
  if (has(b, 'alt_text')) d.altText = String(b.alt_text);
  if (has(b, 'caption')) d.caption = txt(b.caption);
  if (has(b, 'description')) d.description = txt(b.description);
  res.json(mediaOut(await prisma.media.update({ where: { id: m.id }, data: d }), await store()));
});
router.post('/:id(\\d+)', can('upload_files'), update);
router.put('/:id(\\d+)', can('upload_files'), update);
router.patch('/:id(\\d+)', can('upload_files'), update);
router.delete('/:id(\\d+)', can('upload_files'), ah(async (req, res) => {
  if (!bool(req.query.force ?? req.body?.force)) throw new ApiError(501, 'rest_trash_not_supported', "The post does not support trashing. Set 'force=true' to delete.");
  const s = await store();
  const m = await find(req.params.id);
  const out = mediaOut(m, s);
  await prisma.media.delete({ where: { id: m.id } });
  if (!/^https?:/i.test(m.path)) {
    const file = path.join(config.uploadsDir, m.path);
    if (file.startsWith(config.uploadsDir)) fs.promises.unlink(file).catch(() => {});
  }
  res.json({ deleted: true, previous: out });
}));

module.exports = { router, storeFile };
