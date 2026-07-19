#!/usr/bin/env node
/**
 * browser.js — Chromium with playwright-extra stealth plugin
 * Bypasses Cloudflare bot detection, phone viewport, shabiki.com
 */
const { chromium: playwrightChromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const net = require('net');
const fs  = require('fs');

playwrightChromium.use(StealthPlugin());

const DISPLAY       = process.env.DISPLAY || ':99';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || 'chromium';
const CMD_SOCKET    = '/tmp/browser-cmd.sock';

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

// ── Launch ──
(async () => {
  console.log(`[browser] Launching stealth Chromium on DISPLAY=${DISPLAY}`);

  const browser = await playwrightChromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: false,
    env: { ...process.env, DISPLAY },
    args: [
      `--window-size=${PHONE_W},${PHONE_H}`,
      '--window-position=0,0',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--mute-audio',
      '--lang=en-US',
      '--flag-switches-begin',
      '--flag-switches-end',
    ],
  });

  const context = await browser.newContext({
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

  page = await context.newPage();

  console.log('[browser] Navigating to shabiki.com …');
  try {
    await page.goto('https://shabiki.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    console.log('[browser] ✓ Loaded:', await page.title());
  } catch(e) {
    console.error('[browser] Navigation error:', e.message);
  }

  browser.on('disconnected', () => { console.error('[browser] Disconnected!'); process.exit(1); });
  await new Promise(() => {});
})().catch((e) => { console.error('[browser] Fatal:', e.message); process.exit(1); });
