#!/usr/bin/env node
/**
 * proxy-finder.js — Fetches fresh proxies, tests each one by actually fetching
 * a page through it (full HTTPS round-trip, not just a TCP CONNECT), and writes
 * the ordered working list to /tmp/kenya-proxies-working.txt.
 *
 * The first line of that file (or /tmp/best-kenya-proxy.txt) is what browser.js
 * will try first; it falls back through the list automatically.
 *
 * Exit 0 always — missing proxy is not fatal.
 */
'use strict';

const { execFile } = require('child_process');
const http  = require('http');
const https = require('https');
const fs    = require('fs');

const CACHE_FILE    = '/tmp/best-kenya-proxy.txt';
const LIST_FILE     = '/tmp/kenya-proxies-working.txt';
const CACHE_MAX_AGE = 25 * 60 * 1000;   // 25 min
const TEST_URL      = 'https://www.google.com/generate_204'; // lightweight, always up
const TEST_TIMEOUT  = 10;   // seconds (for curl)
const MAX_PARALLEL  = 14;

// ── Fetch text from a URL with a timeout ──
function fetchText(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Parse ip:port lines from raw text, preserving protocol prefix ──
function parseProxies(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    // Detect socks4/socks5 prefix
    const socksMatch = raw.match(/^(socks[45]):\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/i);
    if (socksMatch) {
      out.push(`${socksMatch[1].toLowerCase()}://${socksMatch[2]}:${socksMatch[3]}`);
      continue;
    }
    // HTTP/HTTPS or bare ip:port
    const clean = raw.replace(/^https?:\/\//i, '');
    const m     = clean.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/);
    if (m) out.push(`http://${m[1]}:${m[2]}`);
  }
  return out;
}

// ── Fetch all proxy candidates ──
async function fetchAllProxies() {
  const sources = [
    'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&country=ke&protocol=http,socks5&proxy_format=ipport&format=text&timeout=10000',
    'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&country=ke&protocol=socks4&proxy_format=ipport&format=text&timeout=10000',
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/KE/data.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_geolocation/http.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  ];

  const results = await Promise.allSettled(
    sources.map((url) => fetchText(url).catch(() => ''))
  );

  const all = new Set();
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    let text = r.value;
    // monosans annotated list — KE entries only
    if (sources[i].includes('monosans')) {
      text = text.split('\n').filter((l) => / KE[^A-Z]/.test(l) || /:KE/.test(l)).join('\n');
    }
    const proxies = parseProxies(text);
    const isKe    = i < 3;
    let count = 0;
    for (const p of proxies) {
      if (isKe || count < 40) { all.add(p); count++; }
    }
  });

  return [...all];
}

// ── Test one proxy with curl (full HTTPS round-trip) ──
// proxy is a full URL: http://ip:port  or  socks5://ip:port
function testProxy(proxy) {
  return new Promise((resolve) => {
    const args = [
      '--silent', '--show-error',
      '--proxy', proxy,           // already has protocol prefix
      '--max-time', String(TEST_TIMEOUT),
      '--connect-timeout', '6',
      '--write-out', '%{http_code}',
      '--output', '/dev/null',
      TEST_URL,
    ];
    execFile('curl', args, { timeout: (TEST_TIMEOUT + 2) * 1000 }, (err, stdout) => {
      if (err) return resolve(false);
      const code = parseInt(stdout.trim(), 10);
      resolve(code >= 200 && code < 400);
    });
  });
}

// ── Run up to MAX_PARALLEL tests concurrently ──
async function testBatch(proxies) {
  const working = [];
  let idx = 0;
  async function worker() {
    while (idx < proxies.length) {
      const proxy = proxies[idx++];
      const ok    = await testProxy(proxy);
      if (ok) {
        working.push(proxy);
        console.log(`[proxy-finder] ✓ WORKING: ${proxy}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, proxies.length) }, worker));
  return working;
}

// ── Main ──
(async () => {
  // Cache freshness check
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE) {
      const cached = fs.readFileSync(CACHE_FILE, 'utf8').trim();
      if (cached) {
        console.log(`[proxy-finder] Using cached proxy (${Math.round((Date.now()-stat.mtimeMs)/60000)}m old): ${cached}`);
        process.exit(0);
      }
    }
  } catch (_) {}

  console.log('[proxy-finder] Fetching proxy lists…');
  let proxies = [];
  try { proxies = await fetchAllProxies(); } catch(e) { console.error('[proxy-finder] Fetch error:', e.message); }

  // Shuffle for fair sampling
  proxies = [...new Set(proxies)];
  for (let i = proxies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [proxies[i], proxies[j]] = [proxies[j], proxies[i]];
  }

  console.log(`[proxy-finder] Testing ${proxies.length} proxies via curl (max parallel: ${MAX_PARALLEL})…`);

  if (!proxies.length) {
    console.log('[proxy-finder] No proxies found — direct connection');
    fs.writeFileSync(CACHE_FILE, '');
    fs.writeFileSync(LIST_FILE,  '');
    process.exit(0);
  }

  const working = await testBatch(proxies);

  if (!working.length) {
    console.log('[proxy-finder] No working proxies — direct connection');
    fs.writeFileSync(CACHE_FILE, '');
    fs.writeFileSync(LIST_FILE,  '');
  } else {
    console.log(`[proxy-finder] ${working.length} working proxies. Best: ${working[0]}`);
    fs.writeFileSync(CACHE_FILE, working[0]);
    fs.writeFileSync(LIST_FILE,  working.join('\n'));
  }
  process.exit(0);
})();
