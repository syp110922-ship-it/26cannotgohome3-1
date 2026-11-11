(function initDisplayApp() {
  const params = new URLSearchParams(window.location.search);
  const rawId = (params.get('id') || 'A').toUpperCase();
  const deviceId = rawId === 'B' ? 'B' : 'A';
  const TOKEN_KEY = `ghost_display_token_${deviceId}`;

  // Minimal valid 44-byte silent PCM WAV (for Chromium user-gesture audio unlock)
  const SILENT_WAV_URI =
    'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

  const player = document.getElementById('player');
  const msgOverlay = document.getElementById('msg-overlay');
  const adminCorner = document.getElementById('admin-corner');

  const setupScreen = document.getElementById('setup-screen');
  const deviceTitle = document.getElementById('device-title');
  const switchA = document.getElementById('switch-A');
  const switchB = document.getElementById('switch-B');
  const pinRow = document.getElementById('pin-row');
  const displayPin = document.getElementById('display-pin');
  const setupError = document.getElementById('setup-error');
  const startBtn = document.getElementById('start-btn');
  const setupCornerGearBtn = document.getElementById('setup-corner-gear-btn');

  const displayServerModal = document.getElementById('display-server-modal');
  const displayServerClose = document.getElementById('display-server-close');
  const setupServerCurrent = document.getElementById('setup-server-current');
  const serverUrlInput = document.getElementById('server-url-input');
  const displayServerError = document.getElementById('display-server-error');
  const resetServerBtn = document.getElementById('reset-server-btn');
  const saveServerBtn = document.getElementById('save-server-btn');

  const cornerPinModal = document.getElementById('corner-pin-modal');
  const cornerPinForm = document.getElementById('corner-pin-form');
  const cornerPinInput = document.getElementById('corner-pin-input');
  const cornerPinError = document.getElementById('corner-pin-error');
  const cornerPinCancel = document.getElementById('corner-pin-cancel');

  const cornerInfoModal = document.getElementById('corner-info-modal');
  const infoTabBtns = Array.from(document.querySelectorAll('.info-tab-btn'));
  const infoPaneStatus = document.getElementById('info-pane-status');
  const infoPaneServer = document.getElementById('info-pane-server');
  const infoDeviceId = document.getElementById('info-device-id');
  const infoWsStatus = document.getElementById('info-ws-status');
  const infoClockSync = document.getElementById('info-clock-sync');
  const infoDeviceLocks = document.getElementById('info-device-locks');
  const infoVideoState = document.getElementById('info-video-state');
  const infoFullscreenBtn = document.getElementById('info-fullscreen-btn');
  const infoReconnectBtn = document.getElementById('info-reconnect-btn');
  const infoResetTokenBtn = document.getElementById('info-reset-token-btn');
  const infoCloseBtn = document.getElementById('info-close-btn');
  const infoServerUrl = document.getElementById('info-server-url');
  const infoWsUrl = document.getElementById('info-ws-url');
  const infoServerInput = document.getElementById('info-server-input');
  const infoServerError = document.getElementById('info-server-error');
  const infoServerResetBtn = document.getElementById('info-server-reset-btn');
  const infoServerSaveBtn = document.getElementById('info-server-save-btn');

  document.title = `Display ${deviceId}`;
  deviceTitle.textContent = `체험자 화면 (${deviceId})`;
  switchA.classList.toggle('active', deviceId === 'A');
  switchB.classList.toggle('active', deviceId === 'B');
  setupServerCurrent.textContent = window.GHOST_CONFIG.apiBase;
  serverUrlInput.value = window.GHOST_CONFIG.apiBase;
  infoServerUrl.textContent = window.GHOST_CONFIG.apiBase;
  infoWsUrl.textContent = window.GHOST_CONFIG.wsUrl;
  infoServerInput.value = window.GHOST_CONFIG.apiBase;

  // Input / gesture lockdown
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('dragstart', (e) => e.preventDefault());
  window.addEventListener('selectstart', (e) => {
    const tag = e.target?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
    }
  });
  window.addEventListener('dblclick', (e) => e.preventDefault());

  const blockPinch = (e) => {
    if (e.touches && e.touches.length > 1) {
      e.preventDefault();
    }
  };
  document.addEventListener('touchstart', blockPinch, { passive: false });
  document.addEventListener('touchmove', blockPinch, { passive: false });

  let wakeLock = null;
  let audioCtx = null;

  let activeVideoMeta = null;
  let loadedVideoId = null;
  let loadedObjectUrl = null;
  let activeDownloadSeq = 0;
  let activeDownloadAbort = null;
  let isPlaying = false;
  let currentPlayingVideoId = null;

  let playDelayTimer = null;
  let playRafId = null;
  let posInterval = null;

  let msgFadeOutTimer = null;
  let msgHideTimer = null;

  let cornerAutoCloseTimer = null;

  function clearScheduledPlay() {
    if (playDelayTimer) {
      clearTimeout(playDelayTimer);
      playDelayTimer = null;
    }
    if (playRafId) {
      cancelAnimationFrame(playRafId);
      playRafId = null;
    }
  }

  function clearPosTimer() {
    if (posInterval) {
      clearInterval(posInterval);
      posInterval = null;
    }
  }

  function resetToBlackStandby() {
    clearScheduledPlay();
    clearPosTimer();
    isPlaying = false;
    currentPlayingVideoId = null;
    player.classList.remove('playing-visible');
    try {
      player.pause();
      if (player.readyState > 0) {
        player.currentTime = 0;
      }
    } catch {
      // ignore
    }
  }

  async function requestFullscreenAndWakeLock() {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        // Ignore if denied in embedded preview or browser policy
      }
    }
    if ('wakeLock' in navigator && !wakeLock) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } catch {
        // Ignore Wake Lock failure if unsupported
      }
    }
  }

  function unlockAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        if (!audioCtx) {
          audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.02);
      } catch {
        // Ignore WebAudio errors
      }
    }

    try {
      const primeAudio = new Audio(SILENT_WAV_URI);
      primeAudio.volume = 0;
      primeAudio.play().catch(() => {});
    } catch {
      // Ignore silent audio prime errors
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && setupScreen.classList.contains('hidden')) {
      requestFullscreenAndWakeLock();
    }
  });

  function reportDeviceState(extra = {}) {
    client.send({
      t: 'state',
      id: deviceId,
      cached: loadedVideoId ? [loadedVideoId] : [],
      dl: loadedVideoId ? 100 : 0,
      ...client.getClockStats(),
      ...extra
    });
  }

  async function prepareVideoSource(meta, forceResync = false) {
    activeDownloadSeq += 1;
    const mySeq = activeDownloadSeq;
    if (activeDownloadAbort) {
      try {
        activeDownloadAbort.abort();
      } catch {
        // ignore
      }
      activeDownloadAbort = null;
    }

    if (!meta || !meta.videoId) {
      resetToBlackStandby();
      if (loadedObjectUrl && loadedObjectUrl.startsWith('blob:')) {
        URL.revokeObjectURL(loadedObjectUrl);
      }
      loadedObjectUrl = null;
      loadedVideoId = null;
      player.removeAttribute('src');
      player.load();
      reportDeviceState({ cached: [], dl: 0 });
      return;
    }

    if (!forceResync && loadedVideoId === meta.videoId && player.src) {
      reportDeviceState({ cached: [meta.videoId], dl: 100 });
      return;
    }

    if (window.GhostVideoCache && typeof window.GhostVideoCache.ensureCached === 'function') {
      const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      activeDownloadAbort = abortController;
      try {
        const blobUrl = await window.GhostVideoCache.ensureCached({
          meta,
          apiBase: window.GHOST_CONFIG.apiBase,
          getToken: () => window.localStorage.getItem(TOKEN_KEY) || '',
          forceResync,
          signal: abortController ? abortController.signal : undefined,
          onProgress: (dl) => {
            if (mySeq !== activeDownloadSeq) return;
            client.send({
              t: 'state',
              id: deviceId,
              cached: [],
              dl,
              ...client.getClockStats()
            });
          }
        });
        if (mySeq !== activeDownloadSeq) {
          if (blobUrl && blobUrl.startsWith('blob:')) {
            URL.revokeObjectURL(blobUrl);
          }
          return;
        }
        activeDownloadAbort = null;
        attachPlayableUrl(meta.videoId, blobUrl);
        return;
      } catch (err) {
        if (mySeq !== activeDownloadSeq || err?.name === 'AbortError') {
          return;
        }
        activeDownloadAbort = null;
        reportDeviceState({
          cached: [],
          dl: 0,
          error: err?.message || 'cache_download_failed'
        });
        return;
      }
    }

    reportDeviceState({
      cached: [],
      dl: 0,
      error: 'awaiting_video_streaming_phase4'
    });
  }

  function attachPlayableUrl(videoId, url) {
    if (loadedObjectUrl && loadedObjectUrl.startsWith('blob:') && loadedObjectUrl !== url) {
      URL.revokeObjectURL(loadedObjectUrl);
    }
    loadedVideoId = null;
    loadedObjectUrl = url;

    const onReady = () => {
      player.removeEventListener('canplaythrough', onReady);
      player.removeEventListener('loadeddata', onReady);
      player.removeEventListener('error', onLoadError);
      loadedVideoId = videoId;
      try {
        player.currentTime = 0;
      } catch {
        // ignore
      }
      reportDeviceState({ cached: [videoId], dl: 100, error: null });
    };

    const onLoadError = () => {
      player.removeEventListener('canplaythrough', onReady);
      player.removeEventListener('loadeddata', onReady);
      player.removeEventListener('error', onLoadError);
      loadedVideoId = null;
      resetToBlackStandby();
      reportDeviceState({ cached: [], dl: 0, error: 'video_decode_error' });
    };

    player.addEventListener('canplaythrough', onReady);
    player.addEventListener('loadeddata', onReady);
    player.addEventListener('error', onLoadError);
    player.src = url;
    player.load();
  }

  function startVideoNow(videoId, seekSec = 0) {
    if (loadedVideoId !== videoId || !player.src) {
      reportDeviceState({ error: 'video_not_cached_for_play' });
      return;
    }

    clearScheduledPlay();
    clearPosTimer();

    if (Number.isFinite(player.duration) && player.duration > 0 && seekSec >= player.duration) {
      resetToBlackStandby();
      client.send({ t: 'ended', videoId });
      return;
    }

    try {
      player.currentTime = seekSec > 0.05 ? seekSec : 0;
    } catch {
      // ignore seek error
    }

    player.muted = false;
    isPlaying = true;
    currentPlayingVideoId = videoId;
    player.classList.add('playing-visible');

    const playPromise = player.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err) => {
        resetToBlackStandby();
        reportDeviceState({ error: `play_rejected:${err?.name || 'error'}` });
      });
    }

    posInterval = setInterval(() => {
      if (!isPlaying) return;
      client.send({
        t: 'pos',
        videoId,
        pos: Number((player.currentTime || 0).toFixed(2))
      });
    }, 1000);
  }

  function schedulePlay({ videoId, startAt }) {
    clearScheduledPlay();
    const targetStartAt = Number(startAt) || Date.now();
    const delayMs = targetStartAt - client.serverNow();

    if (delayMs > 25) {
      playDelayTimer = setTimeout(() => {
        playDelayTimer = null;
        const spinUntilStart = () => {
          if (client.serverNow() >= targetStartAt) {
            playRafId = null;
            startVideoNow(videoId, 0);
            return;
          }
          playRafId = requestAnimationFrame(spinUntilStart);
        };
        playRafId = requestAnimationFrame(spinUntilStart);
      }, delayMs - 20);
      return;
    }

    if (delayMs >= -80) {
      startVideoNow(videoId, 0);
      return;
    }

    const lateSeekSec = Math.max(0, -delayMs / 1000);
    startVideoNow(videoId, lateSeekSec);
  }

  player.addEventListener('ended', () => {
    const finishedId = currentPlayingVideoId || loadedVideoId;
    resetToBlackStandby();
    if (finishedId) {
      client.send({ t: 'ended', videoId: finishedId });
    }
  });

  player.addEventListener('error', () => {
    if (!isPlaying) return;
    resetToBlackStandby();
    reportDeviceState({ error: 'playback_media_error' });
  });

  function showMessage(text, durationMs = 5000) {
    const cleanText = String(text ?? '').trim();
    if (!cleanText) return;

    if (msgFadeOutTimer) {
      clearTimeout(msgFadeOutTimer);
      msgFadeOutTimer = null;
    }
    if (msgHideTimer) {
      clearTimeout(msgHideTimer);
      msgHideTimer = null;
    }

    msgOverlay.textContent = cleanText;
    msgOverlay.classList.remove('hidden', 'visible');
    void msgOverlay.offsetWidth;
    msgOverlay.classList.add('visible');

    const totalMs = Math.max(1200, Number(durationMs) || 5000);
    const fadeOutAt = Math.max(600, totalMs - 450);

    msgFadeOutTimer = setTimeout(() => {
      msgFadeOutTimer = null;
      msgOverlay.classList.remove('visible');
    }, fadeOutAt);

    msgHideTimer = setTimeout(() => {
      msgHideTimer = null;
      msgOverlay.classList.add('hidden');
      msgOverlay.textContent = '';
    }, totalMs);
  }

  const client = window.GhostWsClient.createSyncClient({
    wsBaseUrl: window.GHOST_CONFIG.wsUrl,
    apiBase: window.GHOST_CONFIG.apiBase,
    role: 'display',
    id: deviceId,
    getToken: () => window.localStorage.getItem(TOKEN_KEY) || '',
    onStatusChange: ({ connected }) => {
      if (connected) {
        reportDeviceState();
      }
      refreshCornerInfoModal();
    },
    onClockSync: () => {
      refreshCornerInfoModal();
    },
    onMessage: (msg) => {
      switch (msg.t) {
        case 'video':
          activeVideoMeta = msg.videoId ? msg : null;
          prepareVideoSource(activeVideoMeta, false);
          break;
        case 'resync':
          activeVideoMeta = msg.videoId ? msg : null;
          prepareVideoSource(activeVideoMeta, true);
          break;
        case 'play':
          if (msg.videoId) {
            schedulePlay({ videoId: msg.videoId, startAt: msg.startAt });
          }
          break;
        case 'stop':
          resetToBlackStandby();
          break;
        case 'msg':
          showMessage(msg.text, msg.ms || 5000);
          break;
        default:
          break;
      }
      refreshCornerInfoModal();
    },
    onAuthError: () => {
      window.localStorage.removeItem(TOKEN_KEY);
      resetToBlackStandby();
      pinRow.classList.remove('hidden');
      setupScreen.classList.remove('hidden');
    }
  });

  // Setup Screen Corner Gear -> Server Management Modal
  setupCornerGearBtn.addEventListener('click', () => {
    displayServerError.textContent = '';
    setupServerCurrent.textContent = window.GHOST_CONFIG.apiBase;
    serverUrlInput.value = window.GHOST_CONFIG.apiBase;
    displayServerModal.classList.remove('hidden');
  });

  displayServerClose.addEventListener('click', () => {
    displayServerModal.classList.add('hidden');
  });

  resetServerBtn.addEventListener('click', () => {
    window.GHOST_CONFIG.clearServerOrigin();
    window.location.reload();
  });

  saveServerBtn.addEventListener('click', () => {
    displayServerError.textContent = '';
    const ok = window.GHOST_CONFIG.setServerOrigin(serverUrlInput.value);
    if (!ok) {
      displayServerError.textContent = '올바른 https:// (또는 로컬 http://) 서버 주소를 입력하세요.';
      return;
    }
    window.location.reload();
  });

  // Hidden 5-second corner hold + Staff PIN admin modal
  let cornerHoldTimer = null;
  let cornerStartPos = null;

  function cancelCornerHold() {
    if (cornerHoldTimer) {
      clearTimeout(cornerHoldTimer);
      cornerHoldTimer = null;
    }
    cornerStartPos = null;
  }

  adminCorner.addEventListener('pointerdown', (e) => {
    if (!setupScreen.classList.contains('hidden')) return;
    cancelCornerHold();
    cornerStartPos = { x: e.clientX, y: e.clientY };
    cornerHoldTimer = setTimeout(() => {
      cornerHoldTimer = null;
      cornerStartPos = null;
      cornerPinError.textContent = '';
      cornerPinInput.value = '';
      cornerPinModal.classList.remove('hidden');
      setTimeout(() => cornerPinInput.focus(), 50);
    }, 5000);
  });

  adminCorner.addEventListener('pointermove', (e) => {
    if (!cornerStartPos) return;
    const dx = Math.abs(e.clientX - cornerStartPos.x);
    const dy = Math.abs(e.clientY - cornerStartPos.y);
    if (dx > 25 || dy > 25) {
      cancelCornerHold();
    }
  });

  adminCorner.addEventListener('pointerup', cancelCornerHold);
  adminCorner.addEventListener('pointercancel', cancelCornerHold);
  adminCorner.addEventListener('pointerleave', cancelCornerHold);

  function closeCornerInfoModal() {
    if (cornerAutoCloseTimer) {
      clearTimeout(cornerAutoCloseTimer);
      cornerAutoCloseTimer = null;
    }
    cornerInfoModal.classList.add('hidden');
  }

  function refreshCornerInfoModal() {
    if (cornerInfoModal.classList.contains('hidden')) return;
    const stats = client.getClockStats();
    infoDeviceId.textContent = deviceId;
    infoWsStatus.textContent = client.isConnected() ? '연결됨' : '끊김 (재시도 중)';
    infoClockSync.textContent =
      stats.rttMs !== null ? `RTT ${stats.rttMs}ms / 오차 ${stats.offsetMs}ms` : '측정 중';
    infoDeviceLocks.textContent = `${document.fullscreenElement ? '전체화면 ON' : '전체화면 OFF'} / ${wakeLock ? 'WakeLock ON' : 'WakeLock OFF'}`;
    infoVideoState.textContent = activeVideoMeta
      ? `${activeVideoMeta.videoId} (${loadedVideoId === activeVideoMeta.videoId ? '캐시 완료' : '미준비'})`
      : '없음';
    infoServerUrl.textContent = window.GHOST_CONFIG.apiBase;
    infoWsUrl.textContent = window.GHOST_CONFIG.wsUrl;
  }

  for (const btn of infoTabBtns) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.infoTab;
      for (const b of infoTabBtns) b.classList.toggle('active', b === btn);
      infoPaneStatus.classList.toggle('hidden', target !== 'status');
      infoPaneServer.classList.toggle('hidden', target !== 'server');
    });
  }

  cornerPinCancel.addEventListener('click', () => {
    cornerPinModal.classList.add('hidden');
    cornerPinInput.value = '';
  });

  cornerPinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    cornerPinError.textContent = '';
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: cornerPinInput.value, scope: 'diagnostics' })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data.error === 'pin_locked') {
          cornerPinError.textContent = `잠금 상태입니다 (${data.retryAfterSec}초 후 재시도)`;
        } else if (typeof data.attemptsRemaining === 'number') {
          cornerPinError.textContent = `스태프 PIN이 올바르지 않습니다. (남은 시도 ${data.attemptsRemaining}회)`;
        } else {
          cornerPinError.textContent = '스태프 PIN이 올바르지 않습니다.';
        }
        return;
      }
      cornerPinInput.value = '';
      cornerPinModal.classList.add('hidden');
      for (const b of infoTabBtns) b.classList.toggle('active', b.dataset.infoTab === 'status');
      infoPaneStatus.classList.remove('hidden');
      infoPaneServer.classList.add('hidden');
      cornerInfoModal.classList.remove('hidden');
      refreshCornerInfoModal();

      if (cornerAutoCloseTimer) clearTimeout(cornerAutoCloseTimer);
      cornerAutoCloseTimer = setTimeout(closeCornerInfoModal, 60000);
    } catch {
      cornerPinError.textContent = '서버에 연결할 수 없습니다.';
    }
  });

  infoCloseBtn.addEventListener('click', closeCornerInfoModal);
  infoFullscreenBtn.addEventListener('click', async () => {
    await requestFullscreenAndWakeLock();
    refreshCornerInfoModal();
  });
  infoReconnectBtn.addEventListener('click', () => {
    client.disconnect();
    client.connect();
    refreshCornerInfoModal();
  });
  infoResetTokenBtn.addEventListener('click', () => {
    closeCornerInfoModal();
    client.disconnect();
    resetToBlackStandby();
    window.localStorage.removeItem(TOKEN_KEY);
    pinRow.classList.remove('hidden');
    setupScreen.classList.remove('hidden');
  });

  infoServerResetBtn.addEventListener('click', () => {
    window.GHOST_CONFIG.clearServerOrigin();
    window.location.reload();
  });

  infoServerSaveBtn.addEventListener('click', () => {
    infoServerError.textContent = '';
    const ok = window.GHOST_CONFIG.setServerOrigin(infoServerInput.value);
    if (!ok) {
      infoServerError.textContent = '올바른 https:// (또는 로컬 http://) 서버 주소를 입력하세요.';
      return;
    }
    window.location.reload();
  });

  async function hasValidStoredToken() {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) return false;
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401 || res.status === 403) {
        window.localStorage.removeItem(TOKEN_KEY);
        return false;
      }
      if (!res.ok) return true;
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
        setupError.textContent = '최초 등록을 위해 체험자용 PIN을 입력해 주세요.';
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
          if (data.error === 'pin_locked') {
            setupError.textContent = `잠금 상태입니다 (${data.retryAfterSec}초 후 재시도)`;
          } else if (typeof data.attemptsRemaining === 'number') {
            setupError.textContent = `PIN이 올바르지 않습니다. (남은 시도 ${data.attemptsRemaining}회)`;
          } else {
            setupError.textContent = 'PIN이 올바르지 않습니다.';
          }
          return;
        }
        token = data.token;
        window.localStorage.setItem(TOKEN_KEY, token);
        displayPin.value = '';
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

  window.__GHOST_DISPLAY_API__ = {
    deviceId,
    attachPlayableUrl,
    schedulePlay,
    resetToBlackStandby,
    showMessage,
    getState: () => ({
      isPlaying,
      loadedVideoId,
      currentPlayingVideoId,
      connected: client.isConnected(),
      clockStats: client.getClockStats()
    })
  };
})();
