'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { verifyPin, signToken, verifyToken, hashPin } = require('./auth');
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

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
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

function createHttpServer({ config, db, pinGuard, getStateMachine }) {
  function applyCors(req, res) {
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
    let relPath = pathname === '/' ? '/control.html' : pathname;
    try {
      relPath = decodeURIComponent(relPath);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad_path' });
      return true;
    }

    const resolved = path.resolve(config.frontendDir, `.${relPath}`);
    if (
      resolved !== config.frontendDir &&
      !resolved.startsWith(config.frontendDir + path.sep)
    ) {
      sendJson(res, 403, { ok: false, error: 'forbidden_path' });
      return true;
    }

    if (!fs.existsSync(resolved)) return false;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return false;

    const ext = path.extname(resolved).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheControl =
      ext === '.webp' || ext === '.png' ? 'public, max-age=604800' : 'no-store';

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(resolved).pipe(res);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        const body = await readJsonBody(req);

        if (Array.isArray(body.presets)) {
          db.setPresets(body.presets);
        }
        if (Array.isArray(body.requiredDisplays)) {
          sm.setRequiredDisplays(body.requiredDisplays);
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
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        const body = await readJsonBody(req);
        const currentPin = String(body.currentPin ?? '');
        const newPin = String(body.newPin ?? '').trim();

        if (!verifyPin(currentPin, db.getPinHash())) {
          sendJson(res, 401, { ok: false, error: 'invalid_current_pin' });
          return;
        }
        if (newPin.length < 4 || newPin.length > 20) {
          sendJson(res, 400, { ok: false, error: 'invalid_new_pin_length' });
          return;
        }

        const nextVer = db.updatePinHash(hashPin(newPin));
        const { token, expiresAt } = signToken(
          { scope: 'admin', deviceId: null, ver: nextVer },
          db.getAuthSecret(),
          config.adminTokenTtlSec
        );
        sendJson(res, 200, { ok: true, token, expiresAt });
        return;
      }

      if (req.method === 'POST' && pathname === '/resync') {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        const result = sm.triggerResync();
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      // Video management routes (scaffolded in Phase 1, full streaming implementation in Phase 4)
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
          error: 'not_implemented_phase1',
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
          error: 'not_implemented_phase1',
          message: 'Range video streaming will be implemented in Phase 4'
        });
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/video/')) {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        sendJson(res, 501, {
          ok: false,
          error: 'not_implemented_phase1',
          message: 'Video deletion will be implemented in Phase 4'
        });
        return;
      }

      if (req.method === 'POST' && /^\/videos\/[^/]+\/activate$/.test(pathname)) {
        const claims = requireAuth(req, res, url, ['admin']);
        if (!claims) return;
        sendJson(res, 501, {
          ok: false,
          error: 'not_implemented_phase1',
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

  return server;
}

module.exports = {
  createHttpServer
};
