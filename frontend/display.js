(function initDisplaySkeleton() {
  const params = new URLSearchParams(window.location.search);
  const rawId = (params.get('id') || 'A').toUpperCase();
  const deviceId = rawId === 'B' ? 'B' : 'A';
  const TOKEN_KEY = `ghost_display_token_${deviceId}`;

  const setupScreen = document.getElementById('setup-screen');
  const deviceTitle = document.getElementById('device-title');
  const pinRow = document.getElementById('pin-row');
  const displayPin = document.getElementById('display-pin');
  const setupError = document.getElementById('setup-error');
  const startBtn = document.getElementById('start-btn');

  deviceTitle.textContent = `체험자 화면 (${deviceId})`;

  // Block context menu and drag gestures on display surface
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('dragstart', (e) => e.preventDefault());

  let wakeLock = null;
  let audioCtx = null;

  async function requestFullscreenAndWakeLock() {
    if (document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        // Ignore if denied in embedded preview or browser policy
      }
    }
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch {
        // Ignore Wake Lock failure if unsupported
      }
    }
  }

  function unlockAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      if (!audioCtx) {
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    } catch {
      // Ignore audio init errors
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !setupScreen.classList.contains('hidden')) {
      return;
    }
    if (document.visibilityState === 'visible' && 'wakeLock' in navigator && !wakeLock) {
      navigator.wakeLock.request('screen').then((lock) => {
        wakeLock = lock;
      }).catch(() => {});
    }
  });

  const client = window.GhostWsClient.createSyncClient({
    wsBaseUrl: window.GHOST_CONFIG.wsUrl,
    role: 'display',
    id: deviceId,
    getToken: () => window.localStorage.getItem(TOKEN_KEY) || '',
    onStatusChange: ({ connected }) => {
      if (connected) {
        client.send({
          t: 'state',
          id: deviceId,
          cached: [],
          dl: 0
        });
      }
    },
    onMessage: (msg) => {
      // Phase 2 & 4 will wire video download/IndexedDB cache, scheduled play, stop, and message overlay
      if (msg.t === 'video') {
        console.debug(`[display ${deviceId}] Active video metadata:`, msg);
      }
    },
    onAuthError: () => {
      pinRow.classList.remove('hidden');
      setupScreen.classList.remove('hidden');
    }
  });

  async function hasValidStoredToken() {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) return false;
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        window.localStorage.removeItem(TOKEN_KEY);
        return false;
      }
      const data = await res.json();
      return data.ok && (data.deviceId === deviceId || data.scope === 'admin');
    } catch {
      return true;
    }
  }

  hasValidStoredToken().then((valid) => {
    if (!valid) {
      pinRow.classList.remove('hidden');
    }
  });

  startBtn.addEventListener('click', async () => {
    setupError.textContent = '';

    let token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) {
      const pin = displayPin.value.trim();
      if (!pin) {
        pinRow.classList.remove('hidden');
        setupError.textContent = '최초 연결을 위해 스태프 PIN을 입력해 주세요.';
        return;
      }
      try {
        const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin, scope: 'display', deviceId })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setupError.textContent =
            data.error === 'pin_locked'
              ? `잠금 상태입니다 (${data.retryAfterSec}초 후 재시도)`
              : 'PIN이 올바르지 않습니다.';
          return;
        }
        token = data.token;
        window.localStorage.setItem(TOKEN_KEY, token);
      } catch {
        setupError.textContent = '서버에 연결할 수 없습니다.';
        return;
      }
    }

    unlockAudio();
    await requestFullscreenAndWakeLock();
    setupScreen.classList.add('hidden');
    client.connect();
  });
})();
