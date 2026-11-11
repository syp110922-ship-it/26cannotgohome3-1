'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

function createMockElement(id = '') {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    tagName: 'DIV',
    value: '',
    textContent: '',
    src: '',
    muted: false,
    readyState: 4,
    duration: 10,
    currentTime: 0,
    offsetWidth: 100,
    dataset: {},
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
      contains: (name) => classes.has(name)
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((f) => f !== fn));
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn({ target: this, preventDefault: () => {}, ...event });
      }
    },
    focus() {},
    load() {},
    pause() {
      this._paused = true;
    },
    play() {
      this._played = true;
      return Promise.resolve();
    },
    removeAttribute(attr) {
      if (attr === 'src') this.src = '';
    }
  };
}

function createDomSandbox({ search = '?id=A', origin = 'https://booth.netlify.app', fetchImpl } = {}) {
  const storage = new Map();
  const elements = new Map();
  const activeTimeouts = new Set();
  const activeIntervals = new Set();

  const ids = [
    'player',
    'msg-overlay',
    'admin-corner',
    'setup-screen',
    'device-title',
    'switch-A',
    'switch-B',
    'pin-row',
    'display-pin',
    'setup-error',
    'start-btn',
    'setup-corner-gear-btn',
    'display-server-modal',
    'display-server-close',
    'setup-server-current',
    'server-url-input',
    'display-server-error',
    'reset-server-btn',
    'save-server-btn',
    'corner-pin-modal',
    'corner-pin-form',
    'corner-pin-input',
    'corner-pin-error',
    'corner-pin-cancel',
    'corner-info-modal',
    'info-pane-status',
    'info-pane-server',
    'info-device-id',
    'info-ws-status',
    'info-clock-sync',
    'info-device-locks',
    'info-video-state',
    'info-fullscreen-btn',
    'info-reconnect-btn',
    'info-reset-token-btn',
    'info-close-btn',
    'info-server-url',
    'info-ws-url',
    'info-server-input',
    'info-server-error',
    'info-server-reset-btn',
    'info-server-save-btn'
  ];

  const hiddenByDefault = new Set([
    'pin-row',
    'display-server-modal',
    'corner-pin-modal',
    'corner-info-modal',
    'info-pane-server',
    'msg-overlay'
  ]);

  for (const id of ids) {
    const el = createMockElement(id);
    if (hiddenByDefault.has(id)) {
      el.classList.add('hidden');
    }
    elements.set(id, el);
  }

  const infoTabStatus = createMockElement('info-tab-status');
  infoTabStatus.dataset.infoTab = 'status';
  infoTabStatus.classList.add('active');
  const infoTabServer = createMockElement('info-tab-server');
  infoTabServer.dataset.infoTab = 'server';

  const createdSockets = [];
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this._listeners = new Map();
      createdSockets.push(this);
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this._emit('close', { code, reason });
    }
    _emitOpen() {
      this.readyState = 1;
      this._emit('open', {});
    }
    _emitMessage(obj) {
      this._emit('message', { data: JSON.stringify(obj) });
    }
    _emit(type, ev) {
      for (const fn of this._listeners.get(type) || []) fn(ev);
    }
  }

  const trackedSetTimeout = (fn, ms, ...args) => {
    const id = setTimeout(() => {
      activeTimeouts.delete(id);
      fn(...args);
    }, ms);
    activeTimeouts.add(id);
    return id;
  };
  const trackedClearTimeout = (id) => {
    activeTimeouts.delete(id);
    clearTimeout(id);
  };
  const trackedSetInterval = (fn, ms, ...args) => {
    const id = setInterval(fn, ms, ...args);
    activeIntervals.add(id);
    return id;
  };
  const trackedClearInterval = (id) => {
    activeIntervals.delete(id);
    clearInterval(id);
  };

  const docListeners = new Map();
  const winListeners = new Map();

  const context = vm.createContext({
    location: {
      origin,
      protocol: new URL(origin).protocol,
      hostname: new URL(origin).hostname,
      search,
      reload: () => {}
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    addEventListener: (t, fn) => {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push(fn);
    },
    removeEventListener: (t, fn) => {
      const list = winListeners.get(t) || [];
      winListeners.set(t, list.filter((f) => f !== fn));
    },
    URL,
    URLSearchParams,
    WebSocket: MockWebSocket,
    Audio: class {
      play() {
        return Promise.resolve();
      }
    },
    AudioContext: class {
      constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.destination = {};
      }
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        return { connect() {}, start() {}, stop() {} };
      }
      createGain() {
        return { gain: { value: 0 }, connect() {} };
      }
    },
    fetch: fetchImpl || (async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) })),
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    requestAnimationFrame: (cb) => trackedSetTimeout(cb, 1),
    cancelAnimationFrame: (id) => trackedClearTimeout(id),
    navigator: {
      wakeLock: {
        request: async () => ({ addEventListener() {}, release: async () => {} })
      }
    },
    document: {
      title: '',
      visibilityState: 'visible',
      fullscreenElement: null,
      documentElement: {
        requestFullscreen: async () => {}
      },
      getElementById: (id) => elements.get(id),
      querySelectorAll: (sel) => (sel === '.info-tab-btn' ? [infoTabStatus, infoTabServer] : []),
      addEventListener: (t, fn) => {
        if (!docListeners.has(t)) docListeners.set(t, []);
        docListeners.get(t).push(fn);
      }
    },
    console
  });

  vm.runInContext('this.window = this;', context);

  function cleanup() {
    for (const id of activeTimeouts) clearTimeout(id);
    for (const id of activeIntervals) clearInterval(id);
    activeTimeouts.clear();
    activeIntervals.clear();
  }

  return {
    context,
    elements,
    infoTabs: { status: infoTabStatus, server: infoTabServer },
    storage,
    createdSockets,
    cleanup
  };
}

