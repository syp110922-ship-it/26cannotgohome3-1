'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { verifyToken } = require('./auth');

function isOriginAllowed(origin, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.includes('*')) return true;
  if (!origin) return false;
  const normalized = String(origin).trim().replace(/\/+$/, '');
  return allowedOrigins.includes(normalized);
}

function createWebSocketGateway({ server, config, db, getStateMachine }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024
  });

  const controlSockets = new Set();
  const displaySockets = {
    A: null,
    B: null
  };

  function safeSend(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function broadcastToControl(payload) {
    const serialized = JSON.stringify(payload);
    for (const ws of controlSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serialized);
      }
    }
  }

  function sendToDisplays(payload, targetId) {
    if (targetId) {
      safeSend(displaySockets[targetId], payload);
      return;
    }
    safeSend(displaySockets.A, payload);
    safeSend(displaySockets.B, payload);
  }

  function closeDisplaySocket(id) {
    const ws = displaySockets[id];
    if (ws) {
      displaySockets[id] = null;
      try {
        ws.close(4002, 'heartbeat_timeout');
        setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) {
            try {
              ws.terminate();
            } catch {
              // ignore
            }
          }
        }, 500).unref();
      } catch {
        // ignore close errors
      }
    }
  }

  function disconnectAll(reason = 'token_revoked') {
    for (const ws of wss.clients) {
      try {
        ws.close(4003, reason);
        setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) {
            try {
              ws.terminate();
            } catch {
              // ignore
            }
          }
        }, 500).unref();
      } catch {
        // ignore
      }
    }
  }

  function rejectUpgrade(socket, statusCode, statusText) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    if (!isOriginAllowed(req.headers.origin, config.allowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden Origin');
      return;
    }

    const role = url.searchParams.get('role');
    const id = url.searchParams.get('id')?.toUpperCase() || null;
    const token = url.searchParams.get('token') || '';

    if (role !== 'control' && role !== 'display') {
      rejectUpgrade(socket, 400, 'Invalid Role');
      return;
    }
    if (role === 'display' && id !== 'A' && id !== 'B') {
      rejectUpgrade(socket, 400, 'Invalid Display ID');
      return;
    }

    const verification = verifyToken(token, db.getAuthSecret(), db.getTokenVersion());
    if (!verification.valid) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const { claims } = verification;
    if (role === 'control') {
      if (claims.scope !== 'control' && claims.scope !== 'admin') {
        rejectUpgrade(socket, 403, 'Insufficient Scope');
        return;
      }
    } else if (role === 'display') {
      const allowedDisplay =
        claims.scope === 'admin' ||
        (claims.scope === 'display' && claims.deviceId === id);
      if (!allowedDisplay) {
        rejectUpgrade(socket, 403, 'Insufficient Scope');
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, { role, id, claims });
    });
  });

  wss.on('connection', (ws, meta) => {
    const sm = getStateMachine();
    const { role, id, claims } = meta;
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
      if (role === 'display') {
        sm.touchHeartbeat(id);
      }
    });

    if (role === 'control') {
      controlSockets.add(ws);
      sm.setControlConnected(controlSockets.size > 0);
      safeSend(ws, sm.getSnapshot());
    } else if (role === 'display') {
      const previous = displaySockets[id];
      if (previous && previous !== ws) {
        try {
          previous.close(4001, 'replaced_by_new_connection');
          setTimeout(() => {
            if (previous.readyState !== WebSocket.CLOSED) {
              try {
                previous.terminate();
              } catch {
                // ignore
              }
            }
          }, 500).unref();
        } catch {
          // ignore
        }
      }
      displaySockets[id] = ws;
      sm.connectDisplay(id);
      safeSend(ws, sm.getActiveVideoMessage());
    }

    ws.on('message', (raw) => {
      ws.isAlive = true;

      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        safeSend(ws, { t: 'error', error: 'invalid_json' });
        return;
      }

      if (!msg || typeof msg.t !== 'string') {
        safeSend(ws, { t: 'error', error: 'missing_type' });
        return;
      }

      if (msg.t === 'ping') {
        if (role === 'display') {
          sm.touchHeartbeat(id, { rttMs: msg.rttMs, offsetMs: msg.offsetMs });
        }
        safeSend(ws, {
          t: 'pong',
          cTime: msg.cTime ?? null,
          sTime: Date.now()
        });
        return;
      }

      if (role === 'display') {
        switch (msg.t) {
          case 'state':
            sm.updateDisplayState(id, msg);
            return;
          case 'pos':
            sm.updateDisplayPos(id, msg);
            return;
          case 'ended':
            sm.handleDisplayEnded(id, msg);
            return;
          default:
            safeSend(ws, {
              t: 'error',
              error: 'forbidden_for_display',
              type: msg.t
            });
            return;
        }
      }

      if (role === 'control') {
        switch (msg.t) {
          case 'play': {
            const res = sm.requestPlay();
            if (!res.ok) {
              safeSend(ws, { t: 'error', action: 'play', error: res.reason });
            }
            return;
          }
          case 'stop': {
            const res = sm.requestStop();
            if (!res.ok) {
              safeSend(ws, { t: 'error', action: 'stop', error: res.reason });
            }
            return;
          }
          case 'msg': {
            const res = sm.sendMessage(msg.text);
            if (!res.ok) {
              safeSend(ws, { t: 'error', action: 'msg', error: res.reason });
            } else {
              safeSend(ws, { t: 'msg_ack', text: res.text, ms: res.ms });
            }
            return;
          }
          case 'activate': {
            if (claims.scope !== 'admin') {
              safeSend(ws, { t: 'error', action: 'activate', error: 'admin_required' });
              return;
            }
            const res = sm.activateVideo(msg.videoId);
            if (!res.ok) {
              safeSend(ws, { t: 'error', action: 'activate', error: res.reason });
            }
            return;
          }
          default:
            safeSend(ws, { t: 'error', error: 'unknown_message_type', type: msg.t });
            return;
        }
      }
    });

    ws.on('close', () => {
      if (role === 'control') {
        controlSockets.delete(ws);
        sm.setControlConnected(controlSockets.size > 0);
      } else if (role === 'display') {
        if (displaySockets[id] === ws) {
          displaySockets[id] = null;
          sm.disconnectDisplay(id);
        }
      }
    });

    ws.on('error', () => {
      // handled by close
    });
  });

  // Native WebSocket ping/pong sweep to clean up half-open TCP connections
  const livenessTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, config.wsPingIntervalMs || 10000);
  if (typeof livenessTimer.unref === 'function') {
    livenessTimer.unref();
  }

  function close() {
    clearInterval(livenessTimer);
    for (const ws of wss.clients) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    wss.close();
  }

  return {
    wss,
    broadcastToControl,
    sendToDisplays,
    closeDisplaySocket,
    disconnectAll,
    close
  };
}

module.exports = {
  createWebSocketGateway,
  isOriginAllowed
};
