// Verifies every WordPress password hash format, so migrated users keep their passwords:
//  - phpass portable ($P$ / $H$): WordPress < 6.8
//  - "$wp$2y$...": WordPress >= 6.8 (bcrypt over HMAC-SHA384)
//  - plain bcrypt ($2y$ / $2a$ / $2b$)
//  - legacy 32-char MD5
// New hashes are plain bcrypt. Call needsRehash() after a successful login to upgrade old hashes.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function encode64(input, count) {
  let out = '';
  let i = 0;
  do {
    let value = input[i++];
    out += ITOA64[value & 0x3f];
    if (i < count) value |= input[i] << 8;
    out += ITOA64[(value >> 6) & 0x3f];
    if (i++ >= count) break;
    if (i < count) value |= input[i] << 16;
    out += ITOA64[(value >> 12) & 0x3f];
    if (i++ >= count) break;
    out += ITOA64[(value >> 18) & 0x3f];
  } while (i < count);
  return out;
}

function phpassCheck(password, stored) {
  const setting = stored.substring(0, 12);
  const countLog2 = ITOA64.indexOf(setting[3]);
  if (countLog2 < 7 || countLog2 > 30) return false;
  const salt = setting.substring(4, 12);
  if (salt.length !== 8) return false;
  const pw = Buffer.from(password, 'utf8');
  let hash = crypto.createHash('md5').update(Buffer.concat([Buffer.from(salt, 'binary'), pw])).digest();
  for (let count = 1 << countLog2; count > 0; count--) {
    hash = crypto.createHash('md5').update(Buffer.concat([hash, pw])).digest();
  }
  const computed = setting + encode64(hash, 16);
  return timingSafeEqualStr(computed, stored);
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const normalizeBcrypt = (h) => h.replace(/^\$2y\$/, '$2a$');

async function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  if (stored.startsWith('$wp')) {
    const pre = crypto.createHmac('sha384', 'wp-sha384').update(password).digest('base64');
    return bcrypt.compare(pre, normalizeBcrypt(stored.substring(3)));
  }
  if (stored.startsWith('$P$') || stored.startsWith('$H$')) return phpassCheck(password, stored);
  if (/^\$2[aby]\$/.test(stored)) return bcrypt.compare(password, normalizeBcrypt(stored));
  if (/^[a-f0-9]{32}$/i.test(stored)) {
    return timingSafeEqualStr(crypto.createHash('md5').update(password).digest('hex'), stored.toLowerCase());
  }
  return false;
}

const hashPassword = (password) => bcrypt.hash(password, 10);
const needsRehash = (stored) => !/^\$2[ab]\$/.test(stored || '');

module.exports = { verifyPassword, hashPassword, needsRehash };
