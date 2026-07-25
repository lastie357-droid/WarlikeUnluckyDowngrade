#!/usr/bin/env node
/**
 * browser.js — Chromium with playwright-extra stealth + deep fingerprint spoofing
 *
 * Proxy priority:
 *   1. KENYA_PROXY_URL env var (explicit override)
 *   2. /tmp/best-kenya-proxy.txt  (written by proxy-finder.js at startup)
 *   3. Direct connection
 */
const { chromium: playwrightChromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const net  = require('net');
const fs   = require('fs');
const path = require('path');

playwrightChromium.use(StealthPlugin());

const DISPLAY       = process.env.DISPLAY || ':99';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || 'chromium';
const CMD_SOCKET    = '/tmp/browser-cmd.sock';
const PROFILE_DIR   = path.join(__dirname, 'browser-profile');
const PROXY_CACHE   = '/tmp/best-kenya-proxy.txt';
const PROXY_LIST    = '/tmp/kenya-proxies-working.txt';

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
        try {
          await page.goto(url, { waitUntil: 'load', timeout: 45000 });
        } catch(navErr) {
          console.warn('[browser] load timeout, page may be partially loaded:', navErr.message);
        }
        console.log('[browser] Navigated:', await page.title().catch(() => url));
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

      if (cmd.type === 'type') {
        const text = cmd.text || '';
        if (text.length === 0) return;
        console.log('[browser] Typing:', JSON.stringify(text));
        await page.keyboard.type(text, { delay: 30 });
      }
    } catch(e) { console.error('[ipc] error:', e.message); }
  });
});
ipc.listen(CMD_SOCKET, () => console.log('[ipc] Listening on', CMD_SOCKET));

