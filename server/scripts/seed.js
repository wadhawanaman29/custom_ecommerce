// Fresh install defaults (like activating WordPress + WooCommerce).
// Usage: npm run seed -- --email admin@example.com --password secret [--key-only]
const crypto = require('crypto');
const prisma = require('../src/db');
const { hashPassword } = require('../src/lib/password');
const { hashConsumerKey } = require('../src/middleware/auth');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};

async function createApiKey(userId, description = 'Storefront', permissions = 'read_write') {
  const ck = `ck_${crypto.randomBytes(20).toString('hex')}`;
  const cs = `cs_${crypto.randomBytes(20).toString('hex')}`;
  await prisma.apiKey.create({
    data: { userId, description, permissions, consumerKey: hashConsumerKey(ck), consumerSecret: cs, truncatedKey: ck.slice(-7) },
  });
  return { ck, cs };
}

async function main() {
  const email = arg('email', process.env.ADMIN_EMAIL || 'admin@example.com');
  const password = arg('password', process.env.ADMIN_PASSWORD) || crypto.randomBytes(9).toString('base64');
  const login = arg('username', 'admin');

  let admin = await prisma.user.findFirst({ where: { role: 'administrator' } });
  if (!admin) {
    admin = await prisma.user.create({
      data: { login, email, passwordHash: await hashPassword(password), displayName: login, nicename: login, role: 'administrator' },
    });
    console.log(`Created administrator "${login}" <${email}> password: ${password}`);
  } else {
    console.log(`Administrator exists: ${admin.login} (#${admin.id})`);
  }

  if (!process.argv.includes('--key-only')) {
    const gateways = [
      { id: 'bacs', title: 'Direct bank transfer', description: 'Make your payment directly into our bank account. Please use your Order ID as the payment reference.', methodTitle: 'Direct bank transfer', order: 0 },
      { id: 'cheque', title: 'Check payments', description: 'Please send a check to Store Name, Store Street, Store Town, Store State / County, Store Postcode.', methodTitle: 'Check payments', order: 1 },
      { id: 'cod', title: 'Cash on delivery', description: 'Pay with cash upon delivery.', methodTitle: 'Cash on delivery', order: 2 },
    ];
    for (const g of gateways) {
      await prisma.paymentGateway.upsert({ where: { id: g.id }, create: { ...g, enabled: false }, update: {} });
    }
    for (const [slug, name] of [['reduced-rate', 'Reduced rate'], ['zero-rate', 'Zero rate']]) {
      await prisma.taxClass.upsert({ where: { slug }, create: { slug, name }, update: {} });
    }
    if (!(await prisma.productCategory.findUnique({ where: { slug: 'uncategorized' } }))) {
      await prisma.productCategory.create({ data: { name: 'Uncategorized', slug: 'uncategorized' } });
    }
    if (!(await prisma.term.findUnique({ where: { taxonomy_slug: { taxonomy: 'category', slug: 'uncategorized' } } }))) {
      await prisma.term.create({ data: { taxonomy: 'category', name: 'Uncategorized', slug: 'uncategorized' } });
    }
  }

  const { ck, cs } = await createApiKey(admin.id, arg('description', 'Storefront'), arg('permissions', 'read_write'));
  console.log('\nNew REST API key (shown once — save it):');
  console.log(`  Consumer key:    ${ck}`);
  console.log(`  Consumer secret: ${cs}`);
}

if (require.main === module) {
  main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
}

module.exports = { createApiKey };
