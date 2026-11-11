'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Busboy = require('busboy');
const {
  MAX_PIN_LENGTH,
  verifyPin,
  signToken,
  verifyToken,
  hashPin,
  IpRateLimiter
} = require('./auth');
const { isOriginAllowed } = require('./ws');
const { hasValidFtypHeader, inspectUploadedMp4 } = require('./mp4');

const SAFE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

function safeUnlink(targetPath) {
  try {
    if (targetPath && fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  } catch {
    // ignore cleanup error
  }
}

function sanitizeFilename(rawName) {
  const base = path.basename(String(rawName || 'video.mp4')).replace(/[\r\n\0/\\]/g, '_').trim();
  const clean = base.slice(0, 160);
  return clean || 'video.mp4';
}

function parseByteRange(rangeHeader, totalSize) {
  if (typeof rangeHeader !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { invalid: true };

  if (totalSize === 0) return { invalid: true };

  let start;
  let end;
  if (!rawStart) {
    // Suffix byte range: bytes=-N
    const suffixLen = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLen) || suffixLen <= 0) return { invalid: true };
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { invalid: true };
    if (start < 0 || start >= totalSize || end < start) return { invalid: true };
    end = Math.min(end, totalSize - 1);
  }

  return { invalid: false, start, end };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src 'self' ws: wss: https: http:",
  "object-src 'none'",
  "base-uri 'self'"
].join('; ');

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 64 * 1024, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(Object.assign(new Error('Request body timeout'), { statusCode: 408 }));
    }, timeoutMs);

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        finish(reject, Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        finish(resolve, {});
        return;
      }
      try {
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(reject, Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', (err) => finish(reject, err));
  });
}

