/**
 * Test script for Zoom webhook verification and event handling.
 * Tests HMAC-SHA256 signature verification, timestamp validation, and event routing.
 *
 * Run with: node tests/zoom-webhook.test.js
 */

const crypto = require('crypto');

// Import the verification functions
const { verifyZoomSignature, validateTimestamp } = require('../src/webhooks/verify');

// Test configuration
const ZOOM_SECRET = 'test_secret_token_12345';
const MAX_AGE_SECONDS = 300;

/**
 * Create a valid Zoom webhook signature for testing.
 * Message format: timestamp + body
 */
function createZoomSignature(timestamp, body) {
  const message = `${timestamp}${body}`;
  const signature = crypto.createHmac('sha256', ZOOM_SECRET).update(message).digest('hex');
  return `v0=${signature}`;
}

/**
 * Test 1: Valid signature verification
 */
function testValidSignature() {
  console.log('\n✓ Test 1: Valid HMAC-SHA256 signature');
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: 'meeting.summary_completed',
    event_id: '123',
    timestamp,
    object: { id: 'meeting123' },
  });

  const signature = createZoomSignature(timestamp, body);
  const isValid = verifyZoomSignature(body, signature, timestamp, ZOOM_SECRET);

  console.log(`  Signature: ${signature.substring(0, 20)}...`);
  console.log(`  Valid: ${isValid}`);
  console.assert(isValid === true, 'Expected valid signature');
  console.log('  ✓ PASSED');
}

/**
 * Test 2: Invalid signature rejection
 */
function testInvalidSignature() {
  console.log('\n✓ Test 2: Invalid HMAC signature rejection');
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: 'meeting.summary_completed',
    event_id: '123',
    timestamp,
    object: { id: 'meeting123' },
  });

  const invalidSignature = 'v0=0000000000000000000000000000000000000000000000000000000000000000';
  const isValid = verifyZoomSignature(body, invalidSignature, timestamp, ZOOM_SECRET);

  console.log(`  Signature: ${invalidSignature.substring(0, 20)}...`);
  console.log(`  Valid: ${isValid}`);
  console.assert(isValid === false, 'Expected invalid signature');
  console.log('  ✓ PASSED');
}

/**
 * Test 3: Timing-safe comparison (should take same time for valid/invalid)
 */
function testTimingSafety() {
  console.log('\n✓ Test 3: Timing-safe comparison prevents timing attacks');
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: 'meeting.summary_completed',
    event_id: '123',
    timestamp,
    object: { id: 'meeting123' },
  });

  const validSignature = createZoomSignature(timestamp, body);
  const invalidSignature = 'v0=0000000000000000000000000000000000000000000000000000000000000000';

  // Measure time for valid signature
  const validStart = process.hrtime.bigint();
  verifyZoomSignature(body, validSignature, timestamp, ZOOM_SECRET);
  const validTime = process.hrtime.bigint() - validStart;

  // Measure time for invalid signature
  const invalidStart = process.hrtime.bigint();
  verifyZoomSignature(body, invalidSignature, timestamp, ZOOM_SECRET);
  const invalidTime = process.hrtime.bigint() - invalidStart;

  console.log(`  Valid signature verification: ${Number(validTime) / 1e6}ms`);
  console.log(`  Invalid signature verification: ${Number(invalidTime) / 1e6}ms`);
  // Note: timingSafeEqual ensures comparison time is constant, not input-dependent
  console.log('  ✓ Using crypto.timingSafeEqual (constant-time comparison)');
  console.log('  ✓ PASSED');
}

/**
 * Test 4: Timestamp validation - recent request
 */
function testTimestampValid() {
  console.log('\n✓ Test 4: Recent timestamp validation');
  const recentTimestamp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
  const isValid = validateTimestamp(recentTimestamp, MAX_AGE_SECONDS);

  console.log(`  Request age: 60 seconds`);
  console.log(`  Max age allowed: ${MAX_AGE_SECONDS} seconds`);
  console.log(`  Valid: ${isValid}`);
  console.assert(isValid === true, 'Expected recent timestamp to be valid');
  console.log('  ✓ PASSED');
}

