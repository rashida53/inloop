const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Verify Zoom webhook HMAC-SHA256 signature.
 *
 * Real Zoom webhooks send the signature in the `x-zm-signature` header
 * (note: NOT `X-Zoom-Signature`) with format `v0=<hex>`. The timestamp
 * is in a separate `x-zm-request-timestamp` header (NOT in the body).
 *
 * The message to sign is the literal string `v0:{timestamp}:{body}` —
 * with colons and the `v0:` prefix — NOT `{timestamp}{body}`.
 *
 * Reference: https://developers.zoom.us/docs/api/webhooks/#validate-the-webhook-event
 *
 * @param {string|Buffer} rawBody - The raw request body as string/buffer (before JSON parsing)
 * @param {string} signature - From `x-zm-signature` header, e.g. "v0=abc123..."
 * @param {string|number} timestamp - From `x-zm-request-timestamp` header (Unix seconds)
 * @param {string} secret - ZOOM_VERIFICATION_TOKEN (Secret Token from app's Event Subscriptions)
 * @returns {boolean} - True if signature is valid, false otherwise
 */
function verifyZoomSignature(rawBody, signature, timestamp, secret) {
  if (!rawBody || !signature || !timestamp || !secret) {
    logger.warn({ hasRawBody: !!rawBody, hasSignature: !!signature, hasTimestamp: !!timestamp, hasSecret: !!secret },
      'Missing required fields for signature verification');
    return false;
  }

  try {
    // Extract version and hash from header format "v0=<hash>"
    const parts = signature.split('=');
    if (parts.length !== 2 || parts[0] !== 'v0') {
      logger.warn({ signature }, 'Invalid signature format; expected v0=<hash>');
      return false;
    }

    const providedSignatureHex = parts[1];

    // Convert raw body to string if it's a buffer
    const bodyString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

    // Zoom's signed message format: `v0:{timestamp}:{body}`
    const message = `v0:${timestamp}:${bodyString}`;
    const expectedSignatureHex = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    // Both strings must be the same length; if not, return false immediately
    if (providedSignatureHex.length !== expectedSignatureHex.length) {
      logger.warn({ providedLength: providedSignatureHex.length, expectedLength: expectedSignatureHex.length },
        'Signature length mismatch');
      return false;
    }

    const providedBuffer = Buffer.from(providedSignatureHex, 'hex');
    const expectedBuffer = Buffer.from(expectedSignatureHex, 'hex');

    // timingSafeEqual throws if lengths differ, so we already checked above
    const isValid = crypto.timingSafeEqual(providedBuffer, expectedBuffer);
    
    if (isValid) {
      logger.debug({ timestamp }, 'Zoom webhook signature verified successfully');
    } else {
      logger.warn({ providedLength: providedBuffer.length, expectedLength: expectedBuffer.length },
        'Zoom webhook signature verification failed');
    }

    return isValid;
  } catch (err) {
    logger.error({ err, message: err.message }, 'Error during signature verification');
    return false;
  }
}

/**
 * Validate that the webhook request is not too old.
 * Zoom includes a timestamp in the request; we reject anything older than MAX_AGE_SECONDS
 * to prevent replay attacks.
 *
 * Zoom timestamp format: Unix timestamp in seconds (or milliseconds, depending on API version)
 * Current Zoom webhooks use seconds.
 *
 * @param {number} requestTimestamp - Unix timestamp (in seconds) from the Zoom event
 * @param {number} maxAgeSeconds - Maximum age allowed (default 300 = 5 minutes)
 * @returns {boolean} - True if request is within acceptable age, false otherwise
 */
function validateTimestamp(requestTimestamp, maxAgeSeconds = 300) {
  if (!requestTimestamp) {
    logger.warn('Request timestamp missing');
    return false;
  }

  const now = Math.floor(Date.now() / 1000); // Current time in seconds
  const ageSeconds = now - requestTimestamp;

  // Allow slight clock skew (both past and future)
  const maxSkewSeconds = 30;

  if (ageSeconds < -maxSkewSeconds) {
    logger.warn({ ageSeconds, maxSkewSeconds }, 'Request timestamp is in the future; possible clock skew');
    return false;
  }

  if (ageSeconds > maxAgeSeconds) {
    logger.warn({ ageSeconds, maxAgeSeconds }, 'Request timestamp is too old; possible replay attack');
    return false;
  }

  logger.debug({ ageSeconds }, 'Timestamp validated');
  return true;
}

/**
 * JSON-parsing middleware that also exposes the raw body as `req.rawBody`.
 *
 * Uses body-parser's `verify` callback to grab the raw bytes during the
 * single parse pass — both `req.body` (parsed) and `req.rawBody` (Buffer)
 * are populated for downstream signature verification.
 *
 * This replaces the prior implementation that attached its own `data`
 * listener; that approach consumed the request stream before
 * `express.json()` could read it, producing `stream is not readable`
 * on every webhook.
 *
 * Usage (in index.js):
 *   app.post('/webhooks/zoom', captureRawBody, signatureVerifier, zoomRouter);
 *
 * (No separate `express.json()` needed in the chain — this middleware
 * does both raw capture and JSON parsing.)
 */
const express = require('express');
const captureRawBody = express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
});

