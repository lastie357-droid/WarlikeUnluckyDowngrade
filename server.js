/**
 * server.js — Express web server + WebSocket → TCP proxy for noVNC
 * Also handles /cmd/* to control the Playwright browser via IPC
 */
const express = require('express');
const http    = require('http');
const net     = require('net');
const { WebSocketServer } = require('ws');
const path    = require('path');
const { execSync } = require('child_process');

const PORT     = 5000;
const VNC_HOST = '127.0.0.1';
const VNC_PORT = 5900;
const CMD_SOCKET = '/tmp/browser-cmd.sock';

const app    = express();
const server = http.createServer(app);

// Serve static phone UI
app.use(express.static(path.join(__dirname, 'public')));

// Serve noVNC core from local npm package
app.use('/novnc', express.static(path.join(__dirname, 'node_modules/@novnc/novnc')));

// ── Command endpoint ── (talks to browser.js via unix socket IPC)
function sendCmd(cmd) {
  try {
    const client = net.createConnection(CMD_SOCKET);
    client.on('error', (e) => console.error('[cmd] IPC error:', e.message));
    client.write(JSON.stringify(cmd));
    client.end();
  } catch(e) {
    console.error('[cmd] IPC error:', e.message);
  }
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
  console.log('[cmd] Type:', JSON.stringify(text));
  sendCmd({ type: 'type', text });
  res.json({ ok: true, text });
});

// ── WebSocket → VNC TCP proxy (noVNC talks here) ──
const wss = new WebSocketServer({ server, path: '/websockify' });

wss.on('connection', (ws, req) => {
  console.log('[proxy] noVNC client connected from', req.socket.remoteAddress);

  const tcp = net.createConnection({ host: VNC_HOST, port: VNC_PORT }, () => {
    console.log('[proxy] Connected to VNC server');
  });

  tcp.on('data',  (data) => { if (ws.readyState === ws.OPEN) ws.send(data, { binary: true }); });
  tcp.on('close', ()     => { console.log('[proxy] VNC closed'); ws.close(); });
  tcp.on('error', (err)  => { console.error('[proxy] VNC error:', err.message); ws.close(); });

  ws.on('message', (msg) => { if (tcp.writable) tcp.write(msg); });
  ws.on('close',   ()    => { tcp.destroy(); });
  ws.on('error',   (err) => { console.error('[proxy] WS error:', err.message); tcp.destroy(); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  Phone VNC UI  →  http://0.0.0.0:${PORT}`);
  console.log(`   WebSocket VNC proxy at ws://0.0.0.0:${PORT}/websockify\n`);
});
