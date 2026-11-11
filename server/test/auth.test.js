'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPin,
  verifyPin,
  signToken,
  verifyToken,
  PinAttemptGuard
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
});
