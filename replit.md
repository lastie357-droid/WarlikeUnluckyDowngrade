# Shabiki Phone VNC Browser

A server-side phone browser that opens shabiki.com in a real Chromium instance, streams it via VNC, and exposes a phone-frame web UI you can control from any browser.

## Architecture

| Component | Role |
|-----------|------|
| **Xvfb** | Virtual display `:99` at 390×844 (phone size) |
| **Chromium** (via playwright-core) | Real browser, anti-bot stealth, Nairobi timezone/locale |
| **x11vnc** | VNC server on port 5900 streaming the virtual display |
| **server.js** | Express on port 5000 + WebSocket→TCP proxy (noVNC bridge) |
| **browser.js** | Playwright launcher + IPC command receiver |
| **public/index.html** | Phone-shell UI with noVNC canvas, coordinate display, controls |

## How to Run

Workflow: **Shabiki Phone Browser** (`bash start.sh`)

Start it from the Replit workflow panel. On boot it will:
1. Install npm dependencies
2. Start Xvfb virtual display + x11vnc VNC server
3. Run `proxy-finder.js` to test public Kenya proxies
4. Launch Chromium via `browser.js` (tries proxies in order, falls back to direct)
5. Start Express server on **port 5000** with noVNC WebSocket proxy

Open the preview to see the phone-frame UI with a live VNC stream.

## ⚠️ Proxy / Cloudflare Note

shabiki.com is protected by Cloudflare and blocks Replit's shared IP on direct connections. The built-in proxy finder tests public proxies, but these are often slow or also blocked. For reliable access, set a **`KENYA_PROXY_URL`** secret (e.g. `http://user:pass@host:port`) pointing to a paid Kenya proxy service — `browser.js` will use it automatically if set.

## Usage

Open the Replit preview — you'll see a phone frame streaming the live Chromium browser.  
- **Click anywhere** on the screen to send real clicks (ripple shows coordinates)  
- **Navigation bar** to type a URL and press Go  
- **Control buttons**: Back, Forward, Reload, Scroll, Screenshot, Zoom  
- **Keyboard panel**: type into the page and send special keys (Enter, Tab, Backspace, etc.)

## Environment Variables

| Variable | Purpose | Required? |
|----------|---------|-----------|
| `KENYA_PROXY_URL` | Full proxy URL (`http://user:pass@host:port`) for a reliable Kenya proxy | Strongly recommended |

## User Preferences

- Phone viewport: 390×844 (Pixel 8 / Android 14)
- Target site: shabiki.com
- Timezone: Africa/Nairobi
- User-agent: Android 14 / Chrome 138 Mobile
