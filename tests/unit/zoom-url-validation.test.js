/**
 * End-to-end test of the Zoom URL validation flow:
 *   1. The signature-verification middleware must bypass url_validation
 *      events (they don't carry X-Zoom-Signature).
 *   2. The handler must compute HMAC-SHA256(plainToken, secret) and return
 *      { plainToken, encryptedToken } so Zoom can finish the CRC handshake.
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// Stub the orchestrator so requiring the zoom router doesn't try to wire
// up its full dependency graph (db, integrations, etc.) for this test.
jest.mock('../../src/server', () => ({ processMeeting: jest.fn() }));

const { captureRawBody, createZoomSignatureVerification } = require('../../src/webhooks/verify');
const zoomRouter = require('../../src/webhooks/zoom');

// The handler reads config.zoomVerificationToken — same value setup.js seeds.
const SECRET = 'test-zoom-token';

function buildApp() {
  const app = express();
  // Mirror the production mount in src/index.js — app.use, not app.post.
  app.use(
    '/webhooks/zoom',
    captureRawBody, // parses JSON AND exposes req.rawBody in one pass
    createZoomSignatureVerification(SECRET),
    zoomRouter
  );
  return app;
}

describe('Zoom endpoint.url_validation CRC flow', () => {
  test('responds with { plainToken, encryptedToken } where encryptedToken is HMAC-SHA256(plainToken, secret)', async () => {
    const app = buildApp();
    const plainToken = 'qgg8vlvZRS6UYooatFL8Aw';

    const res = await request(app)
      .post('/webhooks/zoom')
      .send({ event: 'endpoint.url_validation', payload: { plainToken } })
      .expect(200);

    const expected = crypto.createHmac('sha256', SECRET).update(plainToken).digest('hex');
    expect(res.body.plainToken).toBe(plainToken);
    expect(res.body.encryptedToken).toBe(expected);
    expect(res.body.encryptedToken).toMatch(/^[a-f0-9]{64}$/);
  });

  test('returns 400 when payload has no plainToken (or legacy validationToken)', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/webhooks/zoom')
      .send({ event: 'endpoint.url_validation', payload: {} })
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/challenge token/i);
  });

  test('accepts the legacy validationToken field shape as a fallback', async () => {
    const app = buildApp();
    const token = 'legacy-token-shape';

    const res = await request(app)
      .post('/webhooks/zoom')
      .send({ event: 'endpoint.url_validation', payload: { validationToken: token } })
      .expect(200);

    expect(res.body.plainToken).toBe(token);
    expect(res.body.encryptedToken).toBe(
      crypto.createHmac('sha256', SECRET).update(token).digest('hex')
    );
  });

  test('url_validation requests bypass the X-Zoom-Signature header check (no header sent)', async () => {
    const app = buildApp();

    // No X-Zoom-Signature header set — this would 401 for a regular event
    const res = await request(app)
      .post('/webhooks/zoom')
      .send({ event: 'endpoint.url_validation', payload: { plainToken: 'abc' } });

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });
});
