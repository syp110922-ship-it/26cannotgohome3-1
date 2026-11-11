(function initControlApp() {
  const CONTROL_TOKEN_KEY = 'ghost_control_token';
  const ADMIN_TOKEN_KEY = 'ghost_admin_token';

  const PLAY_HOLD_MS = 600;
  const STOP_HOLD_MS = 1000;
  const SETTINGS_HOLD_MS = 3000;
  const PLAY_RING_LENGTH = 100;
  const SETTINGS_RING_CIRCUMFERENCE = 2 * Math.PI * 24;

  const dotWrapA = document.getElementById('dot-wrap-A');
  const dotWrapB = document.getElementById('dot-wrap-B');
  const dotA = document.getElementById('dot-A');
  const dotB = document.getElementById('dot-B');
  const dlA = document.getElementById('dl-A');
  const dlB = document.getElementById('dl-B');
  const connPill = document.getElementById('conn-pill');

  const settingsBtn = document.getElementById('settings-btn');
  const settingsRing = document.getElementById('settings-ring');

  const playBtn = document.getElementById('play-btn');
  const playRing = document.getElementById('play-ring');
  const playIcon = document.getElementById('play-icon');
  const playHint = document.getElementById('play-hint');
  const cooldownLabel = document.getElementById('cooldown-label');

  const timelineFill = document.getElementById('timeline-fill');
  const timelineThumb = document.getElementById('timeline-thumb');
  const timeText = document.getElementById('time-text');
  const toastEl = document.getElementById('toast');

  const msgBtn = document.getElementById('msg-btn');
  const msgSheetBackdrop = document.getElementById('msg-sheet-backdrop');
  const msgSheetClose = document.getElementById('msg-sheet-close');
  const msgSelectStep = document.getElementById('msg-select-step');
  const msgConfirmStep = document.getElementById('msg-confirm-step');
  const presetGrid = document.getElementById('preset-grid');
  const customMsgForm = document.getElementById('custom-msg-form');
  const customMsgInput = document.getElementById('custom-msg-input');
  const msgConfirmPreview = document.getElementById('msg-confirm-preview');
  const msgCancelBtn = document.getElementById('msg-cancel-btn');
  const msgSendBtn = document.getElementById('msg-send-btn');

  const authModal = document.getElementById('auth-modal');
  const authForm = document.getElementById('auth-form');
  const authTitle = document.getElementById('auth-title');
  const authDesc = document.getElementById('auth-desc');
  const pinInput = document.getElementById('pin-input');
  const authError = document.getElementById('auth-error');
  const authCancelBtn = document.getElementById('auth-cancel-btn');
  const authCornerGearBtn = document.getElementById('auth-corner-gear-btn');

  const controlServerModal = document.getElementById('control-server-modal');
  const controlServerClose = document.getElementById('control-server-close');
  const preauthServerCurrent = document.getElementById('preauth-server-current');
  const controlServerInput = document.getElementById('control-server-input');
  const controlServerError = document.getElementById('control-server-error');
  const controlResetServerBtn = document.getElementById('control-reset-server-btn');
  const controlSaveServerBtn = document.getElementById('control-save-server-btn');

  const settingsModal = document.getElementById('settings-modal');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const adminLogoutBtn = document.getElementById('admin-logout-btn');
  const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));

  const deviceDetailGrid = document.getElementById('device-detail-grid');
  const requiredDisplaysSelect = document.getElementById('required-displays-select');
  const offsetAInput = document.getElementById('offset-A-input');
  const offsetBInput = document.getElementById('offset-B-input');
  const saveDeviceConfigBtn = document.getElementById('save-device-config-btn');
  const resyncBtn = document.getElementById('resync-btn');

  const diskFreeLabel = document.getElementById('disk-free-label');
  const videoUploadInput = document.getElementById('video-upload-input');
  const videoUploadDropzone = document.getElementById('video-upload-dropzone');
  const videoUploadTitle = document.getElementById('video-upload-title');
  const videoUploadFileMeta = document.getElementById('video-upload-file-meta');
  const videoUploadBtn = document.getElementById('video-upload-btn');
  const videoUploadCancelBtn = document.getElementById('video-upload-cancel-btn');
  const videoUploadProgressWrap = document.getElementById('video-upload-progress-wrap');
  const videoUploadProgressFill = document.getElementById('video-upload-progress-fill');
  const videoUploadProgressText = document.getElementById('video-upload-progress-text');
  const videoUploadError = document.getElementById('video-upload-error');
  const boothTestPlayBtn = document.getElementById('booth-test-play-btn');
  const boothTestStopBtn = document.getElementById('booth-test-stop-btn');
  const videoListContainer = document.getElementById('video-list-container');
  const videoPreviewCard = document.getElementById('video-preview-card');
  const videoPreviewTitle = document.getElementById('video-preview-title');
  const videoPreviewClose = document.getElementById('video-preview-close');
  const videoPreviewPlayer = document.getElementById('video-preview-player');
  const presetEditorList = document.getElementById('preset-editor-list');
  const addPresetBtn = document.getElementById('add-preset-btn');
  const savePresetsBtn = document.getElementById('save-presets-btn');

  const changePinForm = document.getElementById('change-pin-form');
  const currentPinInput = document.getElementById('current-pin-input');
  const newAdminPinInput = document.getElementById('new-admin-pin-input');
  const newDisplayPinInput = document.getElementById('new-display-pin-input');
  const newSettingsPinInput = document.getElementById('new-settings-pin-input');
  const changePinError = document.getElementById('change-pin-error');

  const settingsServerApi = document.getElementById('settings-server-api');
  const settingsServerWs = document.getElementById('settings-server-ws');
  const settingsServerInput = document.getElementById('settings-server-input');
  const settingsServerError = document.getElementById('settings-server-error');
  const settingsResetServerBtn = document.getElementById('settings-reset-server-btn');
  const settingsSaveServerBtn = document.getElementById('settings-save-server-btn');

  let currentSnapshot = null;
  let presets = [
    '잠시 후 입장해 주세요',
    '영상이 곧 시작됩니다',
    '퇴장해 주세요',
    '스태프가 도와드릴게요'
  ];
  let pendingMsgText = '';
  let lastSentMsgText = '';
  let lastSentMsgAt = 0;

  let authMode = 'control'; // 'control' | 'admin'
  let activeAdminToken = '';
  let isSettingsOpen = false;
  let isSavingSettings = false;
  let pendingControlReauth = false;
  let activeUploadXhr = null;
  let droppedUploadFile = null;
  let wakeLock = null;
  let toastTimer = null;
  let settingsPollTimer = null;
  let timelineTimer = null;
  let driftCorrectionSec = 0;

  preauthServerCurrent.textContent = window.GHOST_CONFIG.apiBase;
  controlServerInput.value = window.GHOST_CONFIG.apiBase;
  settingsServerApi.textContent = window.GHOST_CONFIG.apiBase;
  settingsServerWs.textContent = window.GHOST_CONFIG.wsUrl;
  settingsServerInput.value = window.GHOST_CONFIG.apiBase;

  window.addEventListener('contextmenu', (e) => e.preventDefault());

  function showToast(text) {
    if (!text) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toastEl.classList.add('hidden');
    }, 2400);
  }

  function vibrate(pattern) {
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // ignore
      }
    }
  }

  async function requestDeviceLocks() {
    if (window.screen?.orientation?.lock) {
      try {
        await window.screen.orientation.lock('landscape');
      } catch {
        // ignore if unsupported or not in fullscreen
      }
    }
    if ('wakeLock' in navigator && !wakeLock) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } catch {
        // ignore
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.localStorage.getItem(CONTROL_TOKEN_KEY)) {
      requestDeviceLocks();
    }
  });

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(safe / 60);
    const s = String(safe % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function applyDot(el, dlEl, wrapEl, device, requiredList) {
    const dotColor = device?.dot || 'red';
    el.classList.remove('green', 'orange', 'red');
    el.classList.add(dotColor);

    if (Array.isArray(requiredList) && !requiredList.includes(device?.id)) {
      wrapEl.classList.add('optional');
    } else {
      wrapEl.classList.remove('optional');
    }

    const dl = Number(device?.dl || 0);
    if (device?.connected && dotColor === 'orange' && dl > 0 && dl < 100) {
      dlEl.textContent = `${dl}%`;
      dlEl.classList.remove('hidden');
    } else {
      dlEl.classList.add('hidden');
      dlEl.textContent = '';
    }
  }

  function updateTimelineDisplay() {
    const duration = currentSnapshot?.video?.duration || 0;
    const state = currentSnapshot?.state || 'NOT_READY';

    if (state === 'PLAYING' && currentSnapshot?.playback?.startAt) {
      const elapsedRaw = (client.serverNow() - currentSnapshot.playback.startAt) / 1000;
      const elapsed = Math.max(
        0,
        Math.min(duration || Number.MAX_SAFE_INTEGER, elapsedRaw + driftCorrectionSec)
      );
      const pct = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;
      timelineFill.style.width = `${pct.toFixed(2)}%`;
      timelineThumb.style.left = `${pct.toFixed(2)}%`;
      timeText.textContent = `${formatTime(elapsed)} / ${formatTime(duration)}`;
    } else {
      timelineFill.style.width = '0%';
      timelineThumb.style.left = '0%';
      timeText.textContent = `0:00 / ${formatTime(duration)}`;
    }

    if (state === 'COOLDOWN' && currentSnapshot?.cooldownUntil) {
      const remSec = Math.max(
        1,
        Math.ceil((currentSnapshot.cooldownUntil - client.serverNow()) / 1000)
      );
      cooldownLabel.textContent = `${remSec}초 후 대기 복귀`;
      cooldownLabel.classList.remove('hidden');
    } else if (currentSnapshot?.uploading) {
      cooldownLabel.textContent = '영상 업로드 중';
      cooldownLabel.classList.remove('hidden');
    } else {
      cooldownLabel.classList.add('hidden');
    }
  }

  function renderStatus(snapshot) {
    const prevState = currentSnapshot?.state;
    currentSnapshot = snapshot;

    const reqList = snapshot.requiredDisplays || ['A', 'B'];
    applyDot(dotA, dlA, dotWrapA, snapshot.displays?.A || { id: 'A' }, reqList);
    applyDot(dotB, dlB, dotWrapB, snapshot.displays?.B || { id: 'B' }, reqList);

    if (snapshot.state === 'PLAYING' && snapshot.playback) {
      if (prevState !== 'PLAYING') {
        driftCorrectionSec = 0;
      } else if (snapshot.playback.pos > 0) {
        const expected = Math.max(
          0,
          (client.serverNow() - snapshot.playback.startAt) / 1000 + driftCorrectionSec
        );
        const diff = snapshot.playback.pos - expected;
        if (Math.abs(diff) > 0.6 && Math.abs(diff) < 15) {
          driftCorrectionSec += diff * 0.5;
        }
      }
    } else {
      driftCorrectionSec = 0;
    }

    // Cancel any active play/stop hold if state changed away from READY/PLAYING
    if (playHoldState && playHoldState.expectedState !== snapshot.state) {
      cancelPlayHold();
    }

    playBtn.classList.remove('ready', 'playing', 'disabled');
    if (snapshot.state === 'READY' && client.isConnected()) {
      playBtn.classList.add('ready');
      playBtn.disabled = false;
      playIcon.src = './assets/play-ready.webp';
      playIcon.alt = '재생 (길게 누름)';
      if (playHint) playHint.textContent = '0.6초 길게 눌러 시작';
    } else if (snapshot.state === 'PLAYING' && client.isConnected()) {
      playBtn.classList.add('playing');
      playBtn.disabled = false;
      playIcon.src = './assets/play-playing.webp';
      playIcon.alt = '재생 중 (길게 눌러 정지)';
      if (playHint) playHint.textContent = '재생 중 · 1초 길게 눌러 정지';
    } else {
      playBtn.classList.add('disabled');
      playBtn.disabled = true;
      playIcon.src = './assets/play-ready.webp';
      playIcon.alt = '대기 중';
      if (playHint) {
        playHint.textContent =
          snapshot.state === 'COOLDOWN' ? '재시작 대기 중' : '기기 준비 대기 중';
      }
    }

    resyncBtn.disabled = snapshot.state === 'PLAYING';
    updateTimelineDisplay();
    if (!settingsModal.classList.contains('hidden')) {
      renderDeviceDetails(snapshot);
    }
  }

  // Long-press helper for Play/Stop button (0.6s READY -> play, 1s PLAYING -> stop)
  let playHoldState = null;

  function setPlayRingProgress(progress) {
    const clamped = Math.max(0, Math.min(1, progress));
    playRing.style.strokeDashoffset = String(PLAY_RING_LENGTH * (1 - clamped));
  }

  function cancelPlayHold() {
    if (!playHoldState) return;
    if (playHoldState.rafId) cancelAnimationFrame(playHoldState.rafId);
    playHoldState = null;
    playBtn.classList.remove('holding');
    setPlayRingProgress(0);
  }

  playBtn.addEventListener('pointerdown', (e) => {
    if (playBtn.disabled || playHoldState) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    requestDeviceLocks();

    const state = currentSnapshot?.state;
    if (state !== 'READY' && state !== 'PLAYING') return;

    const durationMs = state === 'READY' ? PLAY_HOLD_MS : STOP_HOLD_MS;
    const startedAt = performance.now();
    playHoldState = {
      pointerId: e.pointerId,
      expectedState: state,
      durationMs,
      rafId: null
    };
    playBtn.classList.add('holding');

    const tick = () => {
      if (!playHoldState) return;
      const progress = Math.max(0, performance.now() - startedAt) / playHoldState.durationMs;
      setPlayRingProgress(progress);

      if (progress >= 1) {
        const actionState = playHoldState.expectedState;
        cancelPlayHold();
        vibrate(actionState === 'READY' ? 45 : [40, 30, 60]);
        if (actionState === 'READY') {
          client.send({ t: 'play' });
        } else if (actionState === 'PLAYING') {
          client.send({ t: 'stop' });
        }
        return;
      }
      playHoldState.rafId = requestAnimationFrame(tick);
    };

    playHoldState.rafId = requestAnimationFrame(tick);
  });

  playBtn.addEventListener('pointermove', (e) => {
    if (!playHoldState || e.pointerId !== playHoldState.pointerId) return;
    const rect = playBtn.getBoundingClientRect();
    if (
      e.clientX < rect.left - 24 ||
      e.clientX > rect.right + 24 ||
      e.clientY < rect.top - 24 ||
      e.clientY > rect.bottom + 24
    ) {
      cancelPlayHold();
    }
  });

  const endPlayPointer = (e) => {
    if (playHoldState && e.pointerId === playHoldState.pointerId) {
      cancelPlayHold();
    }
  };
  playBtn.addEventListener('pointerup', endPlayPointer);
  playBtn.addEventListener('pointercancel', endPlayPointer);

  // Settings 3-second hold
  let settingsHoldState = null;

  function setSettingsRingProgress(progress) {
    const clamped = Math.max(0, Math.min(1, progress));
    settingsRing.style.strokeDashoffset = String(SETTINGS_RING_CIRCUMFERENCE * (1 - clamped));
  }

  function cancelSettingsHold() {
    if (!settingsHoldState) return;
    if (settingsHoldState.rafId) cancelAnimationFrame(settingsHoldState.rafId);
    settingsHoldState = null;
    setSettingsRingProgress(0);
  }

  settingsBtn.addEventListener('pointerdown', (e) => {
    if (settingsHoldState) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const startedAt = performance.now();
    settingsHoldState = {
      pointerId: e.pointerId,
      rafId: null
    };

    const tick = () => {
      if (!settingsHoldState) return;
      const progress = Math.max(0, performance.now() - startedAt) / SETTINGS_HOLD_MS;
      setSettingsRingProgress(progress);

      if (progress >= 1) {
        cancelSettingsHold();
        vibrate(35);
        openSettingsWithAuth();
        return;
      }
      settingsHoldState.rafId = requestAnimationFrame(tick);
    };
    settingsHoldState.rafId = requestAnimationFrame(tick);
  });

  settingsBtn.addEventListener('pointermove', (e) => {
    if (!settingsHoldState || e.pointerId !== settingsHoldState.pointerId) return;
    const rect = settingsBtn.getBoundingClientRect();
    if (
      e.clientX < rect.left - 14 ||
      e.clientX > rect.right + 14 ||
      e.clientY < rect.top - 14 ||
      e.clientY > rect.bottom + 14
    ) {
      cancelSettingsHold();
    }
  });

  const endSettingsPointer = (e) => {
    if (settingsHoldState && e.pointerId === settingsHoldState.pointerId) {
      cancelSettingsHold();
    }
  };
  settingsBtn.addEventListener('pointerup', endSettingsPointer);
  settingsBtn.addEventListener('pointercancel', endSettingsPointer);

  // WebSocket client
  const client = window.GhostWsClient.createSyncClient({
    wsBaseUrl: window.GHOST_CONFIG.wsUrl,
    apiBase: window.GHOST_CONFIG.apiBase,
    role: 'control',
    getToken: () => window.localStorage.getItem(CONTROL_TOKEN_KEY) || '',
    onStatusChange: ({ connected }) => {
      if (connected) {
        connPill.classList.add('hidden');
        fetchPresets();
      } else {
        connPill.classList.remove('hidden');
        if (currentSnapshot) {
          renderStatus(currentSnapshot);
        }
      }
    },
    onMessage: (msg) => {
      if (msg.t === 'status') {
        renderStatus(msg);
      } else if (msg.t === 'msg_ack') {
        showToast('안내 메시지를 전송했습니다.');
      } else if (msg.t === 'error') {
        if (msg.action === 'msg' && msg.error === 'duplicate_message') {
          showToast('동일한 메시지는 2초 후 재전송할 수 있습니다.');
        } else if (msg.error) {
          showToast(`요청 거부: ${msg.error}`);
        }
      }
    },
    onAuthError: () => {
      if (isSavingSettings) return;
      try {
        window.localStorage.removeItem(CONTROL_TOKEN_KEY);
      } catch {
        // ignore
      }
      if (isSettingsOpen) {
        pendingControlReauth = true;
        return;
      }
      closeMsgSheet();
      openAuthModal('control');
    }
  });

  // Message Bottom Sheet (Section 4.5)
  function renderPresetButtons() {
    presetGrid.textContent = '';
    for (const text of presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-choice-btn';
      btn.textContent = text;
      btn.addEventListener('click', () => enterMsgConfirm(text));
      presetGrid.appendChild(btn);
    }
  }

  function openMsgSheet() {
    requestDeviceLocks();
    renderPresetButtons();
    pendingMsgText = '';
    customMsgInput.value = '';
    msgSelectStep.classList.remove('hidden');
    msgConfirmStep.classList.add('hidden');
    msgSheetBackdrop.classList.remove('hidden');
  }

  function closeMsgSheet() {
    msgSheetBackdrop.classList.add('hidden');
    pendingMsgText = '';
  }

  function enterMsgConfirm(text) {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    pendingMsgText = clean;
    msgConfirmPreview.textContent = clean;
    msgSelectStep.classList.add('hidden');
    msgConfirmStep.classList.remove('hidden');
  }

  msgBtn.addEventListener('click', openMsgSheet);
  msgSheetClose.addEventListener('click', closeMsgSheet);
  msgSheetBackdrop.addEventListener('click', (e) => {
    if (e.target === msgSheetBackdrop) closeMsgSheet();
  });

  customMsgForm.addEventListener('submit', (e) => {
    e.preventDefault();
    enterMsgConfirm(customMsgInput.value);
  });

  msgCancelBtn.addEventListener('click', () => {
    msgSelectStep.classList.remove('hidden');
    msgConfirmStep.classList.add('hidden');
  });

  msgSendBtn.addEventListener('click', () => {
    if (!pendingMsgText) return;
    const now = Date.now();
    if (pendingMsgText === lastSentMsgText && now - lastSentMsgAt < 2000) {
      showToast('동일한 메시지는 2초 이내 재전송할 수 없습니다.');
      return;
    }
    const ok = client.send({ t: 'msg', text: pendingMsgText });
    if (!ok) {
      showToast('서버와 연결되어 있지 않습니다.');
      return;
    }
    lastSentMsgText = pendingMsgText;
    lastSentMsgAt = now;
    closeMsgSheet();
  });

  async function fetchPresets() {
    const token = window.localStorage.getItem(CONTROL_TOKEN_KEY);
    if (!token) return;
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/presets`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.presets)) {
        presets = data.presets;
      }
    } catch {
      // keep fallback presets
    }
  }

  // Auth Modal (shared for initial control bind + admin settings unlock)
  function openAuthModal(mode) {
    authMode = mode;
    authError.textContent = '';
    pinInput.value = '';
    if (mode === 'control') {
      authTitle.textContent = '관리자 로그인';
      authDesc.textContent = '조종기기 연결을 위해 관리자용 로그인 PIN을 입력해 주세요.';
      pinInput.placeholder = '관리자용 PIN 입력';
      authCancelBtn.classList.add('hidden');
      authCornerGearBtn.classList.remove('hidden');
    } else {
      authTitle.textContent = '설정 잠금 해제';
      authDesc.textContent = '설정 화면 진입을 위해 설정탭 전용 PIN을 입력해 주세요.';
      pinInput.placeholder = '설정탭 PIN 입력';
      authCancelBtn.classList.remove('hidden');
      authCornerGearBtn.classList.add('hidden');
    }
    authModal.classList.remove('hidden');
    setTimeout(() => pinInput.focus(), 50);
  }

  authCancelBtn.addEventListener('click', () => {
    authModal.classList.add('hidden');
    pinInput.value = '';
  });

  authCornerGearBtn.addEventListener('click', () => {
    controlServerError.textContent = '';
    preauthServerCurrent.textContent = window.GHOST_CONFIG.apiBase;
    controlServerInput.value = window.GHOST_CONFIG.apiBase;
    controlServerModal.classList.remove('hidden');
  });

  controlServerClose.addEventListener('click', () => {
    controlServerModal.classList.add('hidden');
  });

  controlResetServerBtn.addEventListener('click', () => {
    window.GHOST_CONFIG.clearServerOrigin();
    window.location.reload();
  });

  controlSaveServerBtn.addEventListener('click', () => {
    controlServerError.textContent = '';
    if (!window.GHOST_CONFIG.setServerOrigin(controlServerInput.value)) {
      controlServerError.textContent = '올바른 https:// (또는 로컬 http://) 서버 주소를 입력하세요.';
      return;
    }
    window.location.reload();
  });

  settingsResetServerBtn.addEventListener('click', () => {
    window.GHOST_CONFIG.clearServerOrigin();
    window.location.reload();
  });

  settingsSaveServerBtn.addEventListener('click', () => {
    settingsServerError.textContent = '';
    if (!window.GHOST_CONFIG.setServerOrigin(settingsServerInput.value)) {
      settingsServerError.textContent = '올바른 https:// (또는 로컬 http://) 서버 주소를 입력하세요.';
      return;
    }
    window.location.reload();
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    requestDeviceLocks();

    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin: pinInput.value,
          scope: authMode === 'admin' ? 'admin' : 'control'
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data.error === 'pin_locked') {
          authError.textContent = `잠금 상태입니다 (${data.retryAfterSec}초 후 재시도)`;
        } else if (typeof data.attemptsRemaining === 'number') {
          authError.textContent = `PIN이 올바르지 않습니다. (남은 시도 ${data.attemptsRemaining}회)`;
        } else {
          authError.textContent = 'PIN이 올바르지 않습니다.';
        }
        return;
      }

      pinInput.value = '';
      authModal.classList.add('hidden');

      if (authMode === 'control') {
        try {
          window.localStorage.setItem(CONTROL_TOKEN_KEY, data.token);
        } catch {
          // ignore
        }
        pendingControlReauth = false;
        client.connect();
      } else {
        setAdminToken(data.token);
        openSettingsModal();
      }
    } catch {
      authError.textContent = '서버에 연결할 수 없습니다.';
    }
  });

  function getAdminToken() {
    if (activeAdminToken) return activeAdminToken;
    try {
      const stored = window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
      if (stored) activeAdminToken = stored;
      return stored;
    } catch {
      return '';
    }
  }

  function setAdminToken(token) {
    activeAdminToken = token || '';
    try {
      if (activeAdminToken) {
        window.sessionStorage.setItem(ADMIN_TOKEN_KEY, activeAdminToken);
      } else {
        window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }

  // Settings Modal (Section 4.6)
  async function openSettingsWithAuth() {
    if (isSettingsOpen) return;
    const adminToken = getAdminToken();
    if (!adminToken) {
      openAuthModal('admin');
      return;
    }
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth/verify`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      if (!res.ok) {
        setAdminToken('');
        openAuthModal('admin');
        return;
      }
      const data = await res.json();
      if (data.scope !== 'admin') {
        setAdminToken('');
        openAuthModal('admin');
        return;
      }
      openSettingsModal();
    } catch {
      showToast('서버 연결을 확인해 주세요.');
    }
  }

  function getAdminHeaders(json = false) {
    const token = getAdminToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Ghost-Token': token
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function renderDeviceDetails(snapshot) {
    if (!snapshot) return;
    deviceDetailGrid.textContent = '';

    for (const id of ['A', 'B']) {
      const d = snapshot.displays?.[id] || { id, connected: false };
      const card = document.createElement('div');
      card.className = 'settings-card';

      const title = document.createElement('h3');
      title.textContent = `피조종기기 ${id}`;
      card.appendChild(title);

      const dl = document.createElement('dl');
      dl.className = 'detail-dl';

      const heartbeatAgo = d.lastSeen
        ? `${Math.max(0, Math.round((Date.now() - d.lastSeen) / 1000))}초 전`
        : '기록 없음';

      const rows = [
        ['접속 상태', d.connected ? '접속 중' : '끊김'],
        ['캐시 상태', d.ready ? '준비 완료 (100%)' : `${Number(d.dl || 0)}%`],
        ['마지막 하트비트', heartbeatAgo],
        ['시계 오차 / RTT', d.rttMs !== null ? `${d.offsetMs ?? 0}ms / ${d.rttMs}ms` : '미측정'],
        ['오류', d.error || '없음']
      ];

      for (const [k, v] of rows) {
        const rowDiv = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        rowDiv.appendChild(dt);
        rowDiv.appendChild(dd);
        dl.appendChild(rowDiv);
      }

      card.appendChild(dl);
      deviceDetailGrid.appendChild(card);
    }
  }

  function renderPresetEditor(list) {
    presetEditorList.textContent = '';
    for (const item of list) {
      addPresetEditorRow(item);
    }
  }

  function addPresetEditorRow(value = '') {
    const row = document.createElement('div');
    row.className = 'preset-edit-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.value = value;
    input.placeholder = '안내 문구 입력';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger-btn small';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', () => row.remove());

    row.appendChild(input);
    row.appendChild(delBtn);
    presetEditorList.appendChild(row);
  }

  function closeVideoPreview() {
    if (!videoPreviewPlayer) return;
    try {
      videoPreviewPlayer.pause();
    } catch {
      // ignore
    }
    videoPreviewPlayer.removeAttribute('src');
    videoPreviewPlayer.load();
    videoPreviewCard.classList.add('hidden');
  }

  function openVideoPreview(video) {
    const token = getAdminToken();
    if (!token || !video?.id) return;
    videoPreviewTitle.textContent = `미리보기 · ${video.filename}`;
    videoPreviewPlayer.src = `${window.GHOST_CONFIG.apiBase}/video/${encodeURIComponent(
      video.id
    )}?token=${encodeURIComponent(token)}`;
    videoPreviewCard.classList.remove('hidden');
    videoPreviewPlayer.play().catch(() => {});
  }

  function renderVideoList(videos) {
    videoListContainer.textContent = '';
    if (!videos || videos.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'modal-desc';
      empty.textContent = '등록된 영상이 없습니다. 상단에서 MP4 파일을 업로드해 주세요.';
      videoListContainer.appendChild(empty);
      return;
    }

    for (const v of videos) {
      const row = document.createElement('div');
      row.className = `video-item${v.active ? ' active' : ''}`;

      const info = document.createElement('div');
      info.className = 'video-item-info';

      const titleRow = document.createElement('div');
      titleRow.className = 'video-item-title';

      const badge = document.createElement('span');
      badge.className = `video-badge ${v.active ? 'active' : 'archived'}`;
      badge.textContent = v.active ? '활성' : '보관';

      const nameEl = document.createElement('span');
      nameEl.textContent = v.filename;

      titleRow.appendChild(badge);
      titleRow.appendChild(nameEl);

      const meta = document.createElement('div');
      meta.className = 'muted-meta';
      const uploadedAt = v.uploadedAt
        ? new Date(v.uploadedAt).toLocaleString('ko-KR', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })
        : '';
      meta.textContent = `${formatTime(v.duration)} · ${formatBytes(v.size)}${
        uploadedAt ? ` · ${uploadedAt}` : ''
      }`;

      info.appendChild(titleRow);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'video-item-actions';

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'secondary-btn small';
      previewBtn.textContent = '미리보기';
      previewBtn.addEventListener('click', () => openVideoPreview(v));
      actions.appendChild(previewBtn);

      if (!v.active) {
        const activateBtn = document.createElement('button');
        activateBtn.type = 'button';
        activateBtn.className = 'primary-btn small';
        activateBtn.textContent = '적용';
        activateBtn.addEventListener('click', () => handleActivateVideo(v.id));
        actions.appendChild(activateBtn);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger-btn small';
        delBtn.textContent = '삭제';
        delBtn.addEventListener('click', () => handleDeleteVideo(v.id, v.filename));
        actions.appendChild(delBtn);
      }

      row.appendChild(info);
      row.appendChild(actions);
      videoListContainer.appendChild(row);
    }
  }

  async function refreshVideosList() {
    const token = getAdminToken();
    if (!token) return;
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/videos`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        diskFreeLabel.textContent = `디스크 여유: ${formatBytes(data.diskFreeBytes)}`;
        renderVideoList(data.videos || []);
      }
    } catch {
      // ignore transient refresh failure
    }
  }

  async function handleActivateVideo(videoId) {
    try {
      const res = await fetch(
        `${window.GHOST_CONFIG.apiBase}/videos/${encodeURIComponent(videoId)}/activate`,
        {
          method: 'POST',
          headers: getAdminHeaders()
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast(`영상 적용 실패: ${data.reason || data.error || '상태를 확인하세요'}`);
        return;
      }
      renderVideoList(data.videos || []);
      showToast('선택한 영상을 활성 영상으로 전환했습니다. 기기들이 자동 동기화합니다.');
    } catch {
      showToast('서버 통신 오류');
    }
  }

  async function handleDeleteVideo(videoId, filename) {
    try {
      const res = await fetch(
        `${window.GHOST_CONFIG.apiBase}/video/${encodeURIComponent(videoId)}`,
        {
          method: 'DELETE',
          headers: getAdminHeaders()
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast(`삭제 실패: ${data.error || '오류'}`);
        return;
      }
      diskFreeLabel.textContent = `디스크 여유: ${formatBytes(data.diskFreeBytes)}`;
      renderVideoList(data.videos || []);
      showToast(`'${filename}' 영상을 삭제했습니다.`);
    } catch {
      showToast('서버 통신 오류');
    }
  }

  async function loadSettingsData() {
    const usedToken = getAdminToken();
    if (!usedToken) return;
    try {
      const [settingsRes, videosRes, statusRes] = await Promise.all([
        fetch(`${window.GHOST_CONFIG.apiBase}/settings`, { headers: { Authorization: `Bearer ${usedToken}` } }),
        fetch(`${window.GHOST_CONFIG.apiBase}/videos`, { headers: { Authorization: `Bearer ${usedToken}` } }),
        fetch(`${window.GHOST_CONFIG.apiBase}/status`, { headers: { Authorization: `Bearer ${usedToken}` } })
      ]);

      if (usedToken !== getAdminToken() || isSavingSettings) {
        return;
      }

      if (settingsRes.status === 401 || settingsRes.status === 403) {
        showToast('설정 인증 확인에 실패했습니다. 설정탭을 나간 후 다시 로그인해 주세요.');
        return;
      }

      const settingsData = await settingsRes.json();
      if (settingsData.ok) {
        presets = settingsData.presets || presets;
        renderPresetEditor(presets);
        const reqVal = (settingsData.requiredDisplays || ['A', 'B']).join(',');
        requiredDisplaysSelect.value = ['A,B', 'A', 'B'].includes(reqVal) ? reqVal : 'A,B';
        offsetAInput.value = String(settingsData.audioOffsets?.A ?? 0);
        offsetBInput.value = String(settingsData.audioOffsets?.B ?? 0);
      }

      if (videosRes.ok) {
        const videosData = await videosRes.json();
        diskFreeLabel.textContent = `디스크 여유: ${formatBytes(videosData.diskFreeBytes)}`;
        renderVideoList(videosData.videos || []);
      }

      if (statusRes.ok) {
        const statusData = await statusRes.json();
        renderStatus(statusData);
      }
    } catch {
      showToast('설정 정보를 불러오지 못했습니다.');
    }
  }

  function startSettingsPolling() {
    if (settingsPollTimer) clearInterval(settingsPollTimer);
    settingsPollTimer = setInterval(async () => {
      if (!isSettingsOpen || isSavingSettings) return;
      const usedToken = getAdminToken();
      if (!usedToken) return;
      try {
        const res = await fetch(`${window.GHOST_CONFIG.apiBase}/status`, {
          headers: { Authorization: `Bearer ${usedToken}` }
        });
        if (usedToken !== getAdminToken() || isSavingSettings || !isSettingsOpen) {
          return;
        }
        if (res.ok) {
          const data = await res.json();
          renderStatus(data);
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2000);
  }

  function openSettingsModal() {
    isSettingsOpen = true;
    settingsModal.classList.remove('hidden');
    loadSettingsData();
    startSettingsPolling();
  }

  function closeSettingsModal(force = false) {
    if (activeUploadXhr && !force) {
      showToast('영상 업로드 중에는 설정창을 닫을 수 없습니다.');
      return;
    }
    if (activeUploadXhr) {
      try {
        activeUploadXhr.abort();
      } catch {
        // ignore
      }
      activeUploadXhr = null;
    }
    closeVideoPreview();
    if (settingsPollTimer) {
      clearInterval(settingsPollTimer);
      settingsPollTimer = null;
    }
    isSettingsOpen = false;
    setAdminToken('');
    settingsModal.classList.add('hidden');
    if (pendingControlReauth) {
      pendingControlReauth = false;
      openAuthModal('control');
    }
  }

  settingsCloseBtn.addEventListener('click', () => closeSettingsModal(false));

  for (const btn of tabBtns) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      for (const b of tabBtns) b.classList.toggle('active', b === btn);
      for (const pane of document.querySelectorAll('.tab-pane')) {
        pane.classList.toggle('hidden', pane.id !== `tab-${target}`);
      }
      if (target === 'videos') {
        refreshVideosList();
      }
    });
  }

  fullscreenBtn.addEventListener('click', async () => {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        // ignore
      }
    }
    await requestDeviceLocks();
  });

  adminLogoutBtn.addEventListener('click', () => {
    closeSettingsModal(true);
    showToast('설정이 잠금되었습니다.');
  });

  videoPreviewClose.addEventListener('click', closeVideoPreview);

  boothTestPlayBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/test-play`, {
        method: 'POST',
        headers: getAdminHeaders()
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast(`테스트 재생 불가: ${data.reason || '연결/캐시 상태를 확인하세요'}`);
        return;
      }
      showToast('연결된 체험자 기기에서 테스트 재생을 시작합니다.');
    } catch {
      showToast('서버 통신 오류');
    }
  });

  boothTestStopBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/test-stop`, {
        method: 'POST',
        headers: getAdminHeaders()
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast('현재 재생 중이 아닙니다.');
        return;
      }
      showToast('테스트 재생을 정지했습니다.');
    } catch {
      showToast('서버 통신 오류');
    }
  });

  function updateSelectedUploadFile(file) {
    if (!file) {
      droppedUploadFile = null;
      videoUploadDropzone.classList.remove('has-file');
      videoUploadTitle.textContent = '여기를 눌러 MP4 영상 파일을 선택하거나 끌어다 놓으세요';
      videoUploadFileMeta.textContent = '선택된 파일 없음 · 용량 제한 없음 (H.264 / AAC MP4)';
      return;
    }
    videoUploadError.textContent = '';
    videoUploadDropzone.classList.add('has-file');
    videoUploadTitle.textContent = file.name || '선택된 영상.mp4';
    videoUploadFileMeta.textContent = `${formatBytes(file.size)} · 업로드 준비 완료`;
  }

  videoUploadInput.addEventListener('change', () => {
    droppedUploadFile = null;
    updateSelectedUploadFile(videoUploadInput.files?.[0] || null);
  });

  videoUploadDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!videoUploadInput.disabled) {
      videoUploadDropzone.classList.add('dragover');
    }
  });

  videoUploadDropzone.addEventListener('dragleave', () => {
    videoUploadDropzone.classList.remove('dragover');
  });

  videoUploadDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    videoUploadDropzone.classList.remove('dragover');
    if (videoUploadInput.disabled) return;
    const file = e.dataTransfer?.files?.[0] || null;
    if (file) {
      droppedUploadFile = file;
      updateSelectedUploadFile(file);
    }
  });

  function setUploadUiState(isUploading, pct = 0, label = '') {
    videoUploadBtn.disabled = isUploading;
    videoUploadInput.disabled = isUploading;
    videoUploadDropzone.style.pointerEvents = isUploading ? 'none' : '';
    videoUploadCancelBtn.classList.toggle('hidden', !isUploading);
    videoUploadProgressWrap.classList.toggle('hidden', !isUploading && pct === 0);
    videoUploadProgressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (label) videoUploadProgressText.textContent = label;
  }

  videoUploadCancelBtn.addEventListener('click', () => {
    if (activeUploadXhr) {
      activeUploadXhr.abort();
      activeUploadXhr = null;
      setUploadUiState(false, 0, '');
      videoUploadError.textContent = '업로드가 취소되었습니다.';
    }
  });

  videoUploadBtn.addEventListener('click', () => {
    videoUploadError.textContent = '';
    const file = droppedUploadFile || videoUploadInput.files?.[0];
    if (!file) {
      videoUploadError.textContent = '업로드할 MP4 파일을 먼저 선택해 주세요.';
      return;
    }
    const token = getAdminToken();
    if (!token) {
      videoUploadError.textContent = '설정 인증이 만료되었습니다. 설정을 닫고 다시 로그인해 주세요.';
      return;
    }

    const formData = new FormData();
    formData.append('video', file, file.name || 'video.mp4');

    const xhr = new XMLHttpRequest();
    activeUploadXhr = xhr;
    setUploadUiState(true, 0, `0% · 0 MB / ${formatBytes(file.size)}`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
      const label =
        pct >= 100
          ? `100% · 서버 MP4 검사 및 저장 중...`
          : `${pct}% · ${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
      setUploadUiState(true, pct, label);
    };

    xhr.onload = () => {
      activeUploadXhr = null;
      setUploadUiState(false, 0, '');
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
        videoUploadInput.value = '';
        updateSelectedUploadFile(null);
        diskFreeLabel.textContent = `디스크 여유: ${formatBytes(data.diskFreeBytes)}`;
        renderVideoList(data.videos || []);
        showToast('영상 업로드 및 적용 완료! A/B 기기로 자동 배포됩니다.');
        return;
      }

      const errMap = {
        missing_token: '설정 인증 토큰이 전달되지 않았습니다. 설정을 닫았다가 다시 열어 주세요.',
        token_expired: '설정 인증 시간이 만료되었습니다. 설정을 다시 열어 주세요.',
        invalid_signature: '서버가 재시작되어 인증이 초기화되었습니다. 설정을 다시 열어 주세요.',
        forbidden_scope: '관리자 설정 권한이 필요합니다.',
        invalid_mp4_header: '유효한 MP4(H.264/AAC) 파일이 아닙니다.',
        missing_moov_box: 'MP4 메타데이터(moov)가 손상되었거나 없습니다.',
        missing_media_track: '영상/오디오 트랙을 찾을 수 없습니다.',
        invalid_mp4_duration: 'MP4 재생 길이를 확인할 수 없습니다.',
        insufficient_disk_space: '서버 디스크 여유 공간이 부족합니다.',
        busy_cannot_upload: '재생 중이거나 다른 업로드가 진행 중입니다.'
      };
      videoUploadError.textContent = errMap[data.error] || `업로드 실패 (${data.error || xhr.status})`;
    };

    xhr.onerror = () => {
      activeUploadXhr = null;
      setUploadUiState(false, 0, '');
      videoUploadError.textContent = '네트워크 오류로 업로드에 실패했습니다.';
    };

    xhr.onabort = () => {
      activeUploadXhr = null;
      setUploadUiState(false, 0, '');
    };

    xhr.open('POST', `${window.GHOST_CONFIG.apiBase}/upload?token=${encodeURIComponent(token)}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('X-Ghost-Token', token);
    xhr.send(formData);
  });

  saveDeviceConfigBtn.addEventListener('click', async () => {
    const requiredDisplays = requiredDisplaysSelect.value.split(',');
    const audioOffsets = {
      A: Number(offsetAInput.value || 0),
      B: Number(offsetBInput.value || 0)
    };
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/settings`, {
        method: 'PUT',
        headers: getAdminHeaders(true),
        body: JSON.stringify({ requiredDisplays, audioOffsets })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast('구성 저장 실패');
        return;
      }
      showToast('기기 구성이 저장되었습니다.');
    } catch {
      showToast('서버 통신 오류');
    }
  });

  resyncBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/resync`, {
        method: 'POST',
        headers: getAdminHeaders()
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast(`재동기화 불가: ${data.reason || '상태 확인'}`);
        return;
      }
      showToast('A/B 기기에 영상 재다운로드 명령을 보냈습니다.');
    } catch {
      showToast('서버 통신 오류');
    }
  });

  addPresetBtn.addEventListener('click', () => {
    if (presetEditorList.children.length >= 12) {
      showToast('프리셋은 최대 12개까지 등록할 수 있습니다.');
      return;
    }
    addPresetEditorRow('');
  });

  savePresetsBtn.addEventListener('click', async () => {
    const nextPresets = Array.from(presetEditorList.querySelectorAll('input'))
      .map((inp) => inp.value.trim())
      .filter(Boolean);
    if (nextPresets.length === 0) {
      showToast('최소 1개 이상의 프리셋이 필요합니다.');
      return;
    }
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/settings`, {
        method: 'PUT',
        headers: getAdminHeaders(true),
        body: JSON.stringify({ presets: nextPresets })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast('프리셋 저장 실패');
        return;
      }
      presets = data.presets;
      renderPresetEditor(presets);
      showToast('메시지 프리셋이 저장되었습니다.');
    } catch {
      showToast('서버 통신 오류');
    }
  });

  changePinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    changePinError.textContent = '';

    const nextAdmin = newAdminPinInput.value.trim();
    const nextDisplay = newDisplayPinInput.value.trim();
    const nextSettings = newSettingsPinInput.value.trim();
    if (!nextAdmin && !nextDisplay && !nextSettings) {
      changePinError.textContent = '변경할 PIN을 최소 1개 이상 입력해 주세요.';
      return;
    }

    isSavingSettings = true;
    if (settingsPollTimer) {
      clearInterval(settingsPollTimer);
      settingsPollTimer = null;
    }
    client.disconnect();

    try {
      const payload = { currentPin: currentPinInput.value };
      if (nextAdmin) payload.newAdminPin = nextAdmin;
      if (nextDisplay) payload.newDisplayPin = nextDisplay;
      if (nextSettings) payload.newSettingsPin = nextSettings;

      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/settings/pin`, {
        method: 'PUT',
        headers: getAdminHeaders(true),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data.error === 'pin_locked') {
          changePinError.textContent = `잠금 상태입니다 (${data.retryAfterSec}초 후 재시도)`;
        } else if (typeof data.attemptsRemaining === 'number') {
          changePinError.textContent = `현재 설정탭 PIN이 올바르지 않습니다. (남은 시도 ${data.attemptsRemaining}회)`;
        } else {
          changePinError.textContent = 'PIN 형식을 확인해 주세요 (4~64자).';
        }
        return;
      }

      setAdminToken(data.token);
      if (data.controlToken) {
        try {
          window.localStorage.setItem(CONTROL_TOKEN_KEY, data.controlToken);
        } catch {
          // ignore
        }
      }
      pendingControlReauth = false;
      currentPinInput.value = '';
      newAdminPinInput.value = '';
      newDisplayPinInput.value = '';
      newSettingsPinInput.value = '';
      showToast('PIN이 저장되었습니다. 설정탭을 나가기 전까지 유지됩니다.');
    } catch {
      changePinError.textContent = '서버 통신 오류';
    } finally {
      isSavingSettings = false;
      client.connect();
      if (isSettingsOpen) {
        startSettingsPolling();
      }
    }
  });

  // Initialize operational startup
  async function verifyAndStart() {
    timelineTimer = setInterval(updateTimelineDisplay, 200);

    const token = window.localStorage.getItem(CONTROL_TOKEN_KEY);
    if (!token) {
      openAuthModal('control');
      return;
    }
    try {
      const res = await fetch(`${window.GHOST_CONFIG.apiBase}/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401 || res.status === 403) {
        window.localStorage.removeItem(CONTROL_TOKEN_KEY);
        openAuthModal('control');
        return;
      }
      authModal.classList.add('hidden');
      client.connect();
    } catch {
      client.connect();
    }
  }

  verifyAndStart();

  window.__GHOST_CONTROL_API__ = {
    getSnapshot: () => currentSnapshot,
    getPresets: () => [...presets],
    cancelPlayHold,
    cancelSettingsHold
  };
})();
