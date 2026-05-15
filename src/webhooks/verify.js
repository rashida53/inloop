const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Verify Zoom webhook HMAC-SHA256 signature.
 * Zoom provides the signature in the X-Zoom-Signature header as: v0=<hex>
 *
 * Message to sign format (as per Zoom API spec):
 * concatenate(ZOOM_VERIFICATION_TOKEN, timestamp, raw_request_body)
 *
 * Zoom signs this and returns the SHA256 hash in the X-Zoom-Signature header.
 * We must use crypto.timingSafeEqual to prevent timing attacks.
 *
 * @param {string|Buffer} rawBody - The raw request body as string/buffer (before JSON parsing)
 * @param {string} signature - The signature from X-Zoom-Signature header (e.g., "v0=abc123...")
 * @param {string} timestamp - The timestamp from the request body or header
 * @param {string} secret - The Zoom verification token from config
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

    // Calculate expected signature using HMAC-SHA256
    // Message format: token + timestamp + body
    const expectedSignatureHex = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}${bodyString}`)
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
 * Middleware to capture raw body for Zoom signature verification.
 * Must be placed BEFORE express.json() to capture the raw request stream.
 * Attaches req.rawBody (as Buffer) for downstream use.
 *
 * Usage:
 *   app.post('/webhooks/zoom', captureRawBody, zoomSignatureVerification, handleZoomWebhook);
 *
 * @returns {function} - Express middleware
 */
function captureRawBody(req, res, next) {
  req.rawBody = Buffer.alloc(0);

  req.on('data', (chunk) => {
    req.rawBody = Buffer.concat([req.rawBody, chunk]);
  });

  req.on('end', next);
  req.on('error', next);
}

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
      const timestamp = event.timestamp;
      const signature = req.get('X-Zoom-Signature');
      const rawBody = req.rawBody;

      if (!signature) {
        logger.warn({ timestamp }, 'Missing X-Zoom-Signature header');
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
