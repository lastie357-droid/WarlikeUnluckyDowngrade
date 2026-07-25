#!/usr/bin/env node
/**
 * browser.js — Chromium with playwright-extra stealth plugin
 * Bypasses Cloudflare bot detection, phone viewport, shabiki.com
 *
 * Proxy: set KENYA_PROXY_URL=http://host:port (or socks5://host:port)
 *        to route through a Kenya proxy. Leave unset for direct connection.
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
        // Use 'load' so JS frameworks finish mounting before we return
        try {
          await page.goto(url, { waitUntil: 'load', timeout: 45000 });
        } catch(navErr) {
          // If full load times out, fall back to domcontentloaded result
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

// ── Graceful shutdown — close browser cleanly so Chrome saves session state ──
let context_ref = null;
async function gracefulShutdown(sig) {
  console.log(`[browser] ${sig} — closing browser cleanly…`);
  try {
    if (context_ref) await context_ref.close();
  } catch(e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── Shared Chromium launch args ──
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
  // Suppress "Restore pages?" and crash dialogs
  '--disable-session-crashed-bubble',
  '--suppress-message-center-popups',
  '--noerrdialogs',
  '--hide-crash-restore-bubble',
  // Session flags
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  // GPU: SwiftShader software renderer (Replit has no physical GPU)
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
];

// ── Stealth init script ──
const STEALTH_INIT = () => {
  delete Object.getPrototypeOf(navigator).webdriver;
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins',   { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en','sw'] });
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = {};
  window.chrome.loadTimes = function(){};
  window.chrome.csi = function(){};
  window.chrome.app = { isInstalled: false };
  window.ontouchstart = null;
  const origQuery = window.navigator.permissions &&
    window.navigator.permissions.query.bind(window.navigator.permissions);
  if (origQuery) {
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
  }
};

// ── Launch ──
(async () => {
  console.log(`[browser] Launching stealth Chromium on DISPLAY=${DISPLAY}`);

  // Optional proxy via environment variable
  const proxyUrl = process.env.KENYA_PROXY_URL || null;
  if (proxyUrl) {
    console.log(`[proxy] Using proxy from KENYA_PROXY_URL: ${proxyUrl}`);
  } else {
    console.log('[proxy] No KENYA_PROXY_URL set — connecting directly');
  }

  // Persistent context — saves cookies, localStorage, IndexedDB to disk
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`[browser] Profile dir: ${PROFILE_DIR}`);

  // Remove ONLY "Last Session/Tabs" — these trigger the "Restore pages?" dialog.
  // Do NOT remove "Current Session/Tabs" — those hold the active session state
  // that Chromium restores on the next launch.
  const restoreDialogFiles = [
    'Default/Last Session',
    'Default/Last Tabs',
  ];
  for (const f of restoreDialogFiles) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch(e) { /* ok if missing */ }
  }
  console.log('[browser] Cleared restore-dialog files ✓');

  const launchOptions = {
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
    args: CHROMIUM_ARGS,
  };

  const context = await playwrightChromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  await context.addInitScript(STEALTH_INIT);

  context_ref = context;
  context.on('close', () => { console.error('[browser] Context closed!'); process.exit(1); });

  // Use existing page if session was restored, otherwise open new one
  const pages = context.pages();
  page = pages.find(p => p.url() !== 'about:blank') || pages[0] || await context.newPage();

  const currentUrl = page.url();

  if (!currentUrl || currentUrl === 'about:blank' || currentUrl === 'chrome://newtab/') {
    // Fresh start — navigate to shabiki.com and wait for full JS load
    console.log('[browser] Navigating to shabiki.com …');
    try {
      await page.goto('https://shabiki.com', { waitUntil: 'load', timeout: 45000 });
      console.log('[browser] ✓ Loaded:', await page.title());
    } catch(e) {
      console.warn('[browser] Navigation warn (page may still render):', e.message);
      // Non-fatal — let the page continue loading in the background
    }
  } else {
    // Session restored — already on the right page, no navigation needed
    console.log('[browser] ✓ Session resumed at:', currentUrl);
    console.log('[browser] ✓ Page title:', await page.title().catch(() => '?'));
    // Dismiss any stale dialogs
    try { await page.keyboard.press('Escape'); } catch(e) { /* ignore */ }
  }

  // Keep the process alive
  await new Promise(() => {});
})().catch((e) => { console.error('[browser] Fatal:', e.message); process.exit(1); });
