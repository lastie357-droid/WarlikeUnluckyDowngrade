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

## Usage

Open the Replit preview — you'll see a phone frame streaming the live Chromium browser.  
- **Click anywhere** on the screen to send real clicks (ripple shows coordinates)  
- **Navigation bar** to type a URL and press Go  
- **Control buttons**: Back, Forward, Reload, Scroll, Screenshot, Zoom  

## User Preferences

- Phone viewport: 390×844 (iPhone 14 Pro)
- Target site: shabiki.com
- Timezone: Africa/Nairobi
- User-agent: Android 14 / Chrome 138 Mobile
