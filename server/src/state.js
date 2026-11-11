'use strict';

const STATES = {
  NOT_READY: 'NOT_READY',
  READY: 'READY',
  PLAYING: 'PLAYING',
  COOLDOWN: 'COOLDOWN'
};

function createDisplayRecord(id) {
  return {
    id,
    connected: false,
    cached: [],
    dl: 0,
    pos: 0,
    lastSeen: null,
    rttMs: null,
    offsetMs: null,
    error: null
  };
}

function createStateMachine({ config, db, onBroadcast, onSendToDisplays, onCloseDisplaySocket }) {
  let state = STATES.NOT_READY;
  let activeVideo = db.getActiveVideo();
  let requiredDisplays = db.getRequiredDisplays();
  let audioOffsets = db.getAudioOffsets();
  let controlConnected = false;
  let uploading = false;

  const displays = {
    A: createDisplayRecord('A'),
    B: createDisplayRecord('B')
  };

  let playback = null; // { videoId, startAt, pos, playLogId, startedDisplays: Set, endedDisplays: Set }
  let cooldownUntil = null;
  let cooldownTimer = null;
  let safetyTimer = null;

  let lastMsgText = '';
  let lastMsgAt = 0;

  function isDisplayReadyForVideo(display, video) {
    if (!video || !display || !display.connected) return false;
    return display.cached.includes(video.id) && Number(display.dl) >= 100;
  }

  function getDisplayDotColor(display) {
    if (!display.connected) return 'red';
    if (isDisplayReadyForVideo(display, activeVideo)) return 'green';
    return 'orange';
  }

  function areRequiredDisplaysReady() {
    if (!activeVideo) return false;
    return requiredDisplays.every((id) => isDisplayReadyForVideo(displays[id], activeVideo));
  }

  function recomputeState() {
    if (state === STATES.PLAYING || state === STATES.COOLDOWN) {
      return state;
    }
    if (uploading) {
      state = STATES.NOT_READY;
      return state;
    }
    state = areRequiredDisplaysReady() ? STATES.READY : STATES.NOT_READY;
    return state;
  }

  function clearPlaybackTimers() {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  }

  function clearCooldownTimer() {
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
  }

  function getSnapshot() {
    const now = Date.now();
    let computedPos = 0;
    if (state === STATES.PLAYING && playback) {
      const elapsedSec = Math.max(0, (now - playback.startAt) / 1000);
      computedPos = playback.pos > 0 ? playback.pos : elapsedSec;
      if (activeVideo && activeVideo.duration > 0) {
        computedPos = Math.min(computedPos, activeVideo.duration);
      }
    }

    return {
      t: 'status',
      serverTime: now,
      state,
      uploading,
      requiredDisplays: [...requiredDisplays],
      audioOffsets: { ...audioOffsets },
      video: activeVideo
        ? {
            id: activeVideo.id,
            filename: activeVideo.filename,
            size: activeVideo.size,
            duration: activeVideo.duration,
            sha256: activeVideo.sha256,
            uploadedAt: activeVideo.uploadedAt
          }
        : null,
      playback: playback
        ? {
            videoId: playback.videoId,
            startAt: playback.startAt,
            pos: Number(computedPos.toFixed(2))
          }
        : null,
      cooldownUntil,
      controlConnected,
      displays: {
        A: {
          ...displays.A,
          ready: isDisplayReadyForVideo(displays.A, activeVideo),
          dot: getDisplayDotColor(displays.A)
        },
        B: {
          ...displays.B,
          ready: isDisplayReadyForVideo(displays.B, activeVideo),
          dot: getDisplayDotColor(displays.B)
        }
      }
    };
  }

  function emitStatus() {
    if (typeof onBroadcast === 'function') {
      onBroadcast(getSnapshot());
    }
  }

  function enterCooldown(endedBy) {
    clearPlaybackTimers();
    if (playback && playback.playLogId) {
      db.finishPlayLog(playback.playLogId, endedBy, Date.now());
    }
    playback = null;
    displays.A.pos = 0;
    displays.B.pos = 0;

    state = STATES.COOLDOWN;
    cooldownUntil = Date.now() + config.cooldownMs;
    clearCooldownTimer();
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      cooldownUntil = null;
      state = STATES.NOT_READY;
      recomputeState();
      emitStatus();
    }, config.cooldownMs);

    emitStatus();
  }

  function setControlConnected(connected) {
    controlConnected = Boolean(connected);
    emitStatus();
  }

  function connectDisplay(id) {
    const d = displays[id];
    if (!d) return;
    d.connected = true;
    d.lastSeen = Date.now();
    d.error = null;
    recomputeState();
    emitStatus();
  }

  function disconnectDisplay(id) {
    const d = displays[id];
    if (!d) return;
    d.connected = false;
    recomputeState();

    // If playing and NO playing displays remain connected, stop cleanly
    if (state === STATES.PLAYING && playback) {
      const anyConnectedPlaying = [...playback.startedDisplays].some(
        (dispId) => displays[dispId]?.connected
      );
      if (!anyConnectedPlaying) {
        enterCooldown('stop');
        return;
      }
      // If remaining connected displays already sent ended, complete now
      checkPlaybackCompletion();
    }

    emitStatus();
  }

  function touchHeartbeat(id, metrics = {}) {
    const d = displays[id];
    if (!d) return;
    d.lastSeen = Date.now();
    if (!d.connected) {
      d.connected = true;
      recomputeState();
    }
    if (typeof metrics.rttMs === 'number' && Number.isFinite(metrics.rttMs)) {
      d.rttMs = Math.round(metrics.rttMs);
    }
    if (typeof metrics.offsetMs === 'number' && Number.isFinite(metrics.offsetMs)) {
      d.offsetMs = Math.round(metrics.offsetMs);
    }
  }

  function updateDisplayState(id, payload = {}) {
    const d = displays[id];
    if (!d) return;
    d.lastSeen = Date.now();
    d.connected = true;
    if (Array.isArray(payload.cached)) {
      d.cached = payload.cached.map(String);
    }
    if (typeof payload.dl === 'number' && Number.isFinite(payload.dl)) {
      d.dl = Math.max(0, Math.min(100, Math.round(payload.dl)));
    }
    if (typeof payload.rttMs === 'number' && Number.isFinite(payload.rttMs)) {
      d.rttMs = Math.round(metricsOr(payload.rttMs));
    }
    if (typeof payload.offsetMs === 'number' && Number.isFinite(payload.offsetMs)) {
      d.offsetMs = Math.round(metricsOr(payload.offsetMs));
    }
    d.error = payload.error ? String(payload.error) : null;
    recomputeState();
    emitStatus();
  }

  function metricsOr(v) {
    return Number.isFinite(v) ? v : 0;
  }

  function updateDisplayPos(id, payload = {}) {
    const d = displays[id];
    if (!d) return;
    d.lastSeen = Date.now();
    const pos = Number(payload.pos);
    if (Number.isFinite(pos) && pos >= 0) {
      d.pos = pos;
      if (state === STATES.PLAYING && playback) {
        if (!payload.videoId || payload.videoId === playback.videoId) {
          playback.pos = pos;
          emitStatus();
        }
      }
    }
  }

  function checkPlaybackCompletion() {
    if (state !== STATES.PLAYING || !playback) return false;
    const expectedDisplays = [...playback.startedDisplays].filter(
      (dispId) => displays[dispId]?.connected
    );
    if (expectedDisplays.length === 0) {
      enterCooldown('end');
      return true;
    }
    const allEnded = expectedDisplays.every((dispId) => playback.endedDisplays.has(dispId));
    if (allEnded) {
      enterCooldown('end');
      return true;
    }
    return false;
  }

  function handleDisplayEnded(id, payload = {}) {
    const d = displays[id];
    if (d) {
      d.lastSeen = Date.now();
      d.pos = 0;
    }
    if (state !== STATES.PLAYING || !playback) return;
    if (payload.videoId && payload.videoId !== playback.videoId) return;
    playback.endedDisplays.add(id);
    checkPlaybackCompletion();
  }

  function requestPlay() {
    recomputeState();
    if (state !== STATES.READY || !activeVideo) {
      return {
        ok: false,
        reason: state === STATES.PLAYING ? 'already_playing' : 'not_ready',
        state
      };
    }

    const now = Date.now();
    const startAt = now + config.playScheduleLeadMs;
    const playLogId = db.startPlayLog(activeVideo.id, startAt);

    const startedDisplays = new Set(
      ['A', 'B'].filter((id) => displays[id].connected && isDisplayReadyForVideo(displays[id], activeVideo))
    );

    playback = {
      videoId: activeVideo.id,
      startAt,
      pos: 0,
      playLogId,
      startedDisplays,
      endedDisplays: new Set()
    };
    displays.A.pos = 0;
    displays.B.pos = 0;
    state = STATES.PLAYING;

    const durationMs = Math.max(1000, Math.round(activeVideo.duration * 1000));
    const safetyTimeoutMs = durationMs + config.playScheduleLeadMs + config.playbackSafetyMarginMs;
    clearPlaybackTimers();
    safetyTimer = setTimeout(() => {
      if (state === STATES.PLAYING) {
        if (typeof onSendToDisplays === 'function') {
          onSendToDisplays({ t: 'stop' });
        }
        enterCooldown('timeout');
      }
    }, safetyTimeoutMs);

    if (typeof onSendToDisplays === 'function') {
      for (const dispId of ['A', 'B']) {
        const offset = Number(audioOffsets[dispId] || 0);
        onSendToDisplays(
          {
            t: 'play',
            videoId: activeVideo.id,
            startAt: startAt + offset
          },
          dispId
        );
      }
    }

    emitStatus();
    return {
      ok: true,
      videoId: activeVideo.id,
      startAt
    };
  }

  function requestStop() {
    if (state !== STATES.PLAYING) {
      return { ok: false, reason: 'not_playing', state };
    }
    if (typeof onSendToDisplays === 'function') {
      onSendToDisplays({ t: 'stop' });
    }
    enterCooldown('stop');
    return { ok: true };
  }

  function sendMessage(rawText) {
    const text = String(rawText ?? '').trim();
    if (!text) {
      return { ok: false, reason: 'empty_message' };
    }
    if (text.length > 200) {
      return { ok: false, reason: 'message_too_long' };
    }
    const now = Date.now();
    if (text === lastMsgText && now - lastMsgAt < config.msgDuplicateWindowMs) {
      return { ok: false, reason: 'duplicate_message' };
    }
    lastMsgText = text;
    lastMsgAt = now;

    if (typeof onSendToDisplays === 'function') {
      onSendToDisplays({ t: 'msg', text, ms: 5000 });
    }
    return { ok: true, text, ms: 5000 };
  }

  function getActiveVideoMessage() {
    if (!activeVideo) {
      return { t: 'video', videoId: null, url: null, size: 0, sha256: null, duration: 0 };
    }
    return {
      t: 'video',
      videoId: activeVideo.id,
      url: `/video/${encodeURIComponent(activeVideo.id)}`,
      size: activeVideo.size,
      sha256: activeVideo.sha256,
      duration: activeVideo.duration
    };
  }

  function activateVideo(videoId) {
    if (state === STATES.PLAYING || state === STATES.COOLDOWN) {
      return { ok: false, reason: 'cannot_activate_while_playing', state };
    }
    const updated = db.activateVideo(videoId);
    if (!updated) {
      return { ok: false, reason: 'video_not_found' };
    }
    activeVideo = updated;
    // Reset download status until displays confirm cache for new video
    for (const id of ['A', 'B']) {
      if (!displays[id].cached.includes(activeVideo.id)) {
        displays[id].dl = 0;
      }
    }
    recomputeState();

    if (typeof onSendToDisplays === 'function') {
      onSendToDisplays(getActiveVideoMessage());
    }
    emitStatus();
    return { ok: true, video: activeVideo };
  }

  function setUploading(isUploading) {
    uploading = Boolean(isUploading);
    recomputeState();
    emitStatus();
  }

  function setRequiredDisplays(nextDisplays) {
    requiredDisplays = db.setRequiredDisplays(nextDisplays);
    recomputeState();
    emitStatus();
    return requiredDisplays;
  }

  function setAudioOffsets(nextOffsets) {
    audioOffsets = db.setAudioOffsets(nextOffsets);
    emitStatus();
    return audioOffsets;
  }

  function triggerResync() {
    if (state === STATES.PLAYING) {
      return { ok: false, reason: 'cannot_resync_while_playing' };
    }
    if (!activeVideo) {
      return { ok: false, reason: 'no_active_video' };
    }
    for (const id of ['A', 'B']) {
      displays[id].cached = displays[id].cached.filter((vid) => vid !== activeVideo.id);
      displays[id].dl = 0;
    }
    recomputeState();
    if (typeof onSendToDisplays === 'function') {
      onSendToDisplays({
        t: 'resync',
        ...getActiveVideoMessage()
      });
    }
    emitStatus();
    return { ok: true };
  }

  function checkHeartbeats(now = Date.now()) {
    let changed = false;
    for (const id of ['A', 'B']) {
      const d = displays[id];
      if (d.connected && d.lastSeen && now - d.lastSeen > config.heartbeatTimeoutMs) {
        d.connected = false;
        changed = true;
        if (typeof onCloseDisplaySocket === 'function') {
          onCloseDisplaySocket(id);
        }
      }
    }
    if (changed) {
      recomputeState();
      if (state === STATES.PLAYING && playback) {
        const anyConnectedPlaying = [...playback.startedDisplays].some(
          (dispId) => displays[dispId]?.connected
        );
        if (!anyConnectedPlaying) {
          enterCooldown('stop');
          return;
        }
        checkPlaybackCompletion();
      }
      emitStatus();
    }
  }

  const heartbeatInterval = setInterval(() => {
    checkHeartbeats();
  }, 2000);
  if (typeof heartbeatInterval.unref === 'function') {
    heartbeatInterval.unref();
  }

  function destroy() {
    clearInterval(heartbeatInterval);
    clearPlaybackTimers();
    clearCooldownTimer();
  }

  recomputeState();

  return {
    STATES,
    getState: () => state,
    getActiveVideo: () => activeVideo,
    getSnapshot,
    getActiveVideoMessage,
    setControlConnected,
    connectDisplay,
    disconnectDisplay,
    touchHeartbeat,
    updateDisplayState,
    updateDisplayPos,
    handleDisplayEnded,
    requestPlay,
    requestStop,
    sendMessage,
    activateVideo,
    setUploading,
    setRequiredDisplays,
    setAudioOffsets,
    triggerResync,
    checkHeartbeats,
    destroy
  };
}

module.exports = {
  STATES,
  createStateMachine
};
