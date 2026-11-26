// WooCommerce-style batch endpoint: { create: [], update: [], delete: [] } (max 100 items total)
const { ApiError } = require('./http');

function errorOut(e, id) {
  const status = e.status || 500;
  const out = { error: { code: e.code && typeof e.code === 'string' && !e.code.startsWith('P') ? e.code : 'woocommerce_rest_batch_error', message: e.message, data: { status } } };
  if (id !== undefined) out.id = id;
  return out;
}

async function runBatch(body, { create, update, remove }) {
  const total = ['create', 'update', 'delete'].reduce((n, k) => n + (Array.isArray(body[k]) ? body[k].length : 0), 0);
  if (total > 100) throw new ApiError(413, 'woocommerce_rest_request_entity_too_large', 'Unable to accept more than 100 items for this request.');
  const result = {};
  if (Array.isArray(body.create)) {
    result.create = [];
    for (const item of body.create) {
      try { result.create.push(await create(item)); } catch (e) { result.create.push(errorOut(e)); }
    }
  }
  if (Array.isArray(body.update)) {
    result.update = [];
    for (const item of body.update) {
      try { result.update.push(await update(item.id, item)); } catch (e) { result.update.push(errorOut(e, item.id)); }
    }
  }
  if (Array.isArray(body.delete)) {
    result.delete = [];
    for (const id of body.delete) {
      try { result.delete.push(await remove(id)); } catch (e) { result.delete.push(errorOut(e, id)); }
    }
  }
  return result;
}

module.exports = { runBatch };
