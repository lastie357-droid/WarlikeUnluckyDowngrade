#!/usr/bin/env node
/**
 * browser.js — Chromium with playwright-extra stealth plugin
 * Bypasses Cloudflare bot detection, phone viewport, shabiki.com
 * Proxy rotation: Kenya proxies from proxyscrape.com
 */
const { chromium: playwrightChromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const net   = require('net');
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

// ── Proxy helpers ──────────────────────────────────────────────────────────

/** Fetch fresh Kenya proxy list from proxyscrape */
function fetchKenyaProxies() {
  return new Promise((resolve) => {
    const url =
      'https://api.proxyscrape.com/v3/free-proxy-list/get' +
      '?request=displayproxies&country=ke&protocol=http&anonymity=all&timeout=10000&limit=50';
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const proxies = data.trim().split('\n').map(p => p.trim()).filter(Boolean);
        console.log(`[proxy] Fetched ${proxies.length} Kenya proxies from proxyscrape`);
        resolve(proxies);
      });
    }).on('error', () => {
      console.warn('[proxy] Could not fetch live proxies, using fallback list');
      resolve([]);
    });
  });
}

/**
 * Test if a proxy supports HTTP CONNECT tunneling to shabiki.com:443.
 * More reliable than a plain TCP check — free proxies often accept TCP
 * but refuse or silently drop CONNECT requests.
 */
function proxySupportsConnect(host, port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let responded = false;
    const done = (ok) => {
      if (responded) return;
      responded = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(5000);
    sock.connect(port, host, () => {
      sock.write('CONNECT shabiki.com:443 HTTP/1.1\r\nHost: shabiki.com:443\r\nProxy-Connection: keep-alive\r\n\r\n');
    });
    sock.on('data', (data) => {
      const resp = data.toString();
      // 200 = tunnel established; anything else = proxy refused/unsupported
      done(resp.startsWith('HTTP/1.1 200') || resp.startsWith('HTTP/1.0 200'));
    });
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

/** Try each proxy; return first one that supports HTTP CONNECT, or null */
async function pickProxy(proxies) {
  for (const entry of proxies) {
    const [host, portStr] = entry.split(':');
    if (!host || !portStr) continue;
    const port = parseInt(portStr, 10);
    process.stdout.write(`[proxy] Testing ${entry} … `);
    if (await proxySupportsConnect(host, port)) {
      console.log('✓ CONNECT OK');
      return `http://${entry}`;
    }
    console.log('✗ CONNECT failed');
  }
  return null;
}

playwrightChromium.use(StealthPlugin());

const DISPLAY       = process.env.DISPLAY || ':99';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || 'chromium';
const CMD_SOCKET    = '/tmp/browser-cmd.sock';
// All cookies, localStorage, IndexedDB saved here — persists across restarts
const PROFILE_DIR   = path.join(__dirname, 'browser-profile');

const PHONE_W = 390;
const PHONE_H = 844;

let page;

// ── IPC server — receives commands from server.js ──
if (fs.existsSync(CMD_SOCKET)) fs.unlinkSync(CMD_SOCKET);

const ipc = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (d) => buf += d.toString());
  socket.on('end', async () => {
    try {
      const cmd = JSON.parse(buf);
      console.log('[ipc] cmd:', cmd);
      if (!page) return;

      if (cmd.type === 'navigate') {
        let url = cmd.url;
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('[browser] Navigated:', await page.title());
      }

      if (cmd.type === 'action') {
        switch (cmd.key) {
          case 'Back':       await page.goBack();   break;
          case 'Forward':    await page.goForward(); break;
          case 'Refresh':    await page.reload();    break;
          case 'ScrollUp':   await page.mouse.wheel(0, -400); break;
          case 'ScrollDown': await page.mouse.wheel(0,  400); break;
          case 'Home':
            await page.goto('https://shabiki.com', { waitUntil: 'domcontentloaded' });
            break;
          case 'Screenshot':
            await page.screenshot({ path: '/tmp/shabiki-screenshot.png', fullPage: false });
            console.log('[browser] Screenshot → /tmp/shabiki-screenshot.png');
            break;
          case 'Zoom+':
            await page.evaluate(() => { document.body.style.zoom = (parseFloat(document.body.style.zoom||1)+0.1).toFixed(1); });
            break;
          case 'Zoom-':
            await page.evaluate(() => { document.body.style.zoom = Math.max(0.5, parseFloat(document.body.style.zoom||1)-0.1).toFixed(1); });
            break;
          case 'Enter':      await page.keyboard.press('Enter'); break;
          case 'Tab':        await page.keyboard.press('Tab');   break;
          case 'Backspace':  await page.keyboard.press('Backspace'); break;
          case 'Escape':     await page.keyboard.press('Escape'); break;
          case 'ClearField':
            await page.keyboard.press('Control+a');
            await page.keyboard.press('Backspace');
            break;
        }
      }

      // Type / paste text into focused input field
      if (cmd.type === 'type') {
        const text = cmd.text || '';
        if (text.length === 0) return;
        console.log('[browser] Typing:', JSON.stringify(text));
        // click the focused element to ensure it's active, then type
        await page.keyboard.type(text, { delay: 30 });
      }
    } catch(e) { console.error('[ipc] error:', e.message); }
  });
});
ipc.listen(CMD_SOCKET, () => console.log('[ipc] Listening on', CMD_SOCKET));

