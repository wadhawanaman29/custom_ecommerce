// Serializes Product rows into the exact WooCommerce REST v3 product / variation shape.
const prisma = require('../db');
const config = require('../config');
const { price, wpDate, wpDateGmt, mediaUrl, metaOut } = require('../lib/format');
const { priceHtml } = require('../lib/currency');
const { slugify } = require('../lib/slug');

const API = `${config.siteUrl}/wp-json/wc/v3`;

const productInclude = {
  categories: { select: { id: true, name: true, slug: true } },
  tags: { select: { id: true, name: true, slug: true } },
  images: { include: { media: true }, orderBy: { position: 'asc' } },
  attributes: { orderBy: { position: 'asc' } },
  shippingClass: { select: { id: true, slug: true } },
  variations: {
    where: { status: { not: 'trash' } },
    select: { id: true, price: true, regularPrice: true, salePrice: true, status: true, dateOnSaleFrom: true, dateOnSaleTo: true },
    orderBy: [{ menuOrder: 'asc' }, { id: 'asc' }],
  },
};

const variationInclude = {
  images: { include: { media: true }, orderBy: { position: 'asc' }, take: 1 },
  shippingClass: { select: { id: true, slug: true } },
  parent: { select: { id: true, slug: true, status: true, name: true } },
};

const isOnSale = (p, now = new Date()) => {
  if (p.salePrice === null || p.salePrice === undefined) return false;
  if (p.regularPrice !== null && Number(p.salePrice) >= Number(p.regularPrice)) return false;
  if (p.dateOnSaleFrom && p.dateOnSaleFrom > now) return false;
  if (p.dateOnSaleTo && p.dateOnSaleTo < now) return false;
  return true;
};

function imageOut(media, s) {
  if (!media) return null;
  return {
    id: media.id,
    date_created: wpDate(media.createdAt, s.gmtOffset),
    date_created_gmt: wpDateGmt(media.createdAt),
    date_modified: wpDate(media.updatedAt, s.gmtOffset),
    date_modified_gmt: wpDateGmt(media.updatedAt),
    src: mediaUrl(media.path),
    name: media.title || media.fileName,
    alt: media.altText || '',
  };
}

function dates(p, s) {
  return {
    date_created: wpDate(p.createdAt, s.gmtOffset),
    date_created_gmt: wpDateGmt(p.createdAt),
    date_modified: wpDate(p.updatedAt, s.gmtOffset),
    date_modified_gmt: wpDateGmt(p.updatedAt),
  };
}

function saleDates(p, s) {
  return {
    date_on_sale_from: wpDate(p.dateOnSaleFrom, s.gmtOffset),
    date_on_sale_from_gmt: wpDateGmt(p.dateOnSaleFrom),
    date_on_sale_to: wpDate(p.dateOnSaleTo, s.gmtOffset),
    date_on_sale_to_gmt: wpDateGmt(p.dateOnSaleTo),
  };
}

function stockFields(p) {
  const backordersAllowed = p.backorders !== 'no';
  return {
    manage_stock: p.manageStock,
    stock_quantity: p.manageStock ? p.stockQuantity : null,
    stock_status: p.stockStatus,
    backorders: p.backorders,
    backorders_allowed: backordersAllowed,
    backordered: p.manageStock && backordersAllowed && (p.stockQuantity ?? 0) < 0,
    low_stock_amount: p.lowStockAmount ?? null,
  };
}

const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(Boolean) : []);

