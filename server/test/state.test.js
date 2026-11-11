'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createDatabase } = require('../src/db');
const { createStateMachine, STATES } = require('../src/state');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('state machine', () => {
  let tmpDir;
  let db;
  let sm;
  let broadcasts;
  let displayMsgs;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-state-'));
    const config = loadConfig({
      dataDir: tmpDir,
      videosDir: path.join(tmpDir, 'videos'),
      dbPath: path.join(tmpDir, 'app.db'),
      cooldownMs: 80,
      playScheduleLeadMs: 50,
      playbackSafetyMarginMs: 120,
      heartbeatTimeoutMs: 500,
      msgDuplicateWindowMs: 200
    });
    db = createDatabase(config);
    broadcasts = [];
    displayMsgs = [];
    sm = createStateMachine({
      config,
      db,
      onBroadcast: (snap) => broadcasts.push(snap),
      onSendToDisplays: (msg, targetId) => displayMsgs.push({ msg, targetId: targetId || 'ALL' }),
      onCloseDisplaySocket: () => {}
    });
  });

  afterEach(() => {
    sm.destroy();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('transitions NOT_READY -> READY -> PLAYING -> COOLDOWN -> READY', async () => {
    assert.equal(sm.getState(), STATES.NOT_READY);

    db.insertVideo({
      id: 'vid-1',
      filename: 'ghost.mp4',
      size: 1024,
      duration: 0.2,
      sha256: 'abc',
      active: true
    });
    const actRes = sm.activateVideo('vid-1');
    assert.equal(actRes.ok, true);
    assert.equal(sm.getState(), STATES.NOT_READY);

    sm.connectDisplay('A');
    sm.connectDisplay('B');
    assert.equal(sm.getSnapshot().displays.A.dot, 'orange');

    sm.updateDisplayState('A', { cached: ['vid-1'], dl: 100 });
    assert.equal(sm.getState(), STATES.NOT_READY);

    sm.updateDisplayState('B', { cached: ['vid-1'], dl: 100 });
    assert.equal(sm.getState(), STATES.READY);
    assert.equal(sm.getSnapshot().displays.A.dot, 'green');
    assert.equal(sm.getSnapshot().displays.B.dot, 'green');

    const playRes = sm.requestPlay();
    assert.equal(playRes.ok, true);
    assert.equal(sm.getState(), STATES.PLAYING);
    const playPayloads = displayMsgs.filter((m) => m.msg.t === 'play');
    assert.equal(playPayloads.length, 2);

    sm.handleDisplayEnded('A', { videoId: 'vid-1' });
    assert.equal(sm.getState(), STATES.PLAYING);

    sm.handleDisplayEnded('B', { videoId: 'vid-1' });
    assert.equal(sm.getState(), STATES.COOLDOWN);

    // Cannot play during cooldown
    const blockedPlay = sm.requestPlay();
    assert.equal(blockedPlay.ok, false);

    await sleep(110);
    assert.equal(sm.getState(), STATES.READY);
    assert.equal(db.getPlayStats().completedPlays, 1);
  });

  it('continues playing if one display disconnects and handles stop / safety timeout', async () => {
    db.insertVideo({
      id: 'vid-2',
      filename: 'ghost2.mp4',
      size: 2048,
      duration: 0.1,
      sha256: 'def',
      active: true
    });
    sm.activateVideo('vid-2');
    sm.connectDisplay('A');
    sm.connectDisplay('B');
    sm.updateDisplayState('A', { cached: ['vid-2'], dl: 100 });
    sm.updateDisplayState('B', { cached: ['vid-2'], dl: 100 });

    assert.equal(sm.requestPlay().ok, true);
    sm.disconnectDisplay('B');
    assert.equal(sm.getState(), STATES.PLAYING);

    // Remaining display ends -> enters cooldown -> after cooldown becomes NOT_READY because B is disconnected
    sm.handleDisplayEnded('A', { videoId: 'vid-2' });
    assert.equal(sm.getState(), STATES.COOLDOWN);
    await sleep(110);
    assert.equal(sm.getState(), STATES.NOT_READY);

    // Reconnect B -> READY -> play -> stop immediately
    sm.connectDisplay('B');
    sm.updateDisplayState('B', { cached: ['vid-2'], dl: 100 });
    assert.equal(sm.getState(), STATES.READY);
    assert.equal(sm.requestPlay().ok, true);
    assert.equal(sm.requestStop().ok, true);
    assert.equal(sm.getState(), STATES.COOLDOWN);
    assert.equal(db.getPlayStats().stoppedPlays, 1);
  });

  it('supports single-display mode and blocks duplicate messages within window', async () => {
    db.insertVideo({
      id: 'vid-3',
      filename: 'single.mp4',
      size: 512,
      duration: 5,
      sha256: 'ghi',
      active: true
    });
    sm.activateVideo('vid-3');
    sm.setRequiredDisplays(['A']);
    sm.connectDisplay('A');
    sm.updateDisplayState('A', { cached: ['vid-3'], dl: 100 });
    assert.equal(sm.getState(), STATES.READY);

    const m1 = sm.sendMessage('입장해 주세요');
    assert.equal(m1.ok, true);
    const m2 = sm.sendMessage('입장해 주세요');
    assert.equal(m2.ok, false);
    assert.equal(m2.reason, 'duplicate_message');

    await sleep(230);
    const m3 = sm.sendMessage('입장해 주세요');
    assert.equal(m3.ok, true);
  });
});