function getDiskFreeBytes(targetDir) {
  try {
    const stats = fs.statfsSync(targetDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function isLoopbackIp(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function getClientIp(req, config) {
  const remote = req.socket?.remoteAddress || '';
  if (config.trustProxy && isLoopbackIp(remote)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) {
        return parts[parts.length - 1];
      }
    }
  }
  return remote || 'unknown';
}

function createHttpServer({ config, db, pinGuard, getStateMachine, onPinChanged }) {
  const authIpLimiter = new IpRateLimiter({
    maxRequests: config.authIpRateLimitMax,
    windowMs: config.authIpRateLimitWindowMs
  });

  function applyCors(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const origin = req.headers.origin;
    if (config.allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (origin && isOriginAllowed(origin, config.allowedOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, X-Ghost-Token, X-Admin-Token, Content-Type, Range'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, ETag'
    );
  }

  function rejectDisallowedCrossOriginMutation(req, res) {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return false;
    if (config.allowedOrigins.includes('*')) return false;
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, config.allowedOrigins)) {
      sendJson(res, 403, { ok: false, error: 'forbidden_origin' });
      return true;
    }
    return false;
  }

  function requireJsonContentType(req, res) {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('application/json')) {
      sendJson(res, 415, { ok: false, error: 'unsupported_media_type' });
      return false;
    }
    return true;
  }

  function extractToken(req, url) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (m && m[1]) return m[1].trim();
    }
    const ghostToken = req.headers['x-ghost-token'] || req.headers['x-admin-token'];
    if (typeof ghostToken === 'string' && ghostToken.trim()) {
      return ghostToken.trim();
    }
    return url.searchParams.get('token') || '';
  }

  function requireAuth(req, res, url, allowedScopes) {
    const token = extractToken(req, url);
    const result = verifyToken(token, db.getAuthSecret(), db.getTokenVersion());
    if (!result.valid) {
      sendJson(res, 401, { ok: false, error: result.reason });
      return null;
    }
    if (allowedScopes && !allowedScopes.includes(result.claims.scope)) {
      sendJson(res, 403, { ok: false, error: 'forbidden_scope' });
      return null;
    }
    return result.claims;
  }

  function serveStaticFile(req, res, pathname) {
    let relPath = pathname;
    if (pathname === '/' || pathname === '/control') {
      relPath = '/control.html';
    } else if (pathname === '/display') {
      relPath = '/display.html';
    }
    try {
      relPath = decodeURIComponent(relPath);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad_path' });
      return true;
    }

    const frontendRoot = fs.existsSync(config.frontendDir)
      ? fs.realpathSync(config.frontendDir)
      : config.frontendDir;
    const resolved = path.resolve(frontendRoot, `.${relPath}`);
    if (
      resolved !== frontendRoot &&
      !resolved.startsWith(frontendRoot + path.sep)
    ) {
      sendJson(res, 403, { ok: false, error: 'forbidden_path' });
      return true;
    }

    if (!fs.existsSync(resolved)) return false;
    const realTarget = fs.realpathSync(resolved);
    if (
      realTarget !== frontendRoot &&
      !realTarget.startsWith(frontendRoot + path.sep)
    ) {
      sendJson(res, 403, { ok: false, error: 'forbidden_path' });
      return true;
    }

    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) return false;

    const ext = path.extname(realTarget).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheControl =
      ext === '.webp' || ext === '.png' ? 'public, max-age=604800' : 'no-store';

    const headers = {
      'Content-Type': mimeType,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = HTML_CSP;
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    const stream = fs.createReadStream(realTarget);
    stream.on('error', () => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'file_read_error' });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (rejectDisallowedCrossOriginMutation(req, res)) {
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_url' });
      return;
    }

    const { pathname } = url;
    const sm = getStateMachine();

    try {
      // Health check
      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          state: sm.getState(),
          uptimeSec: Math.round(process.uptime()),
          diskFreeBytes: getDiskFreeBytes(config.videosDir),
          requiredDisplays: db.getRequiredDisplays()
        });
        return;
      }

      // PIN Authentication -> issues admin (12h) or device/control (30d) token
      if (req.method === 'POST' && pathname === '/auth') {
        if (!requireJsonContentType(req, res)) return;

        const ipCheck = authIpLimiter.consume(getClientIp(req, config));
        if (!ipCheck.allowed) {
          sendJson(res, 429, {
            ok: false,
            error: 'rate_limited',
            retryAfterSec: ipCheck.retryAfterSec
          });
          return;
        }

        const lock = pinGuard.checkLock();
        if (lock.locked) {
          sendJson(res, 429, {
            ok: false,
            error: 'pin_locked',
            retryAfterSec: lock.retryAfterSec
          });
          return;
        }

        const body = await readJsonBody(req);
        const pin = body.pin !== undefined ? String(body.pin) : '';
        const scope = body.scope || 'admin';
        const deviceId = body.deviceId ? String(body.deviceId).toUpperCase() : null;

        if (!pin || pin.length > MAX_PIN_LENGTH) {
          sendJson(res, 400, { ok: false, error: 'invalid_pin_format' });
          return;
        }
        if (!['admin', 'control', 'display', 'diagnostics'].includes(scope)) {
          sendJson(res, 400, { ok: false, error: 'invalid_scope' });
          return;
        }
        if (scope === 'display' && deviceId !== 'A' && deviceId !== 'B') {
          sendJson(res, 400, { ok: false, error: 'invalid_device_id' });
          return;
        }

        let valid = false;
        if (scope === 'display') {
          valid =
            verifyPin(pin, db.getDisplayPinHash()) ||
            verifyPin(pin, db.getAdminPinHash());
        } else if (scope === 'admin') {
          valid = verifyPin(pin, db.getSettingsPinHash());
        } else if (scope === 'diagnostics') {
          valid =
            verifyPin(pin, db.getAdminPinHash()) ||
            verifyPin(pin, db.getSettingsPinHash());
        } else {
          valid = verifyPin(pin, db.getAdminPinHash());
        }
        if (!valid) {
          const failure = pinGuard.recordFailure();
          if (failure.locked) {
            sendJson(res, 429, {
              ok: false,
              error: 'pin_locked',
              retryAfterSec: failure.retryAfterSec
            });
            return;
          }
          sendJson(res, 401, {
            ok: false,
            error: 'invalid_pin',
            attemptsRemaining: failure.attemptsRemaining
          });
          return;
        }

        pinGuard.recordSuccess();
        const ttlSec =
          scope === 'admin' ? config.adminTokenTtlSec : config.deviceTokenTtlSec;
        const { token, expiresAt } = signToken(
          {
            scope,
            deviceId: scope === 'display' ? deviceId : null,
            ver: db.getTokenVersion()
          },
          db.getAuthSecret(),
          ttlSec
        );

        sendJson(res, 200, {
          ok: true,
          token,
          scope,
          deviceId: scope === 'display' ? deviceId : null,
          expiresAt,
          isDefaultPin: db.isDefaultPin()
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/auth/verify') {
        const claims = requireAuth(req, res, url, ['admin', 'control', 'display']);
        if (!claims) return;
        sendJson(res, 200, {
          ok: true,
          scope: claims.scope,
          deviceId: claims.deviceId || null,
          expiresAt: claims.exp * 1000,
          isDefaultPin: db.isDefaultPin()
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/status') {
        const claims = requireAuth(req, res, url, ['admin', 'control']);
        if (!claims) return;
        sendJson(res, 200, {
          ok: true,
          ...sm.getSnapshot(),
          playStats: db.getPlayStats()
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/presets') {
        const claims = requireAuth(req, res, url, ['admin', 'control']);
        if (!claims) return;
        sendJson(res, 200, {
          ok: true,
          presets: db.getPresets()
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/settings') {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        sendJson(res, 200, {
          ok: true,
          presets: db.getPresets(),
          requiredDisplays: db.getRequiredDisplays(),
          audioOffsets: db.getAudioOffsets(),
          isDefaultPin: db.isDefaultPin(),
          isDefaultAdminPin: db.isDefaultAdminPin(),
          isDefaultDisplayPin: db.isDefaultDisplayPin(),
          isDefaultSettingsPin: db.isDefaultSettingsPin(),
          archiveRetention: config.archiveRetention,
          playStats: db.getPlayStats()
        });
        return;
      }

      if (req.method === 'PUT' && pathname === '/settings') {
        if (!requireJsonContentType(req, res)) return;
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        const body = await readJsonBody(req);

        if (Array.isArray(body.presets)) {
          const cleaned = body.presets.map((s) => String(s ?? '').trim()).filter(Boolean);
          if (cleaned.length === 0) {
            sendJson(res, 400, { ok: false, error: 'presets_cannot_be_empty' });
            return;
          }
          db.setPresets(cleaned);
        }
        if (Array.isArray(body.requiredDisplays)) {
          try {
            sm.setRequiredDisplays(body.requiredDisplays);
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message });
            return;
          }
        }
        if (body.audioOffsets && typeof body.audioOffsets === 'object') {
          sm.setAudioOffsets(body.audioOffsets);
        }

        sendJson(res, 200, {
          ok: true,
          presets: db.getPresets(),
          requiredDisplays: db.getRequiredDisplays(),
          audioOffsets: db.getAudioOffsets()
        });
        return;
      }

      if (req.method === 'PUT' && pathname === '/settings/pin') {
        if (!requireJsonContentType(req, res)) return;
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;

        const lock = pinGuard.checkLock();
        if (lock.locked) {
          sendJson(res, 429, {
            ok: false,
            error: 'pin_locked',
            retryAfterSec: lock.retryAfterSec
          });
          return;
        }

        const body = await readJsonBody(req);
        const currentPin = String(body.currentPin ?? '');
        const newAdminPin =
          body.newAdminPin !== undefined
            ? String(body.newAdminPin).trim()
            : body.newPin !== undefined
              ? String(body.newPin).trim()
              : '';
        const newDisplayPin =
          body.newDisplayPin !== undefined ? String(body.newDisplayPin).trim() : '';
        const newSettingsPin =
          body.newSettingsPin !== undefined ? String(body.newSettingsPin).trim() : '';

        if (
          !currentPin ||
          currentPin.length > MAX_PIN_LENGTH ||
          !verifyPin(currentPin, db.getSettingsPinHash())
        ) {
          const failure = pinGuard.recordFailure();
          if (failure.locked) {
            sendJson(res, 429, {
              ok: false,
              error: 'pin_locked',
              retryAfterSec: failure.retryAfterSec
            });
            return;
          }
          sendJson(res, 401, {
            ok: false,
            error: 'invalid_current_pin',
            attemptsRemaining: failure.attemptsRemaining
          });
          return;
        }

        if (!newAdminPin && !newDisplayPin && !newSettingsPin) {
          sendJson(res, 400, { ok: false, error: 'missing_new_pin' });
          return;
        }
        if (newAdminPin && (newAdminPin.length < 4 || newAdminPin.length > MAX_PIN_LENGTH)) {
          sendJson(res, 400, { ok: false, error: 'invalid_new_admin_pin_length' });
          return;
        }
        if (
          newDisplayPin &&
          (newDisplayPin.length < 4 || newDisplayPin.length > MAX_PIN_LENGTH)
        ) {
          sendJson(res, 400, { ok: false, error: 'invalid_new_display_pin_length' });
          return;
        }
        if (
          newSettingsPin &&
          (newSettingsPin.length < 4 || newSettingsPin.length > MAX_PIN_LENGTH)
        ) {
          sendJson(res, 400, { ok: false, error: 'invalid_new_settings_pin_length' });
          return;
        }

        pinGuard.recordSuccess();
        const nextVer = db.updatePins({
          adminPinHash: newAdminPin ? hashPin(newAdminPin) : null,
          displayPinHash: newDisplayPin ? hashPin(newDisplayPin) : null,
          settingsPinHash: newSettingsPin ? hashPin(newSettingsPin) : null
        });
        if (typeof onPinChanged === 'function') {
          onPinChanged();
        }
        const { token, expiresAt } = signToken(
          { scope: 'admin', deviceId: null, ver: nextVer },
          db.getAuthSecret(),
          config.adminTokenTtlSec
        );
        const { token: controlToken, expiresAt: controlExpiresAt } = signToken(
          { scope: 'control', deviceId: null, ver: nextVer },
          db.getAuthSecret(),
          config.deviceTokenTtlSec
        );
        sendJson(res, 200, {
          ok: true,
          token,
          expiresAt,
          controlToken,
          controlExpiresAt
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/resync') {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        const result = sm.triggerResync();
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      // Video management routes (Phase 4)
      if (req.method === 'GET' && pathname === '/videos') {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        sendJson(res, 200, {
          ok: true,
          videos: db.listVideos(),
          archiveRetention: config.archiveRetention,
          diskFreeBytes: getDiskFreeBytes(config.videosDir)
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/upload') {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;

        if (
          sm.isUploading() ||
          sm.getState() === 'PLAYING' ||
          sm.getState() === 'COOLDOWN'
        ) {
          sendJson(res, 409, { ok: false, error: 'busy_cannot_upload' });
          return;
        }

        const ct = String(req.headers['content-type'] || '').toLowerCase();
        if (!ct.includes('multipart/form-data')) {
          sendJson(res, 415, { ok: false, error: 'multipart_required' });
          return;
        }

        const freeBefore = getDiskFreeBytes(config.videosDir);
        if (typeof freeBefore === 'number' && freeBefore < config.minDiskFreeBytes) {
          sendJson(res, 507, {
            ok: false,
            error: 'insufficient_disk_space',
            diskFreeBytes: freeBefore
          });
          return;
        }

        const contentLenHeader = Number(req.headers['content-length']);
        if (
          Number.isFinite(contentLenHeader) &&
          contentLenHeader > 0 &&
          typeof freeBefore === 'number' &&
          freeBefore - contentLenHeader < config.minDiskFreeBytes
        ) {
          sendJson(res, 507, {
            ok: false,
            error: 'insufficient_disk_space',
            diskFreeBytes: freeBefore
          });
          return;
        }

        const videoId = `vid_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const tmpPath = path.join(config.videosDir, `.tmp-${videoId}.mp4`);
        const finalPath = path.join(config.videosDir, `${videoId}.mp4`);

        fs.mkdirSync(config.videosDir, { recursive: true });
        sm.setUploading(true);

        await new Promise((resolve) => {
          let settled = false;
          let fileSeen = false;
          let fileStream = null;
          let cleanFilename = 'video.mp4';
          let totalBytes = 0;
          let headerChecked = false;
          let headBuf = Buffer.alloc(0);
          let bytesSinceDiskCheck = 0;
          const hash = crypto.createHash('sha256');
          let bb;

          const finishError = (statusCode, errorCode) => {
            if (settled) return;
            settled = true;
            if (fileStream) {
              try {
                fileStream.destroy();
              } catch {
                // ignore
              }
            }
            req.unpipe(bb);
            safeUnlink(tmpPath);
            sm.setUploading(false);
            if (!res.headersSent) {
              sendJson(res, statusCode, { ok: false, error: errorCode });
            }
            resolve();
          };

          try {
            bb = Busboy({ headers: req.headers, limits: { files: 1 } });
          } catch {
            finishError(400, 'invalid_multipart_header');
            return;
          }

          req.on('aborted', () => finishError(499, 'upload_aborted'));
          req.on('error', () => finishError(400, 'request_stream_error'));
          bb.on('error', () => finishError(400, 'multipart_parse_error'));

          bb.on('file', (_fieldname, stream, info) => {
            if (fileSeen) {
              stream.resume();
              return;
            }
            fileSeen = true;
            cleanFilename = sanitizeFilename(info?.filename);
            fileStream = fs.createWriteStream(tmpPath);

            fileStream.on('error', () => finishError(500, 'disk_write_error'));

            stream.on('data', (chunk) => {
              if (settled) return;
              totalBytes += chunk.length;
              bytesSinceDiskCheck += chunk.length;
              hash.update(chunk);

              if (!headerChecked) {
                const combined = Buffer.concat([headBuf, chunk]);
                headBuf = combined.subarray(0, 64);
                if (headBuf.length >= 12) {
                  headerChecked = true;
                  if (!hasValidFtypHeader(headBuf)) {
                    stream.destroy();
                    finishError(400, 'invalid_mp4_header');
                    return;
                  }
                }
              }

              if (bytesSinceDiskCheck >= 16 * 1024 * 1024) {
                bytesSinceDiskCheck = 0;
                const freeNow = getDiskFreeBytes(config.videosDir);
                if (typeof freeNow === 'number' && freeNow < config.minDiskFreeBytes) {
                  stream.destroy();
                  finishError(507, 'insufficient_disk_space');
                  return;
                }
              }

              const canContinue = fileStream.write(chunk);
              if (!canContinue) {
                stream.pause();
                fileStream.once('drain', () => {
                  if (!settled) stream.resume();
                });
              }
            });

            stream.on('end', () => {
              if (settled) return;
              if (!headerChecked && !hasValidFtypHeader(headBuf)) {
                finishError(400, 'invalid_mp4_header');
                return;
              }
              fileStream.end(async () => {
                if (settled) return;
                try {
                  const inspection = await inspectUploadedMp4(tmpPath);
                  if (!inspection.valid) {
                    finishError(400, inspection.reason || 'invalid_mp4');
                    return;
                  }
                  const sha256 = hash.digest('hex');
                  fs.renameSync(tmpPath, finalPath);
                  const video = db.insertVideo({
                    id: videoId,
                    filename: cleanFilename,
                    size: totalBytes,
                    duration: inspection.duration,
                    sha256,
                    active: true
                  });

                  const expired = db.getVideosBeyondRetention(config.archiveRetention);
                  for (const old of expired) {
                    db.deleteVideo(old.id);
                    safeUnlink(path.join(config.videosDir, `${old.id}.mp4`));
                  }

                  settled = true;
                  sm.setUploading(false);
                  sm.activateVideo(videoId);
                  sendJson(res, 200, {
                    ok: true,
                    video,
                    videos: db.listVideos(),
                    diskFreeBytes: getDiskFreeBytes(config.videosDir)
                  });
                  resolve();
                } catch {
                  finishError(500, 'video_finalize_error');
                }
              });
            });

            stream.on('error', () => finishError(400, 'upload_stream_error'));
          });

          bb.on('close', () => {
            if (!fileSeen && !settled) {
              finishError(400, 'missing_video_file');
            }
          });

          req.pipe(bb);
        });
        return;
      }

      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        pathname.startsWith('/video/')
      ) {
        const claims = requireAuth(req, res, url, ['admin', 'control', 'display']);
        if (!claims) return;

        const videoId = pathname.slice('/video/'.length);
        if (!SAFE_VIDEO_ID_RE.test(videoId)) {
          sendJson(res, 400, { ok: false, error: 'invalid_video_id' });
          return;
        }
        const video = db.getVideoById(videoId);
        const filePath = path.join(config.videosDir, `${videoId}.mp4`);
        if (!video || !fs.existsSync(filePath)) {
          sendJson(res, 404, { ok: false, error: 'video_not_found' });
          return;
        }

        const stat = fs.statSync(filePath);
        const totalSize = stat.size;
        const baseHeaders = {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          ETag: `"${video.sha256}"`,
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff'
        };

        if (req.method === 'HEAD') {
          res.writeHead(200, {
            ...baseHeaders,
            'Content-Length': totalSize
          });
          res.end();
          return;
        }

        if (req.headers.range) {
          const parsed = parseByteRange(req.headers.range, totalSize);
          if (!parsed || parsed.invalid) {
            res.writeHead(416, {
              ...baseHeaders,
              'Content-Range': `bytes */${totalSize}`
            });
            res.end();
            return;
          }

          const { start, end } = parsed;
          res.writeHead(206, {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': end - start + 1
          });
          const stream = fs.createReadStream(filePath, { start, end });
          res.on('close', () => stream.destroy());
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }

        res.writeHead(200, {
          ...baseHeaders,
          'Content-Length': totalSize
        });
        const stream = fs.createReadStream(filePath);
        res.on('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/video/')) {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;

        const videoId = pathname.slice('/video/'.length);
        if (!SAFE_VIDEO_ID_RE.test(videoId)) {
          sendJson(res, 400, { ok: false, error: 'invalid_video_id' });
          return;
        }
        const video = db.getVideoById(videoId);
        if (!video) {
          sendJson(res, 404, { ok: false, error: 'video_not_found' });
          return;
        }
        if (video.active) {
          sendJson(res, 409, { ok: false, error: 'cannot_delete_active_video' });
          return;
        }

        db.deleteVideo(videoId);
        safeUnlink(path.join(config.videosDir, `${videoId}.mp4`));
        sendJson(res, 200, {
          ok: true,
          videos: db.listVideos(),
          diskFreeBytes: getDiskFreeBytes(config.videosDir)
        });
        return;
      }

      if (req.method === 'POST' && /^\/videos\/[^/]+\/activate$/.test(pathname)) {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;

        const videoId = pathname.split('/')[2];
        if (!SAFE_VIDEO_ID_RE.test(videoId)) {
          sendJson(res, 400, { ok: false, error: 'invalid_video_id' });
          return;
        }
        const filePath = path.join(config.videosDir, `${videoId}.mp4`);
        if (!fs.existsSync(filePath)) {
          sendJson(res, 404, { ok: false, error: 'video_file_missing' });
          return;
        }
        const result = sm.activateVideo(videoId);
        if (!result.ok) {
          sendJson(res, result.reason === 'video_not_found' ? 404 : 409, result);
          return;
        }
        sendJson(res, 200, {
          ok: true,
          video: result.video,
          videos: db.listVideos()
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/test-play') {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        const result = sm.requestPlay({ allowPartial: true });
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/test-stop') {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        const result = sm.requestStop();
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (config.serveFrontend && (req.method === 'GET' || req.method === 'HEAD')) {
        if (serveStaticFile(req, res, pathname)) {
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, {
        ok: false,
        error: status === 500 ? 'internal_error' : err.message
      });
    }
  });

  // Protect against slowloris headers while allowing multi-minute large video transfers
  server.headersTimeout = 15000;
  server.requestTimeout = 0;

  return server;
}

module.exports = {
  createHttpServer
};