// Related products: same categories/tags, published, excluding self/upsells/cross-sells (max 5, like WC).
async function relatedMap(products) {
  const out = new Map();
  const catIds = [...new Set(products.flatMap((p) => (p.categories || []).map((c) => c.id)))];
  const tagIds = [...new Set(products.flatMap((p) => (p.tags || []).map((t) => t.id)))];
  if (!catIds.length && !tagIds.length) return out;
  const OR = [];
  if (catIds.length) OR.push({ categories: { some: { id: { in: catIds } } } });
  if (tagIds.length) OR.push({ tags: { some: { id: { in: tagIds } } } });
  const candidates = await prisma.product.findMany({
    where: { status: 'publish', type: { not: 'variation' }, catalogVisibility: { not: 'hidden' }, OR },
    select: { id: true, categories: { select: { id: true } }, tags: { select: { id: true } } },
    take: 1000,
  });
  for (const p of products) {
    const pc = new Set((p.categories || []).map((c) => c.id));
    const pt = new Set((p.tags || []).map((t) => t.id));
    const exclude = new Set([p.id, ...ids(p.upsellIds), ...ids(p.crossSellIds)]);
    const matches = candidates
      .filter((c) => !exclude.has(c.id) && (c.categories.some((x) => pc.has(x.id)) || c.tags.some((x) => pt.has(x.id))))
      .map((c) => c.id);
    // shuffle like WC (random selection)
    for (let i = matches.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [matches[i], matches[j]] = [matches[j], matches[i]];
    }
    out.set(p.id, matches.slice(0, 5));
  }
  return out;
}

function serializeProduct(p, s, extra = {}) {
  const now = new Date();
  const isVariable = p.type === 'variable';
  const vars = (p.variations || []).filter((v) => v.status === 'publish');
  const varPrices = vars.map((v) => v.price).filter((x) => x !== null).map(Number);
  const min = varPrices.length ? Math.min(...varPrices) : null;
  const max = varPrices.length ? Math.max(...varPrices) : null;
  const onSale = isVariable ? vars.some((v) => isOnSale(v, now)) : isOnSale(p, now);
  const priceVal = isVariable ? (min === null ? '' : price(min)) : price(p.price);
  const shippingRequired = !p.virtual;

  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    permalink: `${config.frontendUrl}/product/${p.slug}/`,
    ...dates(p, s),
    type: p.type,
    status: p.status,
    featured: p.featured,
    catalog_visibility: p.catalogVisibility,
    description: p.description,
    short_description: p.shortDescription,
    sku: p.sku || '',
    price: priceVal,
    regular_price: isVariable ? '' : price(p.regularPrice),
    sale_price: isVariable ? '' : (onSale || p.salePrice !== null ? price(p.salePrice) : ''),
    ...saleDates(p, s),
    price_html: priceHtml({ type: p.type, price: p.price, regularPrice: p.regularPrice, onSale, min, max }, s),
    on_sale: onSale,
    purchasable: priceVal !== '' && p.status === 'publish',
    total_sales: p.totalSales,
    virtual: p.virtual,
    downloadable: p.downloadable,
    downloads: p.downloads || [],
    download_limit: p.downloadLimit,
    download_expiry: p.downloadExpiry,
    external_url: p.externalUrl,
    button_text: p.buttonText,
    tax_status: p.taxStatus,
    tax_class: p.taxClass,
    ...stockFields(p),
    sold_individually: p.soldIndividually,
    weight: p.weight,
    dimensions: { length: p.length, width: p.width, height: p.height },
    shipping_required: shippingRequired,
    shipping_taxable: shippingRequired && ['taxable', 'shipping'].includes(p.taxStatus),
    shipping_class: p.shippingClass ? p.shippingClass.slug : '',
    shipping_class_id: p.shippingClassId || 0,
    reviews_allowed: p.reviewsAllowed,
    average_rating: Number(p.averageRating).toFixed(2),
    rating_count: p.ratingCount,
    related_ids: extra.relatedIds || [],
    upsell_ids: ids(p.upsellIds),
    cross_sell_ids: ids(p.crossSellIds),
    parent_id: p.parentId || 0,
    purchase_note: p.purchaseNote,
    categories: (p.categories || []).map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
    tags: (p.tags || []).map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
    images: (p.images || []).map((i) => imageOut(i.media, s)).filter(Boolean),
    attributes: (p.attributes || []).map((a) => ({
      id: a.attributeId,
      name: a.name,
      slug: a.attributeId ? `pa_${extra.attributeSlugs?.get(a.attributeId) || slugify(a.name)}` : slugify(a.name),
      position: a.position,
      visible: a.visible,
      variation: a.variation,
      options: Array.isArray(a.options) ? a.options : [],
    })),
    default_attributes: Array.isArray(p.defaultAttributes) ? p.defaultAttributes : [],
    variations: (p.variations || []).map((v) => v.id),
    grouped_products: ids(p.groupedProducts),
    menu_order: p.menuOrder,
    meta_data: metaOut(p.meta),
    has_options: isVariable || p.type === 'grouped' || (p.attributes || []).some((a) => a.variation),
    post_password: '',
    global_unique_id: '',
    _links: {
      self: [{ href: `${API}/products/${p.id}` }],
      collection: [{ href: `${API}/products` }],
    },
  };
}

