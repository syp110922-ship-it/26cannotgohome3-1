'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

function createMockElement(id = '', tagName = 'DIV') {
  const listeners = new Map();
  const classes = new Set();
  const children = [];
  const el = {
    id,
    tagName,
    value: '',
    textContent: '',
    disabled: false,
    dataset: {},
    style: {},
    children,
    className: '',
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
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 276, bottom: 276, width: 176, height: 176 }),
    appendChild(child) {
      children.push(child);
      return child;
    },
    remove() {},
    querySelectorAll: (sel) => {
      if (sel === 'input') {
        const res = [];
        const walk = (node) => {
          for (const c of node.children || []) {
            if (c.tagName === 'INPUT') res.push(c);
            walk(c);
          }
        };
        walk(el);
        return res;
      }
      return [];
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn({ target: this, preventDefault: () => {}, pointerId: 1, pointerType: 'touch', clientX: 188, clientY: 188, ...event });
      }
    },
    focus() {}
  };
  return el;
}

function createControlSandbox({ fetchImpl } = {}) {
  const local = new Map();
  const session = new Map();
  const elements = new Map();
  const activeTimeouts = new Set();
  const activeIntervals = new Set();

  const ids = [
    'dot-wrap-A', 'dot-wrap-B', 'dot-A', 'dot-B', 'dl-A', 'dl-B', 'conn-pill',
    'settings-btn', 'settings-ring', 'play-btn', 'play-ring', 'play-icon', 'cooldown-label',
    'timeline-fill', 'timeline-thumb', 'time-text', 'toast',
    'msg-btn', 'msg-sheet-backdrop', 'msg-sheet-close', 'msg-select-step', 'msg-confirm-step',
    'preset-grid', 'custom-msg-form', 'custom-msg-input', 'msg-confirm-preview', 'msg-cancel-btn', 'msg-send-btn',
    'auth-modal', 'auth-form', 'auth-title', 'auth-desc', 'pin-input',
    'auth-error', 'auth-cancel-btn', 'auth-corner-gear-btn',
    'control-server-modal', 'control-server-close', 'preauth-server-current', 'control-server-input',
    'control-server-error', 'control-reset-server-btn', 'control-save-server-btn',
    'settings-modal', 'settings-close-btn', 'fullscreen-btn', 'admin-logout-btn',
    'tab-devices', 'tab-videos', 'tab-presets', 'tab-pin', 'tab-server',
    'device-detail-grid', 'required-displays-select', 'offset-A-input', 'offset-B-input',
    'save-device-config-btn', 'resync-btn', 'disk-free-label', 'video-list-container',
    'preset-editor-list', 'add-preset-btn', 'save-presets-btn',
    'change-pin-form', 'current-pin-input', 'new-admin-pin-input', 'new-display-pin-input',
    'new-settings-pin-input', 'change-pin-error',
    'settings-server-api', 'settings-server-ws', 'settings-server-input',
    'settings-server-error', 'settings-reset-server-btn', 'settings-save-server-btn'
  ];

  const hiddenByDefault = new Set([
    'dl-A', 'dl-B', 'conn-pill', 'cooldown-label', 'toast',
    'msg-sheet-backdrop', 'msg-confirm-step', 'auth-modal', 'auth-cancel-btn',
    'control-server-modal', 'settings-modal',
    'tab-videos', 'tab-presets', 'tab-pin', 'tab-server'
  ]);

  for (const id of ids) {
    const el = createMockElement(id);
    if (hiddenByDefault.has(id)) el.classList.add('hidden');
    elements.set(id, el);
  }

  const tabBtns = ['devices', 'videos', 'presets', 'pin', 'server'].map((t) => {
    const btn = createMockElement(`tab-btn-${t}`, 'BUTTON');
    btn.dataset.tab = t;
    if (t === 'devices') btn.classList.add('active');
    return btn;
  });
  const tabPanes = ['devices', 'videos', 'presets', 'pin', 'server'].map((t) => elements.get(`tab-${t}`));

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

  const vibrateCalls = [];
  let fakePerfOffset = 0;

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

  const context = vm.createContext({
    location: {
      origin: 'http://localhost:3000',
      protocol: 'http:',
      hostname: 'localhost',
      search: '',
      reload: () => {}
    },
    localStorage: {
      getItem: (k) => (local.has(k) ? local.get(k) : null),
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: (k) => local.delete(k)
    },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: (k) => session.delete(k)
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    URL,
    URLSearchParams,
    WebSocket: MockWebSocket,
    performance: {
      now: () => Date.now() + fakePerfOffset
    },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    requestAnimationFrame: (cb) => trackedSetTimeout(() => cb(Date.now() + fakePerfOffset), 10),
    cancelAnimationFrame: (id) => trackedClearTimeout(id),
    navigator: {
      vibrate: (p) => vibrateCalls.push(p),
      wakeLock: {
        request: async () => ({ addEventListener() {}, release: async () => {} })
      }
    },
    screen: {
      orientation: { lock: async () => {} }
    },
    document: {
      visibilityState: 'visible',
      fullscreenElement: null,
      documentElement: { requestFullscreen: async () => {} },
      getElementById: (id) => elements.get(id),
      createElement: (tag) => createMockElement('', tag.toUpperCase()),
      querySelectorAll: (sel) => {
        if (sel === '.tab-btn') return tabBtns;
        if (sel === '.tab-pane') return tabPanes;
        return [];
      },
      addEventListener: () => {}
    },
    console
  });
  vm.runInContext('this.window = this;', context);

  return {
    context,
    elements,
    tabBtns,
    local,
    session,
    createdSockets,
    vibrateCalls,
    advancePerf: (ms) => {
      fakePerfOffset += ms;
    },
    cleanup: () => {
      for (const id of activeTimeouts) clearTimeout(id);
      for (const id of activeIntervals) clearInterval(id);
      activeTimeouts.clear();
      activeIntervals.clear();
    }
  };
}

