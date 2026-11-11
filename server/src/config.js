'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseDisplayList(raw) {
  const allowed = new Set(['A', 'B']);
  const items = String(raw || 'A,B')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => allowed.has(s));
  const unique = [...new Set(items)];
  return unique.length > 0 ? unique : ['A', 'B'];
}

function parseAllowedOrigins(raw) {
  const val = String(raw || '*').trim();
  if (!val || val === '*') return ['*'];
  return val
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function loadConfig(overrides = {}) {
  loadEnvFile(path.join(REPO_ROOT, '.env'));

  const dataDir = path.resolve(
    REPO_ROOT,
    overrides.dataDir || process.env.DATA_DIR || './data'
  );
  const videosDir = path.resolve(
    REPO_ROOT,
    overrides.videosDir || process.env.VIDEOS_DIR || path.join(dataDir, 'videos')
  );
  const dbPath =
    overrides.dbPath === ':memory:'
      ? ':memory:'
      : path.resolve(
          REPO_ROOT,
          overrides.dbPath || process.env.DB_PATH || path.join(dataDir, 'app.db')
        );

  return {
    repoRoot: REPO_ROOT,
    host: overrides.host || process.env.HOST || '0.0.0.0',
    port: Number(overrides.port ?? process.env.PORT ?? 3000),
    dataDir,
    videosDir,
    dbPath,
    frontendDir: path.resolve(REPO_ROOT, overrides.frontendDir || 'frontend'),
    serveFrontend:
      overrides.serveFrontend ?? (process.env.SERVE_FRONTEND ?? 'true') !== 'false',
    trustProxy:
      overrides.trustProxy ?? (process.env.TRUST_PROXY ?? 'false') === 'true',
    allowedOrigins:
      overrides.allowedOrigins || parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
    authSecret: overrides.authSecret ?? process.env.AUTH_SECRET ?? '',
    initialPin: String(overrides.initialPin ?? process.env.INITIAL_PIN ?? '1234'),
    pinMaxAttempts: Number(overrides.pinMaxAttempts ?? process.env.PIN_MAX_ATTEMPTS ?? 5),
    pinLockoutMs: Number(overrides.pinLockoutMs ?? process.env.PIN_LOCKOUT_MS ?? 60000),
    authIpRateLimitMax: Number(
      overrides.authIpRateLimitMax ?? process.env.AUTH_IP_RATE_LIMIT_MAX ?? 20
    ),
    authIpRateLimitWindowMs: Number(
      overrides.authIpRateLimitWindowMs ?? process.env.AUTH_IP_RATE_LIMIT_WINDOW_MS ?? 60000
    ),
    adminTokenTtlSec: Number(
      overrides.adminTokenTtlSec ?? process.env.ADMIN_TOKEN_TTL_SEC ?? 43200
    ),
    deviceTokenTtlSec: Number(
      overrides.deviceTokenTtlSec ?? process.env.DEVICE_TOKEN_TTL_SEC ?? 2592000
    ),
    requiredDisplays:
      overrides.requiredDisplays || parseDisplayList(process.env.REQUIRED_DISPLAYS),
    archiveRetention: Number(overrides.archiveRetention ?? process.env.ARCHIVE_RETENTION ?? 3),
    minDiskFreeBytes: Number(
      overrides.minDiskFreeBytes ?? process.env.MIN_DISK_FREE_BYTES ?? 536870912
    ),
    heartbeatTimeoutMs: Number(
      overrides.heartbeatTimeoutMs ?? process.env.HEARTBEAT_TIMEOUT_MS ?? 15000
    ),
    wsPingIntervalMs: Number(
      overrides.wsPingIntervalMs ?? process.env.WS_PING_INTERVAL_MS ?? 10000
    ),
    cooldownMs: Number(overrides.cooldownMs ?? process.env.COOLDOWN_MS ?? 3000),
    playScheduleLeadMs: Number(
      overrides.playScheduleLeadMs ?? process.env.PLAY_SCHEDULE_LEAD_MS ?? 300
    ),
    playbackSafetyMarginMs: Number(
      overrides.playbackSafetyMarginMs ?? process.env.PLAYBACK_SAFETY_MARGIN_MS ?? 10000
    ),
    msgDuplicateWindowMs: Number(
      overrides.msgDuplicateWindowMs ?? process.env.MSG_DUPLICATE_WINDOW_MS ?? 2000
    )
  };
}

module.exports = {
  loadConfig,
  parseDisplayList,
  parseAllowedOrigins
};