/**
 * Middleware factory for Zoom webhook signature verification.
 * Must be placed AFTER express.json() so req.body is available.
 *
 * Usage:
 *   const verifyZoom = createZoomSignatureVerification(config.zoomVerificationToken);
 *   app.post('/webhooks/zoom', captureRawBody, express.json(), verifyZoom, handleZoomWebhook);
 *
 * @param {string} secret - The Zoom verification token from config
 * @param {number} maxAgeSeconds - Max age of requests (default 300 = 5 minutes)
 * @returns {function} - Express middleware
 */
function createZoomSignatureVerification(secret, maxAgeSeconds = 300) {
  return (req, res, next) => {
    try {
      const event = req.body || {};

      // Endpoint URL validation uses CRC (challenge-response over HMAC of a
      // server-supplied plainToken) instead of the X-Zoom-Signature header
      // mechanism that signs regular events. Skip header signature checks
      // here and let the url_validation handler in zoom.js perform its own
      // HMAC computation against the secret.
      if (event.event === 'endpoint.url_validation') {
        logger.debug('Bypassing signature verification for endpoint.url_validation (handler does its own CRC)');
        return next();
      }

      // Real Zoom uses `x-zm-signature` + `x-zm-request-timestamp` headers
      // (lowercase, zm = Zoom Meeting). Express's req.get() is case-insensitive
      // for header lookup, but we use the canonical name here for clarity.
      // The body's `timestamp` field is informational and not used for signing.
      const signature = req.get('x-zm-signature');
      const timestampHeader = req.get('x-zm-request-timestamp');
      const timestamp = timestampHeader ? Number(timestampHeader) : null;
      const rawBody = req.rawBody;

      if (!signature) {
        logger.warn({ timestampHeader }, 'Missing x-zm-signature header');
        return res.status(401).json({ ok: false, message: 'Missing signature' });
      }

      if (!rawBody) {
        logger.warn({ timestamp }, 'Missing raw body');
        return res.status(400).json({ ok: false, message: 'Invalid request' });
      }

      // Validate timestamp first (cheap operation)
      if (!validateTimestamp(timestamp, maxAgeSeconds)) {
        logger.warn({ timestamp, signature: signature.substring(0, 10) }, 'Timestamp validation failed');
        return res.status(401).json({ ok: false, message: 'Timestamp too old' });
      }

      // Verify HMAC signature (timing-safe)
      if (!verifyZoomSignature(rawBody, signature, timestamp, secret)) {
        logger.warn({ timestamp }, 'Signature verification failed; rejecting webhook');
        return res.status(401).json({ ok: false, message: 'Invalid signature' });
      }

      logger.debug({ timestamp, signature: signature.substring(0, 10) }, 'Zoom webhook verified');
      next();
    } catch (err) {
      logger.error({ err, message: err.message }, 'Error verifying Zoom webhook');
      return res.status(500).json({ ok: false, message: 'Internal error' });
    }
  };
}

module.exports = {
  verifyZoomSignature,
  validateTimestamp,
  captureRawBody,
  createZoomSignatureVerification,
};
