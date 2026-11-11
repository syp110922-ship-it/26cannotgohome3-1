'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

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

const DISPLAY_ALLOWED_STATIC_FILES = new Set([
  '/display.html',
  '/display.css',
  '/display.js',
  '/config.js'
]);

const API_PATH_PREFIXES = [
  '/health',
  '/auth',
  '/status',
  '/presets',
  '/settings',
  '/videos',
  '/video',
  '/upload',
  '/play',
  '/stop',
  '/resync',
  '/test-play',
  '/test-stop'
];

function isApiPath(pathname) {
  return API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function resolveAllowedDisplayStatic(pathname, frontendDir) {
  let mapped = pathname;
  if (mapped === '/' || mapped === '/display') {
    mapped = '/display.html';
  }

  const isExplicitStatic = DISPLAY_ALLOWED_STATIC_FILES.has(mapped);
  const isSharedOrAsset = mapped.startsWith('/shared/') || mapped.startsWith('/assets/');
  if (!isExplicitStatic && !isSharedOrAsset) {
    return null;
  }

  // Never serve control background on display preview if not needed, or keep assets accessible
  const frontendRoot = fs.realpathSync(frontendDir);
  const relPath = mapped.replace(/^\/+/, '');
  const candidate = path.resolve(frontendRoot, relPath);
  if (candidate !== frontendRoot && !candidate.startsWith(frontendRoot + path.sep)) {
    return null;
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    return null;
  }

  if (realTarget !== frontendRoot && !realTarget.startsWith(frontendRoot + path.sep)) {
    return null;
  }

  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) return null;
  return { realTarget, stat };
}

function createDisplayPreviewServer({
  frontendDir = path.resolve(__dirname, '../../frontend'),
  backendOrigin = process.env.BACKEND_ORIGIN || 'http://127.0.0.1:3000'
} = {}) {
  const targetUrl = new URL(backendOrigin);

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://localhost');

    if (isApiPath(reqUrl.pathname)) {
      const headers = { ...req.headers };
      headers.host = targetUrl.host;
      if (req.socket?.remoteAddress) {
        const prior = headers['x-forwarded-for'];
        headers['x-forwarded-for'] = prior
          ? `${prior}, ${req.socket.remoteAddress}`
          : req.socket.remoteAddress;
      }

      const proxyReq = http.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: Number(targetUrl.port || 80),
          method: req.method,
          path: reqUrl.pathname + reqUrl.search,
          headers
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );

      proxyReq.on('error', () => {
        if (!res.headersSent) {
          const body = JSON.stringify({ ok: false, error: 'upstream_unavailable' });
          res.writeHead(502, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body)
          });
          res.end(body);
        } else {
          res.destroy();
        }
      });

      req.pipe(proxyReq);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const found = resolveAllowedDisplayStatic(reqUrl.pathname, frontendDir);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(found.realTarget).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheControl =
      ext === '.webp' || ext === '.png' ? 'public, max-age=604800' : 'no-store';
    const headers = {
      'Content-Type': mime,
      'Content-Length': found.stat.size,
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
      return;
    }
    fs.createReadStream(found.realTarget).pipe(res);
  });

  server.requestTimeout = 0;

  server.on('upgrade', (req, clientSocket, head) => {
    let reqUrl;
    try {
      reqUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
      clientSocket.destroy();
      return;
    }

    if (reqUrl.pathname !== '/ws') {
      clientSocket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const headers = { ...req.headers };
    headers.host = targetUrl.host;
    if (req.socket?.remoteAddress) {
      const prior = headers['x-forwarded-for'];
      headers['x-forwarded-for'] = prior
        ? `${prior}, ${req.socket.remoteAddress}`
        : req.socket.remoteAddress;
    }

    const proxyReq = http.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port || 80),
      method: req.method,
      path: reqUrl.pathname + reqUrl.search,
      headers
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const statusCode = proxyRes.statusCode || 101;
      const statusMessage = proxyRes.statusMessage || 'Switching Protocols';
      let rawResponse = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        rawResponse += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
      }
      rawResponse += '\r\n';
      clientSocket.write(rawResponse);

      if (proxyHead && proxyHead.length > 0) {
        clientSocket.write(proxyHead);
      }
      if (head && head.length > 0) {
        proxySocket.write(head);
      }

      clientSocket.setNoDelay(true);
      proxySocket.setNoDelay(true);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);

      const cleanup = () => {
        if (!proxySocket.destroyed) proxySocket.destroy();
        if (!clientSocket.destroyed) clientSocket.destroy();
      };
      proxySocket.on('error', cleanup);
      clientSocket.on('error', cleanup);
      proxySocket.on('close', cleanup);
      clientSocket.on('close', cleanup);
    });

    proxyReq.on('response', (proxyRes) => {
      let rawResponse = `HTTP/1.1 ${proxyRes.statusCode || 502} ${proxyRes.statusMessage || 'Bad Gateway'}\r\n`;
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        rawResponse += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
      }
      rawResponse += '\r\n';
      clientSocket.write(rawResponse);
      proxyRes.pipe(clientSocket);
    });

    proxyReq.on('error', () => {
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        clientSocket.destroy();
      }
    });

    proxyReq.end();
  });

  return server;
}

async function startDisplayPreview(options = {}) {
  const port = Number(options.port ?? process.env.DISPLAY_PREVIEW_PORT ?? 3001);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const server = createDisplayPreviewServer(options);

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });

  return {
    server,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      })
  };
}

if (require.main === module) {
  startDisplayPreview().then(({ port }) => {
    console.log(
      `[ghost-display-preview] listening on http://0.0.0.0:${port} -> backend ${
        process.env.BACKEND_ORIGIN || 'http://127.0.0.1:3000'
      }`
    );
  });
}

module.exports = {
  createDisplayPreviewServer,
  startDisplayPreview
};
