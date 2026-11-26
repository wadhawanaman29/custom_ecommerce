// Index-friendly search for large tables.
// FULLTEXT (MATCH … AGAINST in boolean mode, prefix matching) instead of LIKE '%term%',
// which would scan every row. Returns matching IDs (capped) to combine with other filters.
const prisma = require('../db');

const MAX_IDS = 5000;
// InnoDB ignores tokens shorter than innodb_ft_min_token_size (default 3)
const MIN_TOKEN = 3;

function words(term) {
  return String(term || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

// "john smi" → "+john* +smi*"
function booleanQuery(term) {
  return words(term).filter((w) => w.length >= MIN_TOKEN).map((w) => `+${w}*`).join(' ');
}

// table/columns must match a @@fulltext index exactly
async function fulltextIds(table, columns, term, limit = MAX_IDS) {
  const q = booleanQuery(term);
  if (!q) return null; // nothing indexable → caller falls back to a prefix search
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM \`${table}\` WHERE MATCH(${columns.map((c) => `\`${c}\``).join(', ')}) AGAINST (? IN BOOLEAN MODE) LIMIT ${Number(limit)}`,
    q,
  );
  return rows.map((r) => Number(r.id));
}

// Combines FULLTEXT IDs with optional prefix (index range) conditions into a Prisma where clause.
// prefixFields: columns with a normal index where "starts with" is useful (email, sku, code…)
async function searchWhere(table, columns, term, prefixFields = []) {
  const t = String(term || '').trim();
  if (!t) return null;
  const OR = prefixFields.map((f) => ({ [f]: { startsWith: t } }));
  const ids = await fulltextIds(table, columns, t);
  if (ids && ids.length) OR.push({ id: { in: ids } });
  if (!OR.length) return { id: { in: [] } };
  return { OR };
}

module.exports = { fulltextIds, searchWhere, booleanQuery, words };