// ── Graceful shutdown ──
let context_ref = null;
async function gracefulShutdown(sig) {
  console.log(`[browser] ${sig} — closing browser cleanly…`);
  try { if (context_ref) await context_ref.close(); } catch(e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── Chromium launch args ──
const CHROMIUM_ARGS = [
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
  '--disable-session-crashed-bubble',
  '--suppress-message-center-popups',
  '--noerrdialogs',
  '--hide-crash-restore-bubble',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  // GPU: SwiftShader software renderer
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
  // Make Chrome look like a real install
  '--enable-features=NetworkService,NetworkServiceLogging',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--password-store=basic',
  '--use-mock-keychain',
];

// ── Deep fingerprint init script — runs in every new page/frame ──
// Spoofs: webdriver flag, plugins, navigator APIs, screen, WebGL,
// canvas noise, audio fingerprint, battery, connection, permissions,
// chrome runtime object.
const STEALTH_INIT = () => {
  // ── 1. Remove all automation tells ──
  try { delete Object.getPrototypeOf(navigator).webdriver; } catch(_) {}
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  // ── 2. navigator.plugins — mimic Android Chrome (5 plugins) ──
  const makeFakePlugin = (name, desc, filename, mimeTypes) => {
    const plugin = Object.create(Plugin.prototype);
    Object.defineProperty(plugin, 'name',        { get: () => name });
    Object.defineProperty(plugin, 'description', { get: () => desc });
    Object.defineProperty(plugin, 'filename',    { get: () => filename });
    Object.defineProperty(plugin, 'length',      { get: () => mimeTypes.length });
    mimeTypes.forEach((mt, i) => Object.defineProperty(plugin, i, { get: () => mt }));
    return plugin;
  };
  const pdfMime = Object.create(MimeType.prototype);
  Object.defineProperty(pdfMime, 'type',        { get: () => 'application/pdf' });
  Object.defineProperty(pdfMime, 'description', { get: () => 'Portable Document Format' });
  Object.defineProperty(pdfMime, 'suffixes',    { get: () => 'pdf' });
  const fakePlugins = [
    makeFakePlugin('PDF Viewer',          'Portable Document Format', 'internal-pdf-viewer', [pdfMime]),
    makeFakePlugin('Chrome PDF Viewer',   'Portable Document Format', 'internal-pdf-viewer', [pdfMime]),
    makeFakePlugin('Chromium PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer', [pdfMime]),
    makeFakePlugin('Microsoft Edge PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer', [pdfMime]),
    makeFakePlugin('WebKit built-in PDF', 'Portable Document Format', 'internal-pdf-viewer', [pdfMime]),
  ];
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = Object.create(PluginArray.prototype);
      Object.defineProperty(arr, 'length', { get: () => fakePlugins.length });
      fakePlugins.forEach((p, i) => Object.defineProperty(arr, i, { get: () => p }));
      arr[Symbol.iterator] = function*() { for (const p of fakePlugins) yield p; };
      return arr;
    },
    configurable: true,
  });

  // ── 3. navigator.languages ──
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'sw'], configurable: true });

  // ── 4. navigator.platform ──
  Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l', configurable: true });

  // ── 5. navigator.vendor ──
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });

  // ── 6. navigator.hardwareConcurrency (Pixel 8 has 8 cores) ──
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });

  // ── 7. navigator.deviceMemory (4 GB) ──
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  } catch(_) {}

  // ── 8. navigator.maxTouchPoints ──
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });

  // ── 9. navigator.connection — LTE/4G Safaricom-like ──
  try {
    const conn = Object.create(NetworkInformation ? NetworkInformation.prototype : Object.prototype);
    Object.defineProperty(conn, 'effectiveType', { get: () => '4g' });
    Object.defineProperty(conn, 'type',          { get: () => 'cellular' });
    Object.defineProperty(conn, 'rtt',           { get: () => 100 });
    Object.defineProperty(conn, 'downlink',      { get: () => 7.5 });
    Object.defineProperty(conn, 'saveData',      { get: () => false });
    Object.defineProperty(navigator, 'connection', { get: () => conn, configurable: true });
  } catch(_) {}

  // ── 10. chrome runtime object — makes the page believe it is Chrome ──
  if (!window.chrome || typeof window.chrome !== 'object') window.chrome = {};
  window.chrome.runtime = {
    id: undefined,
    connect: () => {},
    sendMessage: () => {},
    onMessage: { addListener: () => {}, removeListener: () => {} },
    onConnect: { addListener: () => {}, removeListener: () => {} },
    getManifest: () => ({}),
    getURL: (p) => p,
    PlatformOs: { ANDROID: 'android' },
    PlatformArch: { ARM: 'arm' },
  };
  window.chrome.loadTimes = function() {
    return {
      commitLoadTime: Date.now() / 1000 - 0.35,
      connectionInfo: 'http/2+quic/46',
      finishDocumentLoadTime: Date.now() / 1000 - 0.1,
      finishLoadTime: Date.now() / 1000 - 0.05,
      firstPaintAfterLoadTime: 0,
      firstPaintTime: Date.now() / 1000 - 0.3,
      navigationType: 'Other',
      npnNegotiatedProtocol: 'h2',
      requestTime: Date.now() / 1000 - 0.5,
      startLoadTime: Date.now() / 1000 - 0.45,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
    };
  };
  window.chrome.csi = function() {
    return { startE: Date.now() - 500, onloadT: Date.now() - 200, pageT: 600, tran: 15 };
  };
  window.chrome.app = {
    isInstalled: false,
    getDetails: () => null,
    getIsInstalled: () => false,
    installState: () => {},
    runningState: () => 'cannot_run',
  };

  // ── 11. screen dimensions — match Pixel 8 (1080×2400 dp, scale 2.75→390×844 CSS) ──
  try {
    Object.defineProperty(window, 'screen', {
      get: () => {
        const s = Object.create(Screen.prototype);
        Object.defineProperty(s, 'width',       { get: () => 390  });
        Object.defineProperty(s, 'height',      { get: () => 844  });
        Object.defineProperty(s, 'availWidth',  { get: () => 390  });
        Object.defineProperty(s, 'availHeight', { get: () => 844  });
        Object.defineProperty(s, 'colorDepth',  { get: () => 24   });
        Object.defineProperty(s, 'pixelDepth',  { get: () => 24   });
        Object.defineProperty(s, 'orientation', {
          get: () => ({
            type: 'portrait-primary',
            angle: 0,
            onchange: null,
            lock: () => Promise.resolve(),
            unlock: () => {},
          }),
        });
        return s;
      },
      configurable: true,
    });
  } catch(_) {}

  // ── 12. window.devicePixelRatio ──
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 2.75, configurable: true });

  // ── 13. WebGL — spoof Adreno 740 (Pixel 8 GPU) ──
  (function() {
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Google Inc. (Qualcomm)'; // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2 V@0563.0 (GIT@de2d2a4b4c, Id47e31d475) (Date:08/22/23))'; // UNMASKED_RENDERER_WEBGL
      if (param === 7937)  return 'WebKit WebGL';           // RENDERER
      if (param === 7936)  return 'WebKit';                 // VENDOR
      if (param === 7938)  return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'; // VERSION
      return getParam.call(this, param);
    };
    // WebGL2 as well
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Google Inc. (Qualcomm)';
        if (param === 37446) return 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2 V@0563.0 (GIT@de2d2a4b4c, Id47e31d475) (Date:08/22/23))';
        if (param === 7937)  return 'WebKit WebGL';
        if (param === 7936)  return 'WebKit';
        if (param === 7938)  return 'WebGL 2.0 (OpenGL ES 3.0 Chromium)';
        return getParam2.call(this, param);
      };
    }
  })();

  // ── 14. Canvas fingerprint noise — deterministic per session ──
  (function() {
    const SEED = Math.floor(Math.random() * 1000);
    function noise() { return (SEED % 5) * 0.0001; }
    const origToDataURL  = HTMLCanvasElement.prototype.toDataURL;
    const origGetCtx     = HTMLCanvasElement.prototype.getContext;
    const origToBlob     = HTMLCanvasElement.prototype.toBlob;

    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      const ctx = origGetCtx.call(this, '2d');
      if (ctx) {
        const d = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
        if (d.data[0] !== 0 || d.data[1] !== 0) {
          // Add invisible noise to the last few pixels
          for (let i = 0; i < Math.min(4, d.data.length - 4); i += 4) {
            d.data[d.data.length - 4 + i] = Math.max(0, d.data[d.data.length - 4 + i] + (SEED % 3));
          }
          ctx.putImageData(d, 0, 0);
        }
      }
      return origToDataURL.call(this, type, quality);
    };
  })();

  // ── 15. Audio context fingerprint noise ──
  (function() {
    try {
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function(channel) {
        const data = origGetChannelData.call(this, channel);
        for (let i = 0; i < Math.min(100, data.length); i++) {
          data[i] += Math.random() * 0.000001;
        }
        return data;
      };
    } catch(_) {}
  })();

  // ── 16. Battery API — 87% charge, not charging ──
  try {
    navigator.getBattery = () => Promise.resolve({
      charging: false,
      chargingTime: Infinity,
      dischargingTime: 18000,
      level: 0.87,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  } catch(_) {}

  // ── 17. Permissions API — override notifications to match reality ──
  try {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(params).catch(() => Promise.resolve({ state: 'granted', onchange: null }));
    };
  } catch(_) {}

  // ── 18. Media devices — return plausible device list ──
  try {
    const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
      { deviceId: 'default', groupId: 'group1', kind: 'audioinput',  label: '' },
      { deviceId: 'default', groupId: 'group1', kind: 'audiooutput', label: '' },
      { deviceId: 'default', groupId: 'group2', kind: 'videoinput',  label: '' },
    ]);
  } catch(_) {}

  // ── 19. Touch events ──
  window.ontouchstart = null;
  window.ontouchend   = null;
  window.ontouchmove  = null;

  // ── 20. User-Agent Client Hints (UA-CH) — match Pixel 8 / Chrome 138 ──
  try {
    const uaData = {
      brands: [
        { brand: 'Chromium',      version: '138' },
        { brand: 'Google Chrome', version: '138' },
        { brand: 'Not-A.Brand',   version: '99'  },
      ],
      mobile: true,
      platform: 'Android',
      getHighEntropyValues: (hints) => Promise.resolve({
        brands: [
          { brand: 'Chromium',      version: '138' },
          { brand: 'Google Chrome', version: '138' },
          { brand: 'Not-A.Brand',   version: '99'  },
        ],
        mobile: true,
        platform: 'Android',
        platformVersion: '14.0.0',
        architecture: 'arm',
        bitness: '64',
        model: 'Pixel 8',
        uaFullVersion: '138.0.7204.100',
        fullVersionList: [
          { brand: 'Chromium',      version: '138.0.7204.100' },
          { brand: 'Google Chrome', version: '138.0.7204.100' },
          { brand: 'Not-A.Brand',   version: '99.0.0.0'       },
        ],
      }),
    };
    Object.defineProperty(navigator, 'userAgentData', { get: () => uaData, configurable: true });
  } catch(_) {}

  // ── 21. Prevent iframe detection of automation ──
  try {
    Object.defineProperty(document, 'hidden',           { get: () => false });
    Object.defineProperty(document, 'visibilityState',  { get: () => 'visible' });
    Object.defineProperty(document, 'hasFocus',         { value: () => true });
  } catch(_) {}
};

