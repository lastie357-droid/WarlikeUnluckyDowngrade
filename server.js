/**
 * server.js — Express web server + WebSocket → TCP proxy for noVNC
 * VNC proxy auto-reconnects on drop so the browser client stays connected.
 */
const express = require('express');
const http    = require('http');
const net     = require('net');
const { WebSocketServer } = require('ws');
const path    = require('path');

const PORT       = 5000;
const VNC_HOST   = '127.0.0.1';
const VNC_PORT   = 5900;
const CMD_SOCKET = '/tmp/browser-cmd.sock';

const app    = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/novnc', express.static(path.join(__dirname, 'node_modules/@novnc/novnc')));

// ── IPC helper — send command to browser.js ──
function sendCmd(cmd) {
  const client = net.createConnection(CMD_SOCKET);
  client.on('error', (e) => console.error('[cmd] IPC error:', e.message));
  client.write(JSON.stringify(cmd));
  client.end();
}

app.get('/cmd/navigate', (req, res) => {
  const url = req.query.url || 'https://shabiki.com';
  console.log('[cmd] Navigate to:', url);
  sendCmd({ type: 'navigate', url });
  res.json({ ok: true, url });
});

app.get('/cmd/action', (req, res) => {
  const key = req.query.key || '';
  console.log('[cmd] Action:', key);
  sendCmd({ type: 'action', key });
  res.json({ ok: true, key });
});

app.get('/cmd/type', (req, res) => {
  const text = req.query.text || '';
  sendCmd({ type: 'type', text });
  res.json({ ok: true, text });
});

// ── WebSocket → VNC TCP proxy ──
// When x11vnc drops the TCP connection (e.g. during heavy page loads),
// we reconnect internally so the browser client never sees a disconnect.
const wss = new WebSocketServer({ server, path: '/websockify' });

wss.on('connection', (ws, req) => {
  console.log('[proxy] noVNC client connected');

  let tcp        = null;
  let dead       = false;   // set when the WS itself closes — stop reconnecting
  let vncReady   = false;   // true after first successful VNC connect

  function connectVNC() {
    if (dead) return;

    tcp = net.createConnection({ host: VNC_HOST, port: VNC_PORT });

    // Tune socket for low-latency streaming
    tcp.setNoDelay(true);
    tcp.setKeepAlive(true, 5000);

    tcp.on('connect', () => {
      console.log('[proxy] VNC connected');
      vncReady = true;
    });

    tcp.on('data', (data) => {
      if (!dead && ws.readyState === ws.OPEN) {
        ws.send(data, { binary: true }, (err) => {
          if (err) console.error('[proxy] WS send error:', err.message);
        });
      }
    });

    tcp.on('close', () => {
      if (dead) return;
      console.log('[proxy] VNC TCP closed — reconnecting in 800 ms…');
      // Brief pause then reconnect. noVNC will freeze until data resumes
      // but stays connected — no "VNC closed" flash on screen.
      setTimeout(connectVNC, 800);
    });

    tcp.on('error', (err) => {
      // ECONNREFUSED = VNC not up yet; anything else log it
      if (err.code !== 'ECONNREFUSED') {
        console.error('[proxy] VNC error:', err.message);
      }
    });
  }

  connectVNC();

  ws.on('message', (msg) => {
    if (tcp && tcp.writable) {
      tcp.write(msg);
    }
  });

  ws.on('close', () => {
    console.log('[proxy] noVNC client disconnected');
    dead = true;
    if (tcp) { tcp.destroy(); tcp = null; }
  });

  ws.on('error', (err) => {
    console.error('[proxy] WS error:', err.message);
    dead = true;
    if (tcp) { tcp.destroy(); tcp = null; }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  Phone VNC UI  →  http://0.0.0.0:${PORT}`);
  console.log(`   WebSocket VNC proxy at ws://0.0.0.0:${PORT}/websockify\n`);
});