function serializeVariation(v, s) {
  const onSale = isOnSale(v);
  const shippingRequired = !v.virtual;
  const img = v.images && v.images[0] ? imageOut(v.images[0].media, s) : null;
  const parentSlug = v.parent ? v.parent.slug : '';
  return {
    id: v.id,
    type: 'variation',
    ...dates(v, s),
    description: v.description,
    permalink: `${config.frontendUrl}/product/${parentSlug}/?${(v.variationAttributes || []).map((a) => `attribute_${a.id ? `pa_${slugify(a.name)}` : slugify(a.name)}=${encodeURIComponent(a.option)}`).join('&')}`,
    sku: v.sku || '',
    global_unique_id: '',
    price: price(v.price),
    regular_price: price(v.regularPrice),
    sale_price: v.salePrice !== null ? price(v.salePrice) : '',
    ...saleDates(v, s),
    on_sale: onSale,
    status: v.status,
    purchasable: v.price !== null && v.status === 'publish' && (!v.parent || v.parent.status === 'publish'),
    virtual: v.virtual,
    downloadable: v.downloadable,
    downloads: v.downloads || [],
    download_limit: v.downloadLimit,
    download_expiry: v.downloadExpiry,
    tax_status: v.taxStatus,
    tax_class: v.taxClass,
    ...stockFields(v),
    weight: v.weight,
    dimensions: { length: v.length, width: v.width, height: v.height },
    shipping_class: v.shippingClass ? v.shippingClass.slug : '',
    shipping_class_id: v.shippingClassId || 0,
    image: img,
    attributes: Array.isArray(v.variationAttributes) ? v.variationAttributes.map((a) => ({ id: a.id || 0, name: a.name, slug: a.id ? `pa_${slugify(a.name)}` : slugify(a.name), option: a.option })) : [],
    menu_order: v.menuOrder,
    meta_data: metaOut(v.meta),
    name: v.name,
    parent_id: v.parentId,
    shipping_required: shippingRequired,
    _links: {
      self: [{ href: `${API}/products/${v.parentId}/variations/${v.id}` }],
      collection: [{ href: `${API}/products/${v.parentId}/variations` }],
      up: [{ href: `${API}/products/${v.parentId}` }],
    },
  };
}

async function attributeSlugMap() {
  const attrs = await prisma.attribute.findMany({ select: { id: true, slug: true } });
  return new Map(attrs.map((a) => [a.id, a.slug]));
}

// Serialize a list efficiently (one query for related ids, one for attribute slugs)
async function serializeProducts(products, s) {
  const [related, attributeSlugs] = await Promise.all([relatedMap(products), attributeSlugMap()]);
  return products.map((p) => serializeProduct(p, s, { relatedIds: related.get(p.id) || [], attributeSlugs }));
}

module.exports = {
  productInclude, variationInclude, serializeProducts, serializeVariation, imageOut, isOnSale,
};
