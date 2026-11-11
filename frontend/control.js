(function initControlSkeleton() {
  const TOKEN_KEY = 'ghost_control_token';

  const dotA = document.getElementById('dot-A');
  const dotB = document.getElementById('dot-B');
  const stateBadge = document.getElementById('state-badge');
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const statusHint = document.getElementById('status-hint');
  const timeText = document.getElementById('time-text');
  const timelineFill = document.getElementById('timeline-fill');
  const timelineThumb = document.getElementById('timeline-thumb');
  const authModal = document.getElementById('auth-modal');
  const authForm = document.getElementById('auth-form');
  const pinInput = document.getElementById('pin-input');
  const authError = document.getElementById('auth-error');

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(safe / 60);
    const s = String(safe % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function applyDot(el, dotColor) {
    el.classList.remove('green', 'orange', 'red');
    el.classList.add(dotColor || 'red');
  }

  function renderStatus(snapshot) {
    if (!snapshot) return;
    stateBadge.textContent = snapshot.state || 'NOT_READY';
    applyDot(dotA, snapshot.displays?.A?.dot);
    applyDot(dotB, snapshot.displays?.B?.dot);

    playBtn.classList.remove('ready', 'playing', 'disabled');
    if (snapshot.state === 'READY') {
      playBtn.classList.add('ready');
      playBtn.disabled = false;
      playIcon.textContent = '▶';
    } else if (snapshot.state === 'PLAYING') {
      playBtn.classList.add('playing');
      playBtn.disabled = false;
      playIcon.textContent = '■';
    } else {
      playBtn.classList.add('disabled');
      playBtn.disabled = true;
      playIcon.textContent = '▶';
    }

    const duration = snapshot.video?.duration || 0;
    const pos = snapshot.playback?.pos || 0;
    const pct = duration > 0 ? Math.min(100, (pos / duration) * 100) : 0;
    timelineFill.style.width = `${pct}%`;
    timelineThumb.style.left = `${pct}%`;
    timeText.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
  }

  const client = window.GhostWsClient.createSyncClient({
    wsBaseUrl: window.GHOST_CONFIG.wsUrl,
    role: 'control',
    getToken: () => window.localStorage.getItem(TOKEN_KEY) || '',
    onStatusChange: ({ connected, reconnectingInMs }) => {
      if (connected) {
        statusHint.textContent = '서버 연결됨 (Phase 1 뼈대)';
      } else if (reconnectingInMs) {
        statusHint.textContent = `재연결 중 (${Math.ceil(reconnectingInMs / 1000)}초)...`;
      } else {
        statusHint.textContent = '연결 끊김';
      }
    },
    onClockSync: ({ rttMs, offsetMs }) => {
      statusHint.textContent = `서버 연결됨 · RTT ${rttMs}ms · 오차보정 ${offsetMs}ms`;
    },
    onMessage: (msg) => {
      if (msg.t === 'status') {
        renderStatus(msg);
      }
    },
    onAuthError: () => {
      authModal.classList.remove('hidden');
    }
  });

  async function verifyAndStart() {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) {
      authModal.classList.remove('hidden');
      return;
    }
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        window.localStorage.removeItem(TOKEN_KEY);
        authModal.classList.remove('hidden');
        return;
      }
      authModal.classList.add('hidden');
      client.connect();
    } catch {
      client.connect();
    }
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinInput.value, scope: 'control' })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        authError.textContent =
          data.error === 'pin_locked'
            ? `잠금 상태입니다 (${data.retryAfterSec}초 후 재시도)`
            : 'PIN이 올바르지 않습니다.';
        return;
      }
      window.localStorage.setItem(TOKEN_KEY, data.token);
      pinInput.value = '';
      authModal.classList.add('hidden');
      client.connect();
    } catch {
      authError.textContent = '서버에 연결할 수 없습니다.';
    }
  });

  verifyAndStart();
})();
