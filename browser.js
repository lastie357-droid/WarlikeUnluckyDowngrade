#!/usr/bin/env node
/**
 * browser.js — Chromium with playwright-extra stealth plugin
 * Bypasses Cloudflare bot detection, phone viewport, shabiki.com
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
      // Disable features that block cross-origin iframes (Aviator game is iframed)
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
      // GPU: use SwiftShader software renderer so WebGL games (Aviator etc) work
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-webgl',
      '--enable-webgl2',
      '--enable-accelerated-2d-canvas',
      '--enable-unsafe-webgpu',
      '--no-sandbox',
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

  context_ref = context;  // expose to shutdown handler
  context.on('close', () => { console.error('[browser] Context closed!'); process.exit(1); });

  // Use existing page if session was restored, otherwise open new one
  const pages = context.pages();
  page = pages.find(p => p.url() !== 'about:blank') || pages[0] || await context.newPage();

  // Dismiss the "Restore pages?" bubble if it appears (press Escape)
  try {
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  } catch(e) { /* non-fatal */ }

  // If the page is blank or about:blank, navigate to shabiki
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === 'about:blank' || currentUrl === 'chrome://newtab/') {
    console.log('[browser] Navigating to shabiki.com …');
    try {
      await page.goto('https://shabiki.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('[browser] ✓ Loaded:', await page.title());
    } catch(e) {
      console.error('[browser] Navigation error:', e.message);
    }
  } else {
    console.log('[browser] ✓ Resumed session at:', currentUrl);
    // Still dismiss any restore popup on the resumed page
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch(e) {}
    console.log('[browser] ✓ Page title:', await page.title().catch(() => '?'));
  }
  await new Promise(() => {});
})().catch((e) => { console.error('[browser] Fatal:', e.message); process.exit(1); });
