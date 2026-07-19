#!/usr/bin/env bash
set -e

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
PHONE_W=390
PHONE_H=844
VNC_PORT=5900
CHROMIUM=$(which chromium 2>/dev/null || which chromium-browser 2>/dev/null)

echo "===================================================="
echo " Shabiki Phone VNC Browser"
echo "===================================================="

cleanup() {
  echo "[start] Shutting down gracefully..."
  # SIGTERM browser.js first so it can close Chrome cleanly (saves session state)
  pkill -TERM -f "node browser.js" 2>/dev/null || true
  sleep 3
  # Then stop the rest
  pkill -TERM -f "node server.js" 2>/dev/null || true
  pkill -TERM -f x11vnc            2>/dev/null || true
  sleep 1
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Kill stale
pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
pkill -f x11vnc                  2>/dev/null || true
pkill -f "node browser.js"       2>/dev/null || true
pkill -f "node server.js"        2>/dev/null || true
rm -f /tmp/browser-cmd.sock
sleep 1

# 1. Start Xvfb
echo "[xvfb] Starting display ${DISPLAY} at ${PHONE_W}x${PHONE_H}x24..."
Xvfb "${DISPLAY}" -screen 0 "${PHONE_W}x${PHONE_H}x24" -ac -nolisten tcp &
sleep 2

xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 \
  && echo "[xvfb] Display ${DISPLAY} ready ✓" \
  || { echo "[xvfb] FAILED to start display!"; exit 1; }

# 2. Start x11vnc
echo "[x11vnc] Starting VNC on port ${VNC_PORT}..."
x11vnc \
  -display "${DISPLAY}" \
  -rfbport "${VNC_PORT}" \
  -nopw \
  -forever \
  -shared \
  -noxdamage \
  -noxfixes \
  -nocursor \
  -quiet \
  -bg \
  -o /tmp/x11vnc.log
sleep 1
echo "[x11vnc] VNC server on port ${VNC_PORT} ✓"

# 3. Launch Chromium via browser.js
echo "[browser] Launching Chromium at shabiki.com..."
DISPLAY="${DISPLAY}" \
CHROMIUM_PATH="${CHROMIUM}" \
node browser.js &
sleep 4

# 4. Start Express + WS proxy
echo "[server] Starting web server on port 5000..."
node server.js

# server.js runs in foreground; script ends when server dies