// ── Resolve proxy list (ordered candidates) ──
function resolveProxyList() {
  // 1. Explicit env override — single proxy, no rotation
  if (process.env.KENYA_PROXY_URL) {
    console.log(`[proxy] Using KENYA_PROXY_URL: ${process.env.KENYA_PROXY_URL}`);
    return [process.env.KENYA_PROXY_URL];
  }

  // 2. Full working list from proxy-finder.js
  const candidates = [];
  try {
    const list = fs.readFileSync(PROXY_LIST, 'utf8').trim();
    for (const line of list.split('\n')) {
      const raw = line.trim();
      if (!raw) continue;
      // Entries from proxy-finder.js are already full URLs (http:// or socks5://)
      candidates.push(raw);
    }
  } catch(_) {}

  // Fallback: single best-proxy cache file
  if (!candidates.length) {
    try {
      const cached = fs.readFileSync(PROXY_CACHE, 'utf8').trim();
      if (cached) {
        // Cache file stores full URL too
        candidates.push(cached);
      }
    } catch(_) {}
  }

  if (candidates.length) {
    console.log(`[proxy] ${candidates.length} Kenya proxy candidate(s): ${candidates[0]}${candidates.length > 1 ? ` (+${candidates.length-1} fallback)` : ''}`);
  } else {
    console.log('[proxy] No proxy available — connecting directly');
  }
  return candidates; // empty = direct connection
}