// ── Graceful shutdown — close browser cleanly so Chrome saves session state
// and does NOT show "Restore pages?" on the next launch ──
let context_ref = null;   // set after launch
async function gracefulShutdown(sig) {
  console.log(`[browser] ${sig} — closing browser cleanly…`);
  try {
    if (context_ref) await context_ref.close();
  } catch(e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── Launch ──
(async () => {
  console.log(`[browser] Launching stealth Chromium on DISPLAY=${DISPLAY}`);

  // ── Proxy selection ──
  // Kenya proxies — http:// prefix = HTTP CONNECT proxy, socks5:// = SOCKS5
  const FALLBACK_PROXIES = [
    '41.79.9.229:8080',        // KE — TCP OK
    '154.79.251.168:1080',     // KE — TCP OK (try as socks5)
    '102.214.253.2:8080',
    '102.220.13.208:8080',
    '197.232.158.189:41890',
    '197.248.193.143:8080',
    '102.217.121.10:8080',
    '41.72.199.106:8089',
    '197.248.16.109:8080',
    '102.213.179.210:8080',
    '102.0.25.184:8080',
    '197.248.75.221:8105',
    '197.232.23.40:8080',
    '185.240.48.133:3128',
    '102.68.77.3:8080',
    '197.248.59.159:8082',
    '41.90.161.175:8080',
  ];
  const liveProxies = await fetchKenyaProxies();
  const allProxies  = [...new Set([...liveProxies, ...FALLBACK_PROXIES])];
  const proxyUrl    = await pickProxy(allProxies);
  if (proxyUrl) {
    console.log(`[proxy] Active proxy: ${proxyUrl}`);
  } else {
    console.warn('[proxy] No reachable Kenya proxy found — connecting directly');
  }

  // Persistent context — saves cookies, localStorage, IndexedDB to disk
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`[browser] Profile dir: ${PROFILE_DIR}`);

  // Delete Chromium's crash-state files so "Restore pages?" never appears.
  // These files are re-created on each clean launch; deleting them before
  // launch makes Chrome think there is nothing to restore.
  const crashFiles = [
    'Default/Current Session',
    'Default/Current Tabs',
    'Default/Last Session',
    'Default/Last Tabs',
  ];
  for (const f of crashFiles) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch(e) { /* ok if missing */ }
  }
  console.log('[browser] Cleared crash-state files ✓');

  const context = await playwrightChromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROMIUM_PATH,
    headless: false,
    env: { ...process.env, DISPLAY },
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    viewport: { width: PHONE_W, height: PHONE_H },
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/138.0.7204.100 Mobile Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Africa/Nairobi',
    geolocation: { latitude: -1.2921, longitude: 36.8219 },
    permissions: ['geolocation'],
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="138", "Google Chrome";v="138", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
    },
    args: [
      `--window-size=${PHONE_W},${PHONE_H}`,
      '--window-position=0,0',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      // Disable features that block cross-origin iframes
      '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
      '--disable-web-security',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      // Auto-restore last session silently — suppresses the "Restore pages?" dialog
      '--restore-last-session',
      '--disable-session-crashed-bubble',
      '--suppress-message-center-popups',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      // ── GPU: SwiftShader software renderer (Replit has no physical GPU)
      // SwiftShader enables WebGL/WebGL2/Canvas acceleration in a headless env.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--enable-webgl',
      '--enable-webgl2',
      '--enable-webgl-draft-extensions',
      '--enable-accelerated-2d-canvas',
      '--enable-accelerated-video-decode',
      '--enable-unsafe-webgpu',
      '--canvas-oop-rasterization',
      '--force-gpu-mem-available-mb=256',
      '--mute-audio',
      '--lang=en-US',
    ],
  });

  // Extra stealth patches on top of the plugin
  await context.addInitScript(() => {
    // Remove automation traces
    delete Object.getPrototypeOf(navigator).webdriver;
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Realistic plugin count
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en','sw'] });

    // Chrome runtime present (Cloudflare checks this)
    if (!window.chrome) window.chrome = {};
    window.chrome.runtime = {};
    window.chrome.loadTimes = function(){};
    window.chrome.csi = function(){};
    window.chrome.app = { isInstalled: false };

    // Touch support
    window.ontouchstart = null;

    // Permissions API spoof
    const origQuery = window.navigator.permissions && window.navigator.permissions.query.bind(window.navigator.permissions);
    if (origQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(params);
    }
  });

  function onContextClose() { console.error('[browser] Context closed unexpectedly!'); process.exit(1); }

  async function attachContext(ctx, isRetry) {
    context_ref = ctx;
    ctx.on('close', onContextClose);

    const pages = ctx.pages();
    page = pages.find(p => p.url() !== 'about:blank') || pages[0] || await ctx.newPage();

    // Dismiss any "Restore pages?" bubble
    try {
      await page.waitForTimeout(1200);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    } catch(e) { /* non-fatal */ }

    const currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank' || currentUrl === 'chrome://newtab/') {
      console.log('[browser] Navigating to shabiki.com …');
      try {
        await page.goto('https://shabiki.com', {
          waitUntil: 'domcontentloaded',
          timeout: isRetry ? 30000 : 18000,   // shorter timeout on first try (proxy)
        });
        console.log('[browser] ✓ Loaded:', await page.title());
        return true;   // navigation succeeded
      } catch(e) {
        console.error('[browser] Navigation error:', e.message);
        return false;  // navigation failed
      }
    } else {
      console.log('[browser] ✓ Resumed session at:', currentUrl);
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch(e) {}
      console.log('[browser] ✓ Page title:', await page.title().catch(() => '?'));
      return true;
    }
  }

  let navOk = await attachContext(context, !proxyUrl /* isRetry=true when no proxy */);

  // If navigation failed and we were using a proxy, relaunch without proxy
  if (!navOk && proxyUrl) {
    console.log('[browser] Proxy failed — relaunching without proxy for direct connection …');
    // Remove the close listener so our intentional close doesn't trigger process.exit
    try { context.removeListener('close', onContextClose); } catch(e) { /* ignore */ }
    try { await context.close(); } catch(e) { /* ignore */ }
    context_ref = null;
    page = null;

    const directCtx = await playwrightChromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: CHROMIUM_PATH,
      headless: false,
      env: { ...process.env, DISPLAY },
      viewport: { width: PHONE_W, height: PHONE_H },
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/138.0.7204.100 Mobile Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Africa/Nairobi',
      geolocation: { latitude: -1.2921, longitude: 36.8219 },
      permissions: ['geolocation'],
      deviceScaleFactor: 2.75,
      isMobile: true,
      hasTouch: true,
      colorScheme: 'light',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Chromium";v="138", "Google Chrome";v="138", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
      },
      args: [
        `--window-size=${PHONE_W},${PHONE_H}`,
        '--window-position=0,0',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
        '--disable-web-security',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--restore-last-session',
        '--disable-session-crashed-bubble',
        '--suppress-message-center-popups',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--enable-webgl',
        '--enable-webgl2',
        '--enable-webgl-draft-extensions',
        '--enable-accelerated-2d-canvas',
        '--enable-accelerated-video-decode',
        '--enable-unsafe-webgpu',
        '--canvas-oop-rasterization',
        '--force-gpu-mem-available-mb=256',
        '--mute-audio',
        '--lang=en-US',
      ],
    });

    // Re-apply stealth init scripts to the new context
    await directCtx.addInitScript(() => {
      delete Object.getPrototypeOf(navigator).webdriver;
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en','sw'] });
      if (!window.chrome) window.chrome = {};
      window.chrome.runtime = {};
      window.chrome.loadTimes = function(){};
      window.chrome.csi = function(){};
      window.chrome.app = { isInstalled: false };
      window.ontouchstart = null;
      const origQuery = window.navigator.permissions && window.navigator.permissions.query.bind(window.navigator.permissions);
      if (origQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params);
      }
    });

    await attachContext(directCtx, true);
  }

  await new Promise(() => {});
})().catch((e) => { console.error('[browser] Fatal:', e.message); process.exit(1); });
