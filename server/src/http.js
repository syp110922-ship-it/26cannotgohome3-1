'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {
  MAX_PIN_LENGTH,
  verifyPin,
  signToken,
  verifyToken,
  hashPin,
  IpRateLimiter
} = require('./auth');
const { isOriginAllowed } = require('./ws');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
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
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
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
        if (!['admin', 'control', 'display'].includes(scope)) {
          sendJson(res, 400, { ok: false, error: 'invalid_scope' });
          return;
        }
        if (scope === 'display' && deviceId !== 'A' && deviceId !== 'B') {
          sendJson(res, 400, { ok: false, error: 'invalid_device_id' });
          return;
        }

        const valid = verifyPin(pin, db.getPinHash());
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
        const newPin = String(body.newPin ?? '').trim();

        if (!currentPin || currentPin.length > MAX_PIN_LENGTH || !verifyPin(currentPin, db.getPinHash())) {
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

        if (newPin.length < 4 || newPin.length > 20) {
          sendJson(res, 400, { ok: false, error: 'invalid_new_pin_length' });
          return;
        }

        pinGuard.recordSuccess();
        const nextVer = db.updatePinHash(hashPin(newPin));
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

      // Video management routes (scaffolded for Phase 4)
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
        sendJson(res, 501, {
          ok: false,
          error: 'not_implemented_phase4',
          message: 'Streaming video upload will be implemented in Phase 4'
        });
        return;
      }

      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        pathname.startsWith('/video/')
      ) {
        const claims = requireAuth(req, res, url, ['admin', 'control', 'display']);
        if (!claims) return;
        sendJson(res, 501, {
          ok: false,
          error: 'not_implemented_phase4',
          message: 'Range video streaming will be implemented in Phase 4'
        });
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/video/')) {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        sendJson(res, 501, {
          ok: false,
          error: 'not_implemented_phase4',
          message: 'Video deletion will be implemented in Phase 4'
        });
        return;
      }

      if (req.method === 'POST' && /^\/videos\/[^/]+\/activate$/.test(pathname)) {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        sendJson(res, 501, {
          ok: false,
          error: 'not_implemented_phase4',
          message: 'Video activation will be wired with Phase 4 upload'
        });
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
