'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPin } = require('./auth');

const DEFAULT_PRESETS = [
  '잠시 후 입장해 주세요',
  '영상이 곧 시작됩니다',
  '퇴장해 주세요',
  '스태프가 도와드릴게요'
];

function createDatabase(config) {
  if (config.dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }
  fs.mkdirSync(config.videosDir, { recursive: true });

  const db = new DatabaseSync(config.dbPath);
  if (config.dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      duration REAL NOT NULL,
      sha256 TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS idx_videos_active_uploaded
      ON videos(active DESC, uploaded_at DESC);

    CREATE TABLE IF NOT EXISTS play_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      ended_by TEXT CHECK (ended_by IN ('end', 'stop', 'timeout') OR ended_by IS NULL),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_play_log_started_at
      ON play_log(started_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const stmtSetSetting = db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const stmtInsertDefault = db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)'
  );

  // Seed defaults on first run
  const existingPin = stmtGetSetting.get('pin_hash');
  if (!existingPin) {
    stmtInsertDefault.run('pin_hash', hashPin(config.initialPin));
    stmtInsertDefault.run('pin_is_default', 'true');
  }

  const secretToSeed =
    config.authSecret && config.authSecret.trim().length >= 16
      ? config.authSecret.trim()
      : crypto.randomBytes(32).toString('hex');
  stmtInsertDefault.run('auth_secret', secretToSeed);
  stmtInsertDefault.run('token_version', '1');
  stmtInsertDefault.run('presets', JSON.stringify(DEFAULT_PRESETS));
  stmtInsertDefault.run('required_displays', JSON.stringify(config.requiredDisplays));
  stmtInsertDefault.run('audio_offsets', JSON.stringify({ A: 0, B: 0 }));

  function getSetting(key, fallback = null) {
    const row = stmtGetSetting.get(key);
    return row ? row.value : fallback;
  }

  function setSetting(key, value) {
    stmtSetSetting.run(key, String(value));
  }

  function getJsonSetting(key, fallback) {
    const raw = getSetting(key, null);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function setJsonSetting(key, value) {
    setSetting(key, JSON.stringify(value));
  }

  function getAuthSecret() {
    if (config.authSecret && config.authSecret.trim().length >= 16) {
      return config.authSecret.trim();
    }
    return getSetting('auth_secret');
  }

  function getTokenVersion() {
    return Number(getSetting('token_version', '1'));
  }

  function bumpTokenVersion() {
    const next = getTokenVersion() + 1;
    setSetting('token_version', String(next));
    return next;
  }

  function getPinHash() {
    return getSetting('pin_hash');
  }

  function updatePinHash(newHash) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      setSetting('pin_hash', newHash);
      setSetting('pin_is_default', 'false');
      const nextVer = getTokenVersion() + 1;
      setSetting('token_version', String(nextVer));
      db.exec('COMMIT;');
      return nextVer;
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  function isDefaultPin() {
    return getSetting('pin_is_default', 'false') === 'true';
  }

  function getPinGuardState() {
    return getJsonSetting('pin_guard_state', { failedAttempts: 0, lockedUntil: 0 });
  }

  function savePinGuardState({ failedAttempts, lockedUntil }) {
    setJsonSetting('pin_guard_state', {
      failedAttempts: Number(failedAttempts || 0),
      lockedUntil: Number(lockedUntil || 0)
    });
  }

  function getPresets() {
    const list = getJsonSetting('presets', DEFAULT_PRESETS);
    return Array.isArray(list) ? list : DEFAULT_PRESETS;
  }

  function setPresets(presets) {
    const cleaned = presets
      .map((s) => String(s ?? '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 12);
    setJsonSetting('presets', cleaned);
    return cleaned;
  }

  function getRequiredDisplays() {
    const allowed = new Set(['A', 'B']);
    const list = getJsonSetting('required_displays', config.requiredDisplays);
    if (!Array.isArray(list)) return config.requiredDisplays;
    const cleaned = [...new Set(list.map((s) => String(s).toUpperCase()).filter((s) => allowed.has(s)))];
    return cleaned.length > 0 ? cleaned : config.requiredDisplays;
  }

  function setRequiredDisplays(displays) {
    const allowed = new Set(['A', 'B']);
    const cleaned = [
      ...new Set(
        (Array.isArray(displays) ? displays : [])
          .map((s) => String(s).toUpperCase())
          .filter((s) => allowed.has(s))
      )
    ];
    if (cleaned.length === 0) {
      throw new Error('requiredDisplays must include at least A or B');
    }
    setJsonSetting('required_displays', cleaned);
    return cleaned;
  }

  function getAudioOffsets() {
    const offsets = getJsonSetting('audio_offsets', { A: 0, B: 0 });
    return {
      A: Number(offsets?.A || 0),
      B: Number(offsets?.B || 0)
    };
  }

  function setAudioOffsets(offsets) {
    const next = {
      A: Math.max(-2000, Math.min(2000, Number(offsets?.A || 0))),
      B: Math.max(-2000, Math.min(2000, Number(offsets?.B || 0)))
    };
    setJsonSetting('audio_offsets', next);
    return next;
  }

  const stmtGetActiveVideo = db.prepare(
    'SELECT id, filename, size, duration, sha256, uploaded_at, active FROM videos WHERE active = 1 LIMIT 1'
  );
  const stmtListVideos = db.prepare(
    'SELECT id, filename, size, duration, sha256, uploaded_at, active FROM videos ORDER BY active DESC, uploaded_at DESC'
  );
  const stmtGetVideoById = db.prepare(
    'SELECT id, filename, size, duration, sha256, uploaded_at, active FROM videos WHERE id = ?'
  );
  const stmtInsertVideo = db.prepare(
    'INSERT INTO videos(id, filename, size, duration, sha256, uploaded_at, active) VALUES(?, ?, ?, ?, ?, ?, ?)'
  );
  const stmtDeactivateAll = db.prepare('UPDATE videos SET active = 0 WHERE active = 1');
  const stmtActivateById = db.prepare('UPDATE videos SET active = 1 WHERE id = ?');
  const stmtDeleteVideoById = db.prepare('DELETE FROM videos WHERE id = ?');

  function formatVideoRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      filename: row.filename,
      size: Number(row.size),
      duration: Number(row.duration),
      sha256: row.sha256,
      uploadedAt: Number(row.uploaded_at),
      active: row.active === 1
    };
  }

  function getActiveVideo() {
    return formatVideoRow(stmtGetActiveVideo.get());
  }

  function listVideos() {
    return stmtListVideos.all().map(formatVideoRow);
  }

  function getVideoById(id) {
    return formatVideoRow(stmtGetVideoById.get(id));
  }

  function insertVideo({ id, filename, size, duration, sha256, uploadedAt = Date.now(), active = false }) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      if (active) {
        stmtDeactivateAll.run();
      }
      stmtInsertVideo.run(id, filename, size, duration, sha256, uploadedAt, active ? 1 : 0);
      db.exec('COMMIT;');
      return getVideoById(id);
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  function activateVideo(id) {
    const existing = getVideoById(id);
    if (!existing) return null;
    db.exec('BEGIN IMMEDIATE;');
    try {
      stmtDeactivateAll.run();
      stmtActivateById.run(id);
      db.exec('COMMIT;');
      return getVideoById(id);
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  function deleteVideo(id) {
    const info = stmtDeleteVideoById.run(id);
    return info.changes > 0;
  }

  function getVideosBeyondRetention(keepInactiveCount = config.archiveRetention) {
    const rows = db
      .prepare(
        'SELECT id, filename, size, duration, sha256, uploaded_at, active FROM videos WHERE active = 0 ORDER BY uploaded_at DESC LIMIT -1 OFFSET ?'
      )
      .all(Math.max(0, keepInactiveCount));
    return rows.map(formatVideoRow);
  }

  const stmtInsertPlayLog = db.prepare(
    'INSERT INTO play_log(video_id, started_at, ended_at, ended_by) VALUES(?, ?, NULL, NULL)'
  );
  const stmtFinishPlayLog = db.prepare(
    'UPDATE play_log SET ended_at = ?, ended_by = ? WHERE id = ?'
  );
  const stmtGetPlayStats = db.prepare(`
    SELECT
      COUNT(*) AS total_plays,
      SUM(CASE WHEN ended_by = 'end' THEN 1 ELSE 0 END) AS completed_plays,
      SUM(CASE WHEN ended_by = 'stop' THEN 1 ELSE 0 END) AS stopped_plays,
      SUM(CASE WHEN ended_by = 'timeout' THEN 1 ELSE 0 END) AS timeout_plays
    FROM play_log
  `);

  function startPlayLog(videoId, startedAt = Date.now()) {
    const res = stmtInsertPlayLog.run(videoId, startedAt);
    return Number(res.lastInsertRowid);
  }

  function finishPlayLog(logId, endedBy, endedAt = Date.now()) {
    if (!logId) return;
    stmtFinishPlayLog.run(endedAt, endedBy, logId);
  }

  function getPlayStats() {
    const row = stmtGetPlayStats.get();
    return {
      totalPlays: Number(row?.total_plays || 0),
      completedPlays: Number(row?.completed_plays || 0),
      stoppedPlays: Number(row?.stopped_plays || 0),
      timeoutPlays: Number(row?.timeout_plays || 0)
    };
  }

  function close() {
    db.close();
  }

  return {
    db,
    DEFAULT_PRESETS,
    getSetting,
    setSetting,
    getAuthSecret,
    getTokenVersion,
    bumpTokenVersion,
    getPinHash,
    updatePinHash,
    isDefaultPin,
    getPinGuardState,
    savePinGuardState,
    getPresets,
    setPresets,
    getRequiredDisplays,
    setRequiredDisplays,
    getAudioOffsets,
    setAudioOffsets,
    getActiveVideo,
    listVideos,
    getVideoById,
    insertVideo,
    activateVideo,
    deleteVideo,
    getVideosBeyondRetention,
    startPlayLog,
    finishPlayLog,
    getPlayStats,
    close
  };
}

module.exports = {
  createDatabase,
  DEFAULT_PRESETS
};
