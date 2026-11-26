const config = require('../config');

// Parses WP/WC collection params: page, per_page, offset, order, orderby, include, exclude.
function parseCollection(query, { maxPerPage = 100, defaultPerPage = 10, defaultOrder = 'desc' } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  let perPage = parseInt(query.per_page, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = defaultPerPage;
  // WP allows per_page=-1 on some endpoints; we cap it.
  perPage = Math.min(perPage, maxPerPage);
  const offset = query.offset !== undefined ? Math.max(0, parseInt(query.offset, 10) || 0) : (page - 1) * perPage;
  const order = String(query.order || defaultOrder).toLowerCase() === 'asc' ? 'asc' : 'desc';
  return {
    page,
    perPage,
    skip: offset,
    take: perPage,
    order,
    orderby: query.orderby ? String(query.orderby) : undefined,
    include: idList(query.include),
    exclude: idList(query.exclude),
    search: query.search ? String(query.search) : undefined,
  };
}

// Accepts "1,2,3", ["1","2"], include[]=1&include[]=2
function idList(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const ids = arr.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
  return ids.length ? ids : undefined;
}

function strList(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = arr.map((s) => String(s).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

// Sets X-WP-Total, X-WP-TotalPages and Link headers like WordPress.
function setPaginationHeaders(req, res, total, { page, perPage }) {
  const totalPages = perPage > 0 ? Math.ceil(total / perPage) : 1;
  res.set('X-WP-Total', String(total));
  res.set('X-WP-TotalPages', String(totalPages));
  const base = `${config.siteUrl}${req.baseUrl}${req.path}`;
  const params = new URLSearchParams(req.query);
  const links = [];
  if (page > 1) {
    params.set('page', String(page - 1));
    links.push(`<${base}?${params}>; rel="prev"`);
  }
  if (page < totalPages) {
    params.set('page', String(page + 1));
    links.push(`<${base}?${params}>; rel="next"`);
  }
  if (links.length) res.set('Link', links.join(', '));
}

module.exports = { parseCollection, setPaginationHeaders, idList, strList };
