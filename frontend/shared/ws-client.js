(function attachWsClient(global) {
  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : Math.round(sorted[mid]);
  }

  function createSyncClient({
    wsBaseUrl,
    apiBase = window.GHOST_CONFIG?.apiBase || window.location.origin,
    role,
    id = null,
    getToken,
    onMessage,
    onStatusChange,
    onClockSync,
    onAuthError
  }) {
    let ws = null;
    let closedByUser = false;
    let reconnectAttempt = 0;
    let consecutiveHandshakeFails = 0;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    let syncTimer = null;
    let connected = false;

    const samples = [];
    let currentRttMs = null;
    let currentOffsetMs = 0;

    function buildUrl() {
      const url = new URL(wsBaseUrl);
      url.searchParams.set('role', role);
      if (id) url.searchParams.set('id', id);
      const token = typeof getToken === 'function' ? getToken() : '';
      if (token) url.searchParams.set('token', token);
      return url.toString();
    }

    function send(payload) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(payload));
      return true;
    }

    function sendPing() {
      send({
        t: 'ping',
        cTime: Date.now(),
        rttMs: currentRttMs,
        offsetMs: currentOffsetMs
      });
    }

    function burstClockSync() {
      let count = 0;
      const run = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        sendPing();
        count += 1;
        if (count < 5) {
          setTimeout(run, 120);
        }
      };
      run();
    }

    function recordPong(msg) {
      if (typeof msg.cTime !== 'number' || typeof msg.sTime !== 'number') return;
      const now = Date.now();
      const rtt = Math.max(0, now - msg.cTime);
      const offset = msg.sTime - (msg.cTime + rtt / 2);

      samples.push({ rtt, offset });
      if (samples.length > 20) samples.shift();

      const bestFive = [...samples]
        .sort((a, b) => a.rtt - b.rtt)
        .slice(0, 5);

      currentRttMs = Math.round(bestFive[0].rtt);
      currentOffsetMs = median(bestFive.map((s) => s.offset));

      if (typeof onClockSync === 'function') {
        onClockSync({ rttMs: currentRttMs, offsetMs: currentOffsetMs });
      }
    }

    function clearTimers() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    async function verifyTokenOrReconnect() {
      const token = typeof getToken === 'function' ? getToken() : '';
      if (!token) {
        if (typeof onAuthError === 'function') onAuthError();
        return;
      }
      try {
        const res = await fetch(`${apiBase}/auth/verify`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.status === 401 || res.status === 403) {
          if (typeof onAuthError === 'function') onAuthError();
          return;
        }
      } catch {
        // Server unreachable or Wi-Fi offline: keep reconnecting
      }
      scheduleReconnect();
    }

    function scheduleReconnect() {
      if (closedByUser || reconnectTimer) return;
      const delay = Math.min(3000, 500 * Math.pow(2, reconnectAttempt));
      reconnectAttempt += 1;
      if (typeof onStatusChange === 'function') {
        onStatusChange({ connected: false, reconnectingInMs: delay });
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      clearTimers();
      closedByUser = false;

      const token = typeof getToken === 'function' ? getToken() : '';
      if (!token) {
        if (typeof onAuthError === 'function') onAuthError();
        return;
      }

      const socket = new WebSocket(buildUrl());
      ws = socket;
      let openedThisAttempt = false;

      socket.addEventListener('open', () => {
        if (ws !== socket) return;
        openedThisAttempt = true;
        connected = true;
        reconnectAttempt = 0;
        consecutiveHandshakeFails = 0;
        if (typeof onStatusChange === 'function') {
          onStatusChange({ connected: true, reconnectingInMs: 0 });
        }
        burstClockSync();
        heartbeatTimer = setInterval(sendPing, 5000);
        syncTimer = setInterval(burstClockSync, 30000);
      });

      socket.addEventListener('message', (event) => {
        if (ws !== socket) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.t === 'pong') {
          recordPong(msg);
          return;
        }
        if (typeof onMessage === 'function') {
          onMessage(msg);
        }
      });

      socket.addEventListener('close', (event) => {
        if (ws !== socket) return;
        clearTimers();
        connected = false;
        if (typeof onStatusChange === 'function') {
          onStatusChange({ connected: false, code: event.code });
        }
        if (event.code === 4001) {
          // Replaced by newer session on same device
          return;
        }
        if (event.code === 4003) {
          if (typeof onAuthError === 'function') onAuthError();
          return;
        }
        if (!openedThisAttempt) {
          consecutiveHandshakeFails += 1;
          if (consecutiveHandshakeFails >= 2) {
            verifyTokenOrReconnect();
            return;
          }
        }
        scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        // Handled by close listener
      });
    }

    const onBrowserOnline = () => {
      if (closedByUser || connected) return;
      if (ws && ws.readyState === WebSocket.CONNECTING) return;
      reconnectAttempt = 0;
      clearTimers();
      connect();
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', onBrowserOnline);
    }

    function disconnect() {
      closedByUser = true;
      connected = false;
      clearTimers();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('online', onBrowserOnline);
      }
      if (ws) {
        const old = ws;
        ws = null;
        try {
          old.close(1000, 'client_disconnect');
        } catch {
          // ignore
        }
      }
    }

    return {
      connect,
      disconnect,
      send,
      isConnected: () => connected,
      serverNow: () => Date.now() + currentOffsetMs,
      getClockStats: () => ({ rttMs: currentRttMs, offsetMs: currentOffsetMs })
    };
  }

  global.GhostWsClient = {
    createSyncClient
  };
})(window);
