'use strict';

const crypto = require('node:crypto');

function hashPin(pin) {
  const normalized = String(pin);
  if (!normalized) {
    throw new Error('PIN must not be empty');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(normalized, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPin(pin, storedHash) {
  if (typeof pin !== 'string' && typeof pin !== 'number') return false;
  if (typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = crypto.scryptSync(String(pin), salt, expectedBuf.length);
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
  if (typeof token !== 'string' || !token) {
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

  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) {
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
  constructor({ maxAttempts = 5, lockoutMs = 60000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.lockoutMs = lockoutMs;
    this.failedAttempts = 0;
    this.lockedUntil = 0;
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
    }
    return { locked: false, remainingMs: 0, retryAfterSec: 0 };
  }

  recordFailure(now = Date.now()) {
    const lock = this.checkLock(now);
    if (lock.locked) return lock;

    this.failedAttempts += 1;
    if (this.failedAttempts >= this.maxAttempts) {
      this.lockedUntil = now + this.lockoutMs;
      return {
        locked: true,
        remainingMs: this.lockoutMs,
        retryAfterSec: Math.ceil(this.lockoutMs / 1000),
        attemptsRemaining: 0
      };
    }

    return {
      locked: false,
      remainingMs: 0,
      retryAfterSec: 0,
      attemptsRemaining: this.maxAttempts - this.failedAttempts
    };
  }

  recordSuccess() {
    this.failedAttempts = 0;
    this.lockedUntil = 0;
  }
}

module.exports = {
  hashPin,
  verifyPin,
  signToken,
  verifyToken,
  PinAttemptGuard
};
