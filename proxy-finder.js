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
const CACHE_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours
// Test against a subpage — the root often passes even on blocked proxies,
// but /login reveals whether Cloudflare will block navigation too
const TEST_URL      = 'https://shabiki.com/login';
const TEST_TIMEOUT  = 8;    // seconds (for curl) — fail fast
const MAX_PARALLEL  = 20;   // more parallel workers = faster scan

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

// ── Fetch Kenya proxies from ProxyScrape v4 JSON API (primary) ──
async function fetchProxyScrapeV4() {
  const url = 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=get_proxies&proxy_format=protocolipport&format=json&country=KE';
  try {
    const body = await fetchText(url, 15000);
    const data = JSON.parse(body);
    if (!Array.isArray(data.proxies)) return [];
    return data.proxies
      .filter(p => p.alive)
      .sort((a, b) => (b.uptime || 0) - (a.uptime || 0))   // highest uptime first
      .map(p => p.proxy);                                    // already "protocol://ip:port"
  } catch (e) {
    console.error('[proxy-finder] v4 API error:', e.message);
    return [];
  }
}

// ── Fetch all proxy candidates ──
async function fetchAllProxies() {
  // Primary: ProxyScrape v4 JSON — sorted by uptime, Kenya only
  const v4 = await fetchProxyScrapeV4();
  if (v4.length) {
    console.log(`[proxy-finder] ProxyScrape v4: ${v4.length} Kenya proxies`);
  }

  // Fallback text sources for extra coverage
  const sources = [
    'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&country=ke&protocol=http,socks5&proxy_format=protocolipport&format=text&timeout=10000',
    'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&country=ke&protocol=socks4&proxy_format=protocolipport&format=text&timeout=10000',
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/KE/data.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_geolocation/http.txt',
  ];

  const results = await Promise.allSettled(
    sources.map((url) => fetchText(url).catch(() => ''))
  );

  const all = new Set(v4);   // seed with v4 results (already sorted by uptime)
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    let text = r.value;
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

// ── Test one proxy with curl against shabiki.com ──
// Returns false if the proxy times out, errors, or hits a Cloudflare hard block.
function testProxy(proxy) {
  return new Promise((resolve) => {
    const tmpFile = `/tmp/proxy-test-${process.pid}-${Math.random().toString(36).slice(2)}.html`;
    const args = [
      '--silent', '--show-error',
      '--proxy', proxy,
      '--max-time', String(TEST_TIMEOUT),
      '--connect-timeout', '4',
      '-A', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.100 Mobile Safari/537.36',
      '--write-out', '%{http_code}',
      '--output', tmpFile,
      TEST_URL,
    ];
    execFile('curl', args, { timeout: (TEST_TIMEOUT + 3) * 1000 }, (err, stdout) => {
      let body = '';
      try { body = fs.readFileSync(tmpFile, 'utf8'); } catch(_) {}
      try { fs.unlinkSync(tmpFile); } catch(_) {}

      if (err) return resolve(false);
      const code = parseInt(stdout.trim(), 10);
      if (code < 200 || code >= 400) return resolve(false);

      // Reject Cloudflare hard blocks — proxy IP is blacklisted
      if (/you have been blocked/i.test(body) || /access denied/i.test(body)) {
        return resolve(false);
      }
      resolve(true);
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

  // De-duplicate preserving order (v4 uptime-sorted proxies come first)
  proxies = [...new Set(proxies)];
  // Only shuffle the tail (extras beyond the v4 set) so best proxies stay up front
  const v4Count = Math.min(proxies.length, 10); // v4 returned at most ~10 KE proxies
  const head = proxies.slice(0, v4Count);
  const tail = proxies.slice(v4Count);
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  proxies = [...head, ...tail];

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