// ── Build launch options for a given proxy (or null for direct) ──
function buildLaunchOptions(proxyUrl) {
  return {
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
      'Accept-Language': 'en-US,en;q=0.9,sw;q=0.8',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'sec-ch-ua': '"Chromium";v="138", "Google Chrome";v="138", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-ch-ua-platform-version': '"14.0.0"',
      'sec-ch-ua-model': '"Pixel 8"',
      'sec-ch-ua-arch': '"arm"',
      'sec-ch-ua-bitness': '"64"',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1',
    },
    args: CHROMIUM_ARGS,
  };
}

// ── Try to launch with a proxy and navigate to shabiki.com ──
// Returns the context+page on success, throws on unrecoverable error.
// Returns null if the proxy fails (so caller can try next one).
async function tryLaunch(proxyUrl) {
  const label = proxyUrl || 'direct';
  console.log(`[browser] Trying ${label} …`);

  const context = await playwrightChromium.launchPersistentContext(
    PROFILE_DIR,
    buildLaunchOptions(proxyUrl)
  );
  await context.addInitScript(STEALTH_INIT);
  context_ref = context;

  const pages = context.pages();
  const p = pages.find(pg => pg.url() !== 'about:blank') || pages[0] || await context.newPage();

  const currentUrl = p.url();
  if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== 'chrome://newtab/') {
    // Session restored
    console.log('[browser] ✓ Session resumed at:', currentUrl);
    return { context, page: p };
  }

  // Fresh start — navigate and check if we land somewhere real
  try {
    await p.goto('https://shabiki.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const url   = p.url();
    const title = await p.title().catch(() => '');

    // Detect hard failures
    if (url.startsWith('chrome-error://') || url === 'about:blank') {
      console.warn(`[browser] Proxy ${label} failed — page error at ${url}`);
      try { await context.close(); } catch(_) {}
      context_ref = null;
      return null;
    }

    // Detect Cloudflare hard block ("Sorry, you have been blocked")
    // This means the proxy IP is blacklisted — try next proxy
    const bodyText = await p.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (
      /you have been blocked/i.test(bodyText) ||
      /Access denied/i.test(title) ||
      /Attention Required/i.test(title) && /blocked/i.test(bodyText)
    ) {
      console.warn(`[browser] Proxy ${label} → Cloudflare hard block — trying next proxy`);
      try { await context.close(); } catch(_) {}
      context_ref = null;
      return null;
    }

    // Cloudflare JS challenge is OK — stealth should pass it
    if (/Just a moment/i.test(title) || /Checking your browser/i.test(bodyText)) {
      console.log(`[browser] Cloudflare JS challenge via ${label} — stealth will handle it`);
      // Wait a few seconds for challenge to auto-resolve
      await p.waitForTimeout(5000).catch(() => {});
    }

    console.log(`[browser] ✓ Loaded via ${label}: "${title}" @ ${url}`);
    return { context, page: p };
  } catch(e) {
    const msg = e.message || '';
    const isProxyErr = /timeout|ECONNREFUSED|net::ERR_/i.test(msg);
    if (isProxyErr && proxyUrl) {
      console.warn(`[browser] Proxy ${label} failed: ${msg}`);
      try { await context.close(); } catch(_) {}
      context_ref = null;
      return null;      // try next proxy
    }
    // Non-proxy navigation warning — page may still render
    console.warn('[browser] Navigation warn (page may still render):', msg);
    return { context, page: p };
  }
}

