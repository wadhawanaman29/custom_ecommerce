// Minimal HTTP client for Node 16 (no global fetch): JSON GET with auth, redirects, timeouts, retries,
// and streaming file downloads.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function request(url, { headers = {}, timeout = 60000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'CustomEcommerce-Importer/1.0', Accept: 'application/json', ...headers }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(request(new URL(res.headers.location, u).toString(), { headers, timeout, redirects: redirects - 1 }));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${timeout}ms: ${url}`)));
    req.on('error', reject);
  });
}

async function getJson(url, opts = {}, attempt = 1) {
  try {
    const res = await request(url, opts);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(text.replace(/^﻿/, '')); } catch { body = null; }
    if (res.statusCode >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return getJson(url, opts, attempt + 1);
    }
    if (res.statusCode >= 400 || body === null) {
      const msg = body && body.message ? body.message : text.slice(0, 200);
      const err = new Error(`HTTP ${res.statusCode} for ${url.replace(/consumer_(key|secret)=[^&]+/g, 'consumer_$1=***')}: ${msg}`);
      err.status = res.statusCode;
      err.code = body && body.code;
      throw err;
    }
    return { body, headers: res.headers };
  } catch (e) {
    if (!e.status && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return getJson(url, opts, attempt + 1);
    }
    throw e;
  }
}

// Streams a file to disk; returns { size, contentType }
async function download(url, dest, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: '*/*', ...(opts.headers || {}) } });
  if (res.statusCode >= 400) { res.resume(); throw new Error(`HTTP ${res.statusCode} downloading ${url}`); }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
  return { size: fs.statSync(dest).size, contentType: res.headers['content-type'] || '' };
}

module.exports = { getJson, download };
