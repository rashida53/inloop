const crypto = require('crypto');
const { verifyZoomSignature, validateTimestamp } = require('../../src/webhooks/verify');

const SECRET = 'test_secret_token_12345';

function signZoomBody(timestamp, body, secret = SECRET) {
  // Match Zoom's canonical signing format: `v0:{timestamp}:{body}` with
  // colons. Tests previously used `{timestamp}{body}` (no colons) which
  // happened to validate against our buggy verifier but didn't match
  // what real Zoom sends. Tests are now real-Zoom-compatible.
  const message = `v0:${timestamp}:${body}`;
  const mac = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return `v0=${mac}`;
}

describe('verifyZoomSignature', () => {
  test('accepts a correctly signed body', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ event: 'meeting.summary_completed', event_id: '123', timestamp });
    const sig = signZoomBody(timestamp, body);

    expect(verifyZoomSignature(body, sig, timestamp, SECRET)).toBe(true);
  });

  test('rejects a forged signature with the right format', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = 'whatever';
    const forged = `v0=${'0'.repeat(64)}`;

    expect(verifyZoomSignature(body, forged, timestamp, SECRET)).toBe(false);
  });

  test('rejects signatures with the wrong version prefix', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = 'test';
    expect(verifyZoomSignature(body, 'v1=abc123', timestamp, SECRET)).toBe(false);
  });

  test('rejects signatures with no version prefix at all', () => {
    expect(verifyZoomSignature('test', 'abc123nopre', 123, SECRET)).toBe(false);
  });

  test('returns false when any required input is missing', () => {
    expect(verifyZoomSignature(null, 'v0=abc', '123', SECRET)).toBe(false);
    expect(verifyZoomSignature('body', null, '123', SECRET)).toBe(false);
    expect(verifyZoomSignature('body', 'v0=abc', null, SECRET)).toBe(false);
    expect(verifyZoomSignature('body', 'v0=abc', '123', null)).toBe(false);
  });
});

describe('validateTimestamp', () => {
  test('accepts a request from 1 minute ago', () => {
    const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60;
    expect(validateTimestamp(oneMinuteAgo, 300)).toBe(true);
  });

  test('rejects a request older than maxAge (replay attack)', () => {
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 360;
    expect(validateTimestamp(sixMinutesAgo, 300)).toBe(false);
  });

  test('tolerates a small clock-skew into the future', () => {
    const tenSecondsAhead = Math.floor(Date.now() / 1000) + 10;
    expect(validateTimestamp(tenSecondsAhead, 300)).toBe(true);
  });

  test('rejects timestamps too far in the future (beyond skew tolerance)', () => {
    const oneMinuteAhead = Math.floor(Date.now() / 1000) + 60;
    expect(validateTimestamp(oneMinuteAhead, 300)).toBe(false);
  });

  test('rejects a missing timestamp', () => {
    expect(validateTimestamp(undefined, 300)).toBe(false);
    expect(validateTimestamp(null, 300)).toBe(false);
    expect(validateTimestamp(0, 300)).toBe(false);
  });
});