// ── Launch ──
(async () => {
  console.log(`[browser] Launching stealth Chromium on DISPLAY=${DISPLAY}`);

  // Profile dir — persists cookies, localStorage, IndexedDB
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`[browser] Profile dir: ${PROFILE_DIR}`);

  // Remove restore-dialog files (trigger "Restore pages?" popup)
  for (const f of ['Default/Last Session', 'Default/Last Tabs']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch(_) {}
  }
  console.log('[browser] Cleared restore-dialog files ✓');

  // Build candidate list: [proxy1, proxy2, …, null (direct)]
  const proxyList  = resolveProxyList();
  const candidates = [...proxyList, null];  // null = direct connection fallback

  let result = null;
  for (const proxyUrl of candidates) {
    result = await tryLaunch(proxyUrl);
    if (result) {
      // Mark which proxy is active so next run starts with it
      if (proxyUrl) {
        // Store full URL (including protocol prefix) for consistent reload
        fs.writeFileSync(PROXY_CACHE, proxyUrl);
        console.log(`[proxy] Active proxy cached: ${proxyUrl}`);
      } else {
        // Direct worked — clear cache so finder re-tests next restart
        fs.writeFileSync(PROXY_CACHE, '');
        console.log('[proxy] Connected directly (no proxy)');
      }
      break;
    }
  }

  if (!result) {
    console.error('[browser] All proxy candidates and direct connection failed — exiting');
    process.exit(1);
  }

  const { context } = result;
  page = result.page;

  context_ref = context;
  context.on('close', () => { console.error('[browser] Context closed!'); process.exit(1); });

  // Keep the process alive
  await new Promise(() => {});
})().catch((e) => { console.error('[browser] Fatal:', e.message); process.exit(1); });