describe('frontend control Phase 3', () => {
  it('ignores short taps and sends play/stop only after 0.6s / 1.0s continuous long-press', async () => {
    const { context, elements, local, createdSockets, vibrateCalls, advancePerf, cleanup } =
      createControlSandbox({
        fetchImpl: async (url) => {
          if (url.endsWith('/auth/verify')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, scope: 'control' }) };
          }
          if (url.endsWith('/presets')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, presets: ['곧 시작합니다', '퇴장해 주세요'] }) };
          }
          return { ok: false, status: 404 };
        }
      });

    try {
      local.set('ghost_control_token', 'ctrl-tok-1');
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'config.js'), 'utf8'), context);
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'shared/ws-client.js'), 'utf8'), context);
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'control.js'), 'utf8'), context);

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(createdSockets.length, 1);
      const ws = createdSockets[0];
      ws._emitOpen();

      // Server reports READY with 150s video
      ws._emitMessage({
        t: 'status',
        state: 'READY',
        requiredDisplays: ['A', 'B'],
        video: { id: 'v1', filename: 'haunt.mp4', duration: 150, size: 1024 },
        playback: null,
        displays: {
          A: { id: 'A', connected: true, ready: true, dot: 'green', dl: 100 },
          B: { id: 'B', connected: true, ready: true, dot: 'green', dl: 100 }
        }
      });

      const playBtn = elements.get('play-btn');
      const playIcon = elements.get('play-icon');
      assert.equal(playBtn.disabled, false);
      assert.equal(playBtn.classList.contains('ready'), true);
      assert.equal(playIcon.src, './assets/play-ready.webp');
      assert.equal(elements.get('time-text').textContent, '0:00 / 2:30');

      // Short tap (<600ms) -> NO play sent
      playBtn.dispatch('pointerdown', { pointerId: 1 });
      advancePerf(250);
      await new Promise((r) => setTimeout(r, 20));
      playBtn.dispatch('pointerup', { pointerId: 1 });
      assert.equal(ws.sent.filter((m) => m.t === 'play').length, 0);

      // Hold interrupted by state transition to NOT_READY -> cancelled cleanly
      playBtn.dispatch('pointerdown', { pointerId: 2 });
      advancePerf(300);
      ws._emitMessage({
        t: 'status',
        state: 'NOT_READY',
        requiredDisplays: ['A', 'B'],
        video: { id: 'v1', duration: 150 },
        displays: {
          A: { id: 'A', connected: true, dot: 'green', dl: 100 },
          B: { id: 'B', connected: false, dot: 'red', dl: 0 }
        }
      });
      advancePerf(400);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(ws.sent.filter((m) => m.t === 'play').length, 0);

      // Restore READY and hold full 600ms -> sends play + vibrates
      ws._emitMessage({
        t: 'status',
        state: 'READY',
        requiredDisplays: ['A', 'B'],
        video: { id: 'v1', duration: 150 },
        displays: {
          A: { id: 'A', connected: true, ready: true, dot: 'green', dl: 100 },
          B: { id: 'B', connected: true, ready: true, dot: 'green', dl: 100 }
        }
      });
      playBtn.dispatch('pointerdown', { pointerId: 3 });
      advancePerf(620);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(ws.sent.filter((m) => m.t === 'play').length, 1);
      assert.equal(vibrateCalls.length, 1);

      // Switch to PLAYING: <1000ms tap ignored, >=1000ms sends stop
      ws._emitMessage({
        t: 'status',
        state: 'PLAYING',
        requiredDisplays: ['A', 'B'],
        video: { id: 'v1', duration: 150 },
        playback: { videoId: 'v1', startAt: Date.now() - 10000, pos: 10 },
        displays: {
          A: { id: 'A', connected: true, ready: true, dot: 'green', dl: 100 },
          B: { id: 'B', connected: true, ready: true, dot: 'green', dl: 100 }
        }
      });
      assert.equal(playBtn.classList.contains('playing'), true);
      assert.equal(playIcon.src, './assets/play-playing.webp');

      playBtn.dispatch('pointerdown', { pointerId: 4 });
      advancePerf(700);
      await new Promise((r) => setTimeout(r, 20));
      playBtn.dispatch('pointerup', { pointerId: 4 });
      assert.equal(ws.sent.filter((m) => m.t === 'stop').length, 0);

      playBtn.dispatch('pointerdown', { pointerId: 5 });
      advancePerf(1050);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(ws.sent.filter((m) => m.t === 'stop').length, 1);
    } finally {
      cleanup();
    }
  });

  it('supports pre-auth corner gear server modal, message sheet, and 3s gear hold + 서버 관리 tab', async () => {
    const { context, elements, tabBtns, local, session, createdSockets, advancePerf, cleanup } =
      createControlSandbox({
        fetchImpl: async (url, opts = {}) => {
          if (url.endsWith('/auth/verify')) {
            const auth = opts.headers?.Authorization || '';
            const scope = auth.includes('adm') ? 'admin' : 'control';
            return { ok: true, status: 200, json: async () => ({ ok: true, scope }) };
          }
          if (url.endsWith('/auth')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, token: 'adm-tok-1', scope: 'admin' }) };
          }
          if (url.endsWith('/presets')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, presets: ['잠시 후 입장'] }) };
          }
          if (url.endsWith('/settings/pin') && opts.method === 'PUT') {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                token: 'adm-tok-rotated',
                controlToken: 'ctrl-tok-rotated'
              })
            };
          }
          if (url.endsWith('/settings')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                presets: ['잠시 후 입장'],
                requiredDisplays: ['A', 'B'],
                audioOffsets: { A: 0, B: 0 }
              })
            };
          }
          if (url.endsWith('/videos')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, videos: [], diskFreeBytes: 1024 * 1024 * 1024 }) };
          }
          if (url.endsWith('/status')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                state: 'NOT_READY',
                requiredDisplays: ['A', 'B'],
                displays: { A: { id: 'A', connected: false }, B: { id: 'B', connected: false } }
              })
            };
          }
          return { ok: false, status: 404 };
        }
      });

    try {
      // Unregistered state opens control PIN modal and hides server URL behind corner gear
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'config.js'), 'utf8'), context);
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'shared/ws-client.js'), 'utf8'), context);
      vm.runInContext(fs.readFileSync(path.join(FRONTEND_DIR, 'control.js'), 'utf8'), context);

      assert.equal(elements.get('auth-modal').classList.contains('hidden'), false);
      assert.equal(elements.get('auth-corner-gear-btn').classList.contains('hidden'), false);
      assert.equal(elements.get('control-server-modal').classList.contains('hidden'), true);

      elements.get('auth-corner-gear-btn').dispatch('click');
      assert.equal(elements.get('control-server-modal').classList.contains('hidden'), false);
      assert.equal(elements.get('preauth-server-current').textContent, 'http://localhost:3000');
      elements.get('control-server-close').dispatch('click');
      assert.equal(elements.get('control-server-modal').classList.contains('hidden'), true);

      // Register control device with admin login PIN
      elements.get('pin-input').value = 'admincgo2631';
      elements.get('auth-form').dispatch('submit');
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(local.get('ghost_control_token'));

      const ws = createdSockets[0];
      ws._emitOpen();
      await new Promise((r) => setTimeout(r, 20));

      // Open message sheet -> choose preset -> confirm -> send
      elements.get('msg-btn').dispatch('click');
      assert.equal(elements.get('msg-sheet-backdrop').classList.contains('hidden'), false);
      const presetBtn = elements.get('preset-grid').children[0];
      assert.equal(presetBtn.textContent, '잠시 후 입장');
      presetBtn.dispatch('click');
      assert.equal(elements.get('msg-confirm-step').classList.contains('hidden'), false);
      assert.equal(elements.get('msg-confirm-preview').textContent, '잠시 후 입장');

      elements.get('msg-send-btn').dispatch('click');
      assert.equal(ws.sent.filter((m) => m.t === 'msg').length, 1);

      // Re-open immediately and attempt duplicate message within 2s -> blocked client-side
      elements.get('msg-btn').dispatch('click');
      elements.get('preset-grid').children[0].dispatch('click');
      elements.get('msg-send-btn').dispatch('click');
      assert.equal(ws.sent.filter((m) => m.t === 'msg').length, 1);

      // Gear short tap (<3s) does NOT open auth modal
      const gearBtn = elements.get('settings-btn');
      gearBtn.dispatch('pointerdown', { pointerId: 10, clientX: 188, clientY: 188 });
      advancePerf(1000);
      await new Promise((r) => setTimeout(r, 20));
      gearBtn.dispatch('pointerup', { pointerId: 10, clientX: 188, clientY: 188 });
      assert.equal(elements.get('auth-modal').classList.contains('hidden'), true);

      // Gear 3s continuous hold -> opens admin PIN modal (corner gear hidden during admin check)
      gearBtn.dispatch('pointerdown', { pointerId: 11, clientX: 188, clientY: 188 });
      advancePerf(3050);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(elements.get('auth-modal').classList.contains('hidden'), false);
      assert.equal(elements.get('auth-corner-gear-btn').classList.contains('hidden'), true);

      elements.get('pin-input').value = 'adminsetmg';
      elements.get('auth-form').dispatch('submit');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(session.get('ghost_admin_token'), 'adm-tok-1');
      assert.equal(elements.get('settings-modal').classList.contains('hidden'), false);

      // Rotating PIN inside Settings keeps Settings open without forcing re-login
      elements.get('current-pin-input').value = 'adminsetmg';
      elements.get('new-settings-pin-input').value = 'adminsetmg2';
      elements.get('change-pin-form').dispatch('submit');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(elements.get('settings-modal').classList.contains('hidden'), false);
      assert.equal(elements.get('auth-modal').classList.contains('hidden'), true);
      assert.equal(session.get('ghost_admin_token'), 'adm-tok-rotated');
      assert.equal(local.get('ghost_control_token'), 'ctrl-tok-rotated');

      // Switching to 서버 관리 tab inside Settings exposes server API & WS URLs
      const serverTab = tabBtns.find((b) => b.dataset.tab === 'server');
      serverTab.dispatch('click');
      assert.equal(elements.get('tab-server').classList.contains('hidden'), false);
      assert.equal(elements.get('settings-server-api').textContent, 'http://localhost:3000');
      assert.equal(elements.get('settings-server-ws').textContent, 'ws://localhost:3000/ws');

      // Leaving Settings clears the settings session token so next entry requires Settings PIN
      elements.get('settings-close-btn').dispatch('click');
      assert.equal(elements.get('settings-modal').classList.contains('hidden'), true);
      assert.equal(session.get('ghost_admin_token'), undefined);
    } finally {
      cleanup();
    }
  });
});
