'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createApp } = require('../src/index');

function connectWs(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const queue = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (waiters.length > 0) {
        const next = waiters.shift();
        next(msg);
      } else {
        queue.push(msg);
      }
    });

    ws.nextMessage = (predicate = () => true, timeoutMs = 2000) => {
      const idx = queue.findIndex(predicate);
      if (idx >= 0) {
        return Promise.resolve(queue.splice(idx, 1)[0]);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('WS message timeout')), timeoutMs);
        const onMsg = (msg) => {
          if (predicate(msg)) {
            clearTimeout(timer);
            res(msg);
          } else {
            queue.push(msg);
            waiters.push(onMsg);
          }
        };
        waiters.push(onMsg);
      });
    };

    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`Unexpected HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
    });
    ws.once('error', reject);
  });
}

describe('HTTP & WebSocket server integration', () => {
  let tmpDir;
  let app;
  let baseUrl;
  let wsBaseUrl;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-int-'));
    app = createApp({
      host: '127.0.0.1',
      port: 0,
      dataDir: tmpDir,
      videosDir: path.join(tmpDir, 'videos'),
      dbPath: path.join(tmpDir, 'app.db'),
      initialPin: '2468',
      allowedOrigins: ['https://ghost-booth.netlify.app'],
      cooldownMs: 60,
      playScheduleLeadMs: 40,
      pinLockoutMs: 5000
    });
    const addr = await app.start();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    wsBaseUrl = `ws://127.0.0.1:${addr.port}/ws`;
  });

  afterEach(async () => {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves health, enforces PIN lockout, and revokes old tokens on PIN change', async () => {
    const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.state, 'NOT_READY');

    // 5 failed attempts trigger 429 lockout
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '0000', scope: 'admin' })
      });
      assert.equal(r.status, 401);
    }
    const locked = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000', scope: 'admin' })
    });
    assert.equal(locked.status, 429);

    // Reset guard to test valid login & PIN change
    app.pinGuard.recordSuccess();
    const authRes = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '2468', scope: 'admin' })
    });
    const authJson = await authRes.json();
    assert.equal(authRes.status, 200);
    assert.equal(authJson.ok, true);

    const changeRes = await fetch(`${baseUrl}/settings/pin`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authJson.token}`
      },
      body: JSON.stringify({ currentPin: '2468', newPin: '5678' })
    });
    const changeJson = await changeRes.json();
    assert.equal(changeRes.status, 200);
    assert.ok(changeJson.token);

    // Old token must now be revoked
    const oldVerify = await fetch(`${baseUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${authJson.token}` }
    });
    assert.equal(oldVerify.status, 401);

    // Non-JSON Content-Type on POST /auth rejected with 415
    const badCt = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'pin=5678'
    });
    assert.equal(badCt.status, 415);

    // Disallowed Origin on POST /auth rejected with 403
    const badOrigin = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example.com'
      },
      body: JSON.stringify({ pin: '5678', scope: 'admin' })
    });
    assert.equal(badOrigin.status, 403);

    // Oversized PIN rejected with 400
    const longPin = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1'.repeat(65), scope: 'admin' })
    });
    assert.equal(longPin.status, 400);

    // Security headers on static HTML
    const htmlRes = await fetch(`${baseUrl}/display.html?id=A`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(htmlRes.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(htmlRes.headers.get('content-security-policy').includes("script-src 'self'"));
  });

  it('disconnects active WebSocket clients when PIN is changed and enforces lockout on PUT /settings/pin', async () => {
    const adminRes = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '2468', scope: 'admin' })
    }).then((r) => r.json());

    const ctrlRes = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '2468', scope: 'control' })
    }).then((r) => r.json());

    const wsCtrl = await connectWs(
      `${wsBaseUrl}?role=control&token=${encodeURIComponent(ctrlRes.token)}`,
      { Origin: 'https://ghost-booth.netlify.app' }
    );
    await wsCtrl.nextMessage((m) => m.t === 'status');

    const closePromise = new Promise((resolve) => {
      wsCtrl.once('close', (code) => resolve(code));
    });

    // Change PIN -> active control WS must be closed with 4003
    const changed = await fetch(`${baseUrl}/settings/pin`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminRes.token}`
      },
      body: JSON.stringify({ currentPin: '2468', newPin: '9999' })
    });
    const changedJson = await changed.json();
    assert.equal(changed.status, 200);

    const closeCode = await closePromise;
    assert.equal(closeCode, 4003);
    assert.ok(changedJson.controlToken);

    // New controlToken works immediately for control WS reconnect
    const wsCtrl2 = await connectWs(
      `${wsBaseUrl}?role=control&token=${encodeURIComponent(changedJson.controlToken)}`,
      { Origin: 'https://ghost-booth.netlify.app' }
    );
    const snap2 = await wsCtrl2.nextMessage((m) => m.t === 'status');
    assert.equal(snap2.state, 'NOT_READY');
    wsCtrl2.close();

    // Settings validation: empty presets -> 400, NaN audio offset sanitized -> 0
    const badPresets = await fetch(`${baseUrl}/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${changedJson.token}`
      },
      body: JSON.stringify({ presets: ['   '] })
    });
    assert.equal(badPresets.status, 400);

    const safeOffsets = await fetch(`${baseUrl}/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${changedJson.token}`
      },
      body: JSON.stringify({ audioOffsets: { A: 'not-a-number', B: 9999 } })
    }).then((r) => r.json());
    assert.deepEqual(safeOffsets.audioOffsets, { A: 0, B: 2000 });

    // 5 failed currentPin attempts on PUT /settings/pin trigger 429 lockout
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${baseUrl}/settings/pin`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${changedJson.token}`
        },
        body: JSON.stringify({ currentPin: '0000', newPin: '1111' })
      });
      assert.equal(r.status, 401);
    }
    const locked = await fetch(`${baseUrl}/settings/pin`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${changedJson.token}`
      },
      body: JSON.stringify({ currentPin: '0000', newPin: '1111' })
    });
    assert.equal(locked.status, 429);
  });

  it('enforces WS origin, token scope, display role restrictions, and full play cycle', async () => {
    const getToken = async (scope, deviceId) => {
      const res = await fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '2468', scope, deviceId })
      });
      const json = await res.json();
      return json.token;
    };

    const controlToken = await getToken('control');
    const tokenA = await getToken('display', 'A');
    const tokenB = await getToken('display', 'B');

    // Disallowed origin fails with 403
    await assert.rejects(
      () =>
        connectWs(`${wsBaseUrl}?role=control&token=${encodeURIComponent(controlToken)}`, {
          Origin: 'https://evil.example.com'
        }),
      (err) => err.statusCode === 403
    );

    // Display A token cannot connect as Display B
    await assert.rejects(
      () =>
        connectWs(`${wsBaseUrl}?role=display&id=B&token=${encodeURIComponent(tokenA)}`, {
          Origin: 'https://ghost-booth.netlify.app'
        }),
      (err) => err.statusCode === 403
    );

    // Seed active video metadata in DB
    app.db.insertVideo({
      id: 'demo-1',
      filename: 'demo.mp4',
      size: 12345,
      duration: 2,
      sha256: 'deadbeef',
      active: true
    });
    app.stateMachine.activateVideo('demo-1');

    const headers = { Origin: 'https://ghost-booth.netlify.app' };
    const wsControl = await connectWs(
      `${wsBaseUrl}?role=control&token=${encodeURIComponent(controlToken)}`,
      headers
    );
    const initialStatus = await wsControl.nextMessage((m) => m.t === 'status');
    assert.equal(initialStatus.state, 'NOT_READY');

    const wsA = await connectWs(
      `${wsBaseUrl}?role=display&id=A&token=${encodeURIComponent(tokenA)}`,
      headers
    );
    const wsB = await connectWs(
      `${wsBaseUrl}?role=display&id=B&token=${encodeURIComponent(tokenB)}`,
      headers
    );

    // Displays receive active video command on connect
    const vidA = await wsA.nextMessage((m) => m.t === 'video');
    assert.equal(vidA.videoId, 'demo-1');

    // Display cannot send control commands
    wsA.send(JSON.stringify({ t: 'play' }));
    const errMsg = await wsA.nextMessage((m) => m.t === 'error');
    assert.equal(errMsg.error, 'forbidden_for_display');

    // Clock sync ping/pong
    wsA.send(JSON.stringify({ t: 'ping', cTime: 123456 }));
    const pong = await wsA.nextMessage((m) => m.t === 'pong');
    assert.equal(pong.cTime, 123456);
    assert.equal(typeof pong.sTime, 'number');

    // Both displays report cached -> READY
    wsA.send(JSON.stringify({ t: 'state', id: 'A', cached: ['demo-1'], dl: 100 }));
    wsB.send(JSON.stringify({ t: 'state', id: 'B', cached: ['demo-1'], dl: 100 }));
    const readyStatus = await wsControl.nextMessage(
      (m) => m.t === 'status' && m.state === 'READY'
    );
    assert.equal(readyStatus.displays.A.dot, 'green');
    assert.equal(readyStatus.displays.B.dot, 'green');

    // Control triggers play
    wsControl.send(JSON.stringify({ t: 'play' }));
    const playA = await wsA.nextMessage((m) => m.t === 'play');
    const playB = await wsB.nextMessage((m) => m.t === 'play');
    assert.equal(playA.videoId, 'demo-1');
    assert.equal(playA.startAt, playB.startAt);

    // Displays finish -> cooldown
    wsA.send(JSON.stringify({ t: 'ended', videoId: 'demo-1' }));
    wsB.send(JSON.stringify({ t: 'ended', videoId: 'demo-1' }));
    const cooldownStatus = await wsControl.nextMessage(
      (m) => m.t === 'status' && m.state === 'COOLDOWN'
    );
    assert.equal(cooldownStatus.state, 'COOLDOWN');

    wsControl.close();
    wsA.close();
    wsB.close();
  });
});
