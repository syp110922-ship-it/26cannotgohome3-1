'use strict';

const crypto = require('node:crypto');

const MAX_PIN_LENGTH = 64;

function hashPin(pin) {
  const normalized = String(pin);
  if (!normalized || normalized.length > MAX_PIN_LENGTH) {
    throw new Error('PIN length invalid');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(normalized, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPin(pin, storedHash) {
  if (typeof pin !== 'string' && typeof pin !== 'number') return false;
  const normalized = String(pin);
  if (!normalized || normalized.length > MAX_PIN_LENGTH) return false;
  if (typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (expectedBuf.length === 0) return false;
  const actualBuf = crypto.scryptSync(normalized, salt, expectedBuf.length);
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
}

function signToken(claims, secret, ttlSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      ...claims,
      iat: nowSec,
      exp: nowSec + ttlSec
    })
  );
  const signingInput = `${header}.${payload}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return {
    token: `${signingInput}.${sig}`,
    expiresAt: (nowSec + ttlSec) * 1000
  };
}

function verifyToken(token, secret, expectedTokenVersion) {
  if (typeof token !== 'string' || !token || token.length > 4096) {
    return { valid: false, reason: 'missing_token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed_token' };
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const sigBuf = Buffer.from(sigB64);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  let header;
  let claims;
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
    claims = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }

  if (
    !header ||
    typeof header !== 'object' ||
    header.alg !== 'HS256' ||
    header.typ !== 'JWT'
  ) {
    return { valid: false, reason: 'invalid_header' };
  }

  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    return { valid: false, reason: 'invalid_payload' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= nowSec) {
    return { valid: false, reason: 'expired_token' };
  }

  if (
    expectedTokenVersion !== undefined &&
    Number(claims.ver) !== Number(expectedTokenVersion)
  ) {
    return { valid: false, reason: 'revoked_token' };
  }

  return { valid: true, claims };
}

class PinAttemptGuard {
  constructor({ maxAttempts = 5, lockoutMs = 60000, store = null } = {}) {
    this.maxAttempts = maxAttempts;
    this.lockoutMs = lockoutMs;
    this.store = store;

    const initial = store ? store.load() : null;
    this.failedAttempts = Number(initial?.failedAttempts || 0);
    this.lockedUntil = Number(initial?.lockedUntil || 0);
  }

  _persist() {
    if (this.store) {
      this.store.save({
        failedAttempts: this.failedAttempts,
        lockedUntil: this.lockedUntil
      });
    }
  }

  checkLock(now = Date.now()) {
    if (this.lockedUntil > now) {
      const remainingMs = this.lockedUntil - now;
      return {
        locked: true,
        remainingMs,
        retryAfterSec: Math.ceil(remainingMs / 1000)
      };
    }
    if (this.lockedUntil > 0 && this.lockedUntil <= now) {
      this.lockedUntil = 0;
      this.failedAttempts = 0;
      this._persist();
    }
    return { locked: false, remainingMs: 0, retryAfterSec: 0 };
  }

  recordFailure(now = Date.now()) {
    const lock = this.checkLock(now);
    if (lock.locked) return lock;

    this.failedAttempts += 1;
    if (this.failedAttempts >= this.maxAttempts) {
      this.lockedUntil = now + this.lockoutMs;
      this._persist();
      return {
        locked: true,
        remainingMs: this.lockoutMs,
        retryAfterSec: Math.ceil(this.lockoutMs / 1000),
        attemptsRemaining: 0
      };
    }

    this._persist();
    return {
      locked: false,
      remainingMs: 0,
      retryAfterSec: 0,
      attemptsRemaining: this.maxAttempts - this.failedAttempts
    };
  }

  recordSuccess() {
    if (this.failedAttempts !== 0 || this.lockedUntil !== 0) {
      this.failedAttempts = 0;
      this.lockedUntil = 0;
      this._persist();
    }
  }
}

class IpRateLimiter {
  constructor({ maxRequests = 20, windowMs = 60000 } = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  consume(ip, now = Date.now()) {
    const key = String(ip || 'unknown');
    if (this.buckets.size > 1000) {
      for (const [k, b] of this.buckets) {
        if (b.resetAt <= now) this.buckets.delete(k);
      }
    }

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > this.maxRequests) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      };
    }

    return { allowed: true, retryAfterSec: 0 };
  }
}

module.exports = {
  MAX_PIN_LENGTH,
  hashPin,
  verifyPin,
  signToken,
  verifyToken,
  PinAttemptGuard,
  IpRateLimiter
};
