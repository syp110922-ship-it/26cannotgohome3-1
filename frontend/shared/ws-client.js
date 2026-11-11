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
    let reconnectTimer = null;
    let heartbeatTimer = null;
    let syncTimer = null;

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

      ws = new WebSocket(buildUrl());

      ws.addEventListener('open', () => {
        reconnectAttempt = 0;
        if (typeof onStatusChange === 'function') {
          onStatusChange({ connected: true, reconnectingInMs: 0 });
        }
        burstClockSync();
        heartbeatTimer = setInterval(sendPing, 5000);
        syncTimer = setInterval(burstClockSync, 30000);
      });

      ws.addEventListener('message', (event) => {
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

      ws.addEventListener('close', (event) => {
        clearTimers();
        if (typeof onStatusChange === 'function') {
          onStatusChange({ connected: false, code: event.code });
        }
        if (event.code === 4001) {
          // Replaced by newer tab/session
          return;
        }
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        // Close listener triggers reconnect
      });
    }

    function disconnect() {
      closedByUser = true;
      clearTimers();
      if (ws) {
        try {
          ws.close(1000, 'client_disconnect');
        } catch {
          // ignore
        }
        ws = null;
      }
    }

    return {
      connect,
      disconnect,
      send,
      serverNow: () => Date.now() + currentOffsetMs,
      getClockStats: () => ({ rttMs: currentRttMs, offsetMs: currentOffsetMs })
    };
  }

  global.GhostWsClient = {
    createSyncClient
  };
})(window);