describe('frontend config, ws-client, and display Phase 2', () => {
  it('validates server origins strictly and rejects unsafe query schemes', () => {
    const { context, storage, cleanup } = createDomSandbox({
      search: '?id=A&server=javascript:alert(1)',
      origin: 'https://booth.netlify.app'
    });
    try {
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'config.js'), 'utf8'), context);

      assert.equal(context.GHOST_CONFIG.apiBase, 'https://booth.netlify.app');
      assert.equal(storage.has('ghost_server_origin'), false);
      assert.equal(context.GHOST_CONFIG.validateOrigin('http://evil.example.com'), null);
      assert.equal(context.GHOST_CONFIG.validateOrigin('http://192.168.0.10:3000'), null);
      assert.equal(
        context.GHOST_CONFIG.validateOrigin('https://ghost.duckdns.org/path'),
        'https://ghost.duckdns.org'
      );
      assert.equal(context.GHOST_CONFIG.validateOrigin('http://localhost:3000'), 'http://localhost:3000');
    } finally {
      cleanup();
    }
  });

  it('allows private LAN http origin only when page itself is http', () => {
    const { context, cleanup } = createDomSandbox({
      origin: 'http://192.168.0.10:3000'
    });
    try {
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'config.js'), 'utf8'), context);
      assert.equal(
        context.GHOST_CONFIG.validateOrigin('http://192.168.0.25:3000'),
        'http://192.168.0.25:3000'
      );
      assert.equal(context.GHOST_CONFIG.validateOrigin('http://8.8.8.8:3000'), null);
    } finally {
      cleanup();
    }
  });

  it('stops reconnect loop on 401/403 from /auth/verify after repeated handshake failures', async () => {
    const { context, createdSockets, cleanup } = createDomSandbox({
      fetchImpl: async () => ({ ok: false, status: 401 })
    });
    try {
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'config.js'), 'utf8'), context);
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'shared/ws-client.js'), 'utf8'), context);

      let authErrorCount = 0;
      const client = context.GhostWsClient.createSyncClient({
        wsBaseUrl: 'wss://booth.netlify.app/ws',
        apiBase: 'https://booth.netlify.app',
        role: 'display',
        id: 'A',
        getToken: () => 'revoked-token',
        onAuthError: () => {
          authErrorCount += 1;
        }
      });

      client.connect();
      assert.equal(createdSockets.length, 1);
      createdSockets[0].close(1006, 'handshake_rejected');

      await new Promise((r) => setTimeout(r, 600));
      assert.equal(createdSockets.length, 2);
      createdSockets[1].close(1006, 'handshake_rejected');

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(authErrorCount, 1);
      client.disconnect();
    } finally {
      cleanup();
    }
  });

  it('runs Phase 2 display playback, corner gear server modal, and 5s corner admin 서버 관리 tab', async () => {
    const { context, elements, infoTabs, storage, createdSockets, cleanup } = createDomSandbox({
      search: '?id=B',
      origin: 'http://localhost:3000',
      fetchImpl: async (url, opts) => {
        if (url.endsWith('/auth/verify')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, scope: 'display', deviceId: 'B' }) };
        }
        if (url.endsWith('/auth')) {
          const body = JSON.parse(opts.body);
          if (
            (body.pin === 'admincgo2631' || body.pin === 'adminsetmg') &&
            body.scope === 'diagnostics'
          ) {
            return { ok: true, status: 200, json: async () => ({ ok: true, token: 'tok-diag', scope: 'diagnostics' }) };
          }
          return { ok: false, status: 401, json: async () => ({ ok: false, error: 'invalid_pin' }) };
        }
        return { ok: false, status: 404 };
      }
    });

    try {
      storage.set('ghost_display_token_B', 'valid-token-B');

      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'config.js'), 'utf8'), context);
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'shared/ws-client.js'), 'utf8'), context);
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'display.js'), 'utf8'), context);

      // Corner gear opens pre-start Server Management modal cleanly
      assert.equal(elements.get('display-server-modal').classList.contains('hidden'), true);
      elements.get('setup-corner-gear-btn').dispatch('click');
      assert.equal(elements.get('display-server-modal').classList.contains('hidden'), false);
      assert.equal(elements.get('setup-server-current').textContent, 'http://localhost:3000');
      elements.get('display-server-close').dispatch('click');
      assert.equal(elements.get('display-server-modal').classList.contains('hidden'), true);

      // Tap start button -> hides setup screen and opens WS
      elements.get('start-btn').dispatch('click');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(elements.get('setup-screen').classList.contains('hidden'), true);
      assert.equal(createdSockets.length, 1);
      const ws = createdSockets[0];
      ws._emitOpen();

      // Load a mock playable blob source & trigger ready event
      context.__GHOST_DISPLAY_API__.attachPlayableUrl('vid-demo', 'blob:mock-1');
      elements.get('player').dispatch('loadeddata');
      const stateMsgs = ws.sent.filter((m) => m.t === 'state');
      assert.ok(stateMsgs.some((m) => m.cached.includes('vid-demo') && m.dl === 100));

      // Scheduled play
      ws._emitMessage({ t: 'play', videoId: 'vid-demo', startAt: Date.now() + 35 });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(context.__GHOST_DISPLAY_API__.getState().isPlaying, true);
      assert.equal(elements.get('player').classList.contains('playing-visible'), true);

      // Immediate stop returns to pure black standby
      ws._emitMessage({ t: 'stop' });
      assert.equal(context.__GHOST_DISPLAY_API__.getState().isPlaying, false);
      assert.equal(elements.get('player').classList.contains('playing-visible'), false);

      // Play again and finish via ended event
      ws._emitMessage({ t: 'play', videoId: 'vid-demo', startAt: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
      elements.get('player').dispatch('ended');
      assert.equal(ws.sent.some((m) => m.t === 'ended' && m.videoId === 'vid-demo'), true);
      assert.equal(elements.get('player').classList.contains('playing-visible'), false);

      // Message overlay sets plain textContent (no HTML injection)
      ws._emitMessage({ t: 'msg', text: '<img src=x onerror=alert(1)> 퇴장해 주세요', ms: 1500 });
      assert.equal(elements.get('msg-overlay').textContent, '<img src=x onerror=alert(1)> 퇴장해 주세요');
      assert.equal(elements.get('msg-overlay').classList.contains('hidden'), false);

      // Corner hold < 5s does NOT open PIN prompt
      const corner = elements.get('admin-corner');
      corner.dispatch('pointerdown', { clientX: 10, clientY: 10 });
      await new Promise((r) => setTimeout(r, 40));
      corner.dispatch('pointerup', { clientX: 10, clientY: 10 });
      assert.equal(elements.get('corner-pin-modal').classList.contains('hidden'), true);

      // Experiencer PIN rejected for 5s corner admin gate; staff PIN opens diagnostics & 서버 관리 tab
      elements.get('corner-pin-modal').classList.remove('hidden');
      elements.get('corner-pin-input').value = 'cgo2631';
      elements.get('corner-pin-form').dispatch('submit');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(elements.get('corner-info-modal').classList.contains('hidden'), true);
      assert.ok(elements.get('corner-pin-error').textContent.length > 0);

      elements.get('corner-pin-input').value = 'admincgo2631';
      elements.get('corner-pin-form').dispatch('submit');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(elements.get('corner-info-modal').classList.contains('hidden'), false);
      assert.equal(elements.get('info-device-id').textContent, 'B');
      assert.equal(elements.get('info-pane-server').classList.contains('hidden'), true);

      // Switching to 서버 관리 tab exposes server URL inside modal
      infoTabs.server.dispatch('click');
      assert.equal(elements.get('info-pane-server').classList.contains('hidden'), false);
      assert.equal(elements.get('info-server-url').textContent, 'http://localhost:3000');
    } finally {
      cleanup();
    }
  });
});