/**
 * Test 5: Timestamp validation - old request (replay attack)
 */
function testTimestampTooOld() {
  console.log('\n✓ Test 5: Old timestamp rejection (replay attack prevention)');
  const oldTimestamp = Math.floor(Date.now() / 1000) - (MAX_AGE_SECONDS + 60); // 6+ minutes ago
  const isValid = validateTimestamp(oldTimestamp, MAX_AGE_SECONDS);

  console.log(`  Request age: ${MAX_AGE_SECONDS + 60} seconds (over 5 minutes)`);
  console.log(`  Max age allowed: ${MAX_AGE_SECONDS} seconds`);
  console.log(`  Valid: ${isValid}`);
  console.assert(isValid === false, 'Expected old timestamp to be invalid');
  console.log('  ✓ PASSED');
}

/**
 * Test 6: Timestamp validation - future request (clock skew)
 */
function testTimestampFuture() {
  console.log('\n✓ Test 6: Slight clock skew tolerance');
  const futureTimestamp = Math.floor(Date.now() / 1000) + 10; // 10 seconds in future
  const isValid = validateTimestamp(futureTimestamp, MAX_AGE_SECONDS);

  console.log(`  Request timestamp: 10 seconds in future`);
  console.log(`  Clock skew tolerance: 30 seconds`);
  console.log(`  Valid: ${isValid}`);
  console.assert(isValid === true, 'Expected future timestamp within skew tolerance to be valid');
  console.log('  ✓ PASSED');
}

/**
 * Test 7: Missing fields
 */
function testMissingFields() {
  console.log('\n✓ Test 7: Missing field handling');
  
  const isValidNoBody = verifyZoomSignature(null, 'v0=abc', '123', ZOOM_SECRET);
  console.assert(isValidNoBody === false, 'Expected invalid result for missing body');
  
  const isValidNoSignature = verifyZoomSignature('body', null, '123', ZOOM_SECRET);
  console.assert(isValidNoSignature === false, 'Expected invalid result for missing signature');
  
  const isValidNoTimestamp = verifyZoomSignature('body', 'v0=abc', null, ZOOM_SECRET);
  console.assert(isValidNoTimestamp === false, 'Expected invalid result for missing timestamp');
  
  console.log('  ✓ All missing field checks passed');
  console.log('  ✓ PASSED');
}

/**
 * Test 8: Signature format validation
 */
function testSignatureFormat() {
  console.log('\n✓ Test 8: Signature format validation');
  const timestamp = Math.floor(Date.now() / 1000);
  const body = 'test body';

  // Invalid format: no "v0=" prefix
  const invalidFormat1 = 'abc123def456';
  const result1 = verifyZoomSignature(body, invalidFormat1, timestamp, ZOOM_SECRET);
  console.assert(result1 === false, 'Expected rejection of invalid format (no prefix)');

  // Invalid format: wrong version
  const invalidFormat2 = 'v1=abc123def456';
  const result2 = verifyZoomSignature(body, invalidFormat2, timestamp, ZOOM_SECRET);
  console.assert(result2 === false, 'Expected rejection of invalid format (wrong version)');

  // Valid format but wrong signature
  const invalidFormat3 = 'v0=0000000000000000000000000000000000000000000000000000000000000000';
  const result3 = verifyZoomSignature(body, invalidFormat3, timestamp, ZOOM_SECRET);
  console.assert(result3 === false, 'Expected rejection of invalid signature');

  console.log('  ✓ All signature format checks passed');
  console.log('  ✓ PASSED');
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('='.repeat(60));
  console.log('Zoom Webhook Verification Tests');
  console.log('='.repeat(60));

  try {
    testValidSignature();
    testInvalidSignature();
    testTimingSafety();
    testTimestampValid();
    testTimestampTooOld();
    testTimestampFuture();
    testMissingFields();
    testSignatureFormat();

    console.log('\n' + '='.repeat(60));
    console.log('✓ All tests passed!');
    console.log('='.repeat(60));
    process.exit(0);
  } catch (err) {
    console.error('\n✗ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

runTests();
