'use strict';

const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPin,
  verifyPin,
  signToken,
  verifyToken,
  PinAttemptGuard,
  IpRateLimiter
} = require('../src/auth');

describe('auth module', () => {
  it('hashes and verifies PINs using scrypt', () => {
    const hash = hashPin('9876');
    assert.ok(hash.startsWith('scrypt:'));
    assert.equal(verifyPin('9876', hash), true);
    assert.equal(verifyPin('0000', hash), false);
    assert.equal(verifyPin('9876', 'malformed'), false);
  });

  it('locks after 5 consecutive failures and resets after lockout or success', () => {
    const guard = new PinAttemptGuard({ maxAttempts: 5, lockoutMs: 60000 });
    let t = 1000000;

    for (let i = 1; i <= 4; i++) {
      const res = guard.recordFailure(t);
      assert.equal(res.locked, false);
      assert.equal(res.attemptsRemaining, 5 - i);
    }

    const fifth = guard.recordFailure(t);
    assert.equal(fifth.locked, true);
    assert.equal(fifth.retryAfterSec, 60);

    // Still locked 30s later
    const mid = guard.checkLock(t + 30000);
    assert.equal(mid.locked, true);
    assert.equal(mid.retryAfterSec, 30);

    // Unlocked after 60s
    const after = guard.checkLock(t + 60000);
    assert.equal(after.locked, false);

    guard.recordFailure(t + 60001);
    guard.recordSuccess();
    assert.equal(guard.failedAttempts, 0);
  });

  it('signs and verifies HMAC tokens and enforces token version & expiry', () => {
    const secret = 'test-secret-key-0123456789abcdef';
    const { token } = signToken({ scope: 'admin', deviceId: null, ver: 1 }, secret, 60);

    const ok = verifyToken(token, secret, 1);
    assert.equal(ok.valid, true);
    assert.equal(ok.claims.scope, 'admin');

    const revoked = verifyToken(token, secret, 2);
    assert.equal(revoked.valid, false);
    assert.equal(revoked.reason, 'revoked_token');

    const wrongSecret = verifyToken(token, 'other-secret', 1);
    assert.equal(wrongSecret.valid, false);
    assert.equal(wrongSecret.reason, 'invalid_signature');

    const expired = signToken({ scope: 'control', ver: 1 }, secret, -5);
    const expCheck = verifyToken(expired.token, secret, 1);
    assert.equal(expCheck.valid, false);
    assert.equal(expCheck.reason, 'expired_token');
  });

  it('rejects oversized PINs, non-object JWT claims, and tampered alg headers', () => {
    const hash = hashPin('1234');
    assert.equal(verifyPin('1'.repeat(65), hash), false);
    assert.throws(() => hashPin('x'.repeat(65)));

    const secret = 'test-secret-key-0123456789abcdef';
    const b64 = (s) =>
      Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signRaw = (hdr, body) => {
      const input = `${b64(JSON.stringify(hdr))}.${b64(JSON.stringify(body))}`;
      const sig = crypto
        .createHmac('sha256', secret)
        .update(input)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      return `${input}.${sig}`;
    };

    const nullClaims = signRaw({ alg: 'HS256', typ: 'JWT' }, null);
    assert.equal(verifyToken(nullClaims, secret, 1).valid, false);

    const wrongAlg = signRaw({ alg: 'none', typ: 'JWT' }, { exp: 9999999999, ver: 1 });
    assert.equal(verifyToken(wrongAlg, secret, 1).valid, false);
  });

  it('persists PinAttemptGuard state across store reloads and enforces IpRateLimiter', () => {
    let persisted = { failedAttempts: 0, lockedUntil: 0 };
    const store = {
      load: () => persisted,
      save: (next) => {
        persisted = next;
      }
    };
    const guard1 = new PinAttemptGuard({ maxAttempts: 5, lockoutMs: 60000, store });
    for (let i = 0; i < 5; i++) guard1.recordFailure(1000);

    // Reload new guard simulating server restart
    const guard2 = new PinAttemptGuard({ maxAttempts: 5, lockoutMs: 60000, store });
    assert.equal(guard2.checkLock(2000).locked, true);

    const limiter = new IpRateLimiter({ maxRequests: 2, windowMs: 10000 });
    assert.equal(limiter.consume('1.2.3.4', 100).allowed, true);
    assert.equal(limiter.consume('1.2.3.4', 200).allowed, true);
    assert.equal(limiter.consume('1.2.3.4', 300).allowed, false);
    assert.equal(limiter.consume('5.6.7.8', 300).allowed, true);
    assert.equal(limiter.consume('1.2.3.4', 11000).allowed, true);
  });
});
