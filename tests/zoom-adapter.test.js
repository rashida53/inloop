/**
 * Test suite for Zoom adapter
 * Tests payload validation, field extraction, normalization, and edge cases
 *
 * Run with: node tests/zoom-adapter.test.js
 */

const {
  adaptZoomPayload,
  safeString,
  safeTimestamp,
  safeNumber,
  safeBoolean,
  normalizeAttendees,
  normalizeRecordings,
  EXAMPLE_ZOOM_PAYLOAD,
  EXAMPLE_MEETING_SUMMARY,
} = require('../src/adapters/zoom-adapter');

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAILED: ${message}`);
    testsFailed++;
  } else {
    testsPassed++;
  }
}

function test(name, fn) {
  console.log(`\n✓ ${name}`);
  try {
    fn();
  } catch (err) {
    console.error(`  ✗ Exception: ${err.message}`);
    console.error(err.stack);
    testsFailed++;
  }
}

// ============================================================================
// Helper Function Tests
// ============================================================================

console.log('='.repeat(70));
console.log('Zoom Adapter Test Suite');
console.log('='.repeat(70));

test('safeString: returns string value', () => {
  const result = safeString('  hello  ');
  assert(result === 'hello', 'should trim whitespace');
});

test('safeString: returns fallback for empty string', () => {
  const result = safeString('', 'default');
  assert(result === 'default', 'should return fallback for empty string');
});

test('safeString: returns fallback for null', () => {
  const result = safeString(null, 'default');
  assert(result === 'default', 'should return fallback for null');
});

test('safeString: returns fallback for non-string', () => {
  const result = safeString(123, 'default');
  assert(result === 'default', 'should return fallback for number');
});

test('safeNumber: parses string to number', () => {
  const result = safeNumber('42', 0);
  assert(result === 42, 'should parse string to number');
});

test('safeNumber: returns fallback for invalid number', () => {
  const result = safeNumber('abc', 0);
  assert(result === 0, 'should return fallback for invalid number');
});

test('safeNumber: returns fallback for negative number', () => {
  const result = safeNumber('-1', 0);
  assert(result === 0, 'should return fallback for negative number');
});

test('safeBoolean: parses true values', () => {
  assert(safeBoolean('true') === true, 'string "true" should be true');
  assert(safeBoolean(1) === true, 'number 1 should be true');
  assert(safeBoolean('1') === true, 'string "1" should be true');
  assert(safeBoolean(true) === true, 'boolean true should be true');
});

test('safeBoolean: parses false values', () => {
  assert(safeBoolean('false') === false, 'string "false" should be false');
  assert(safeBoolean(0) === false, 'number 0 should be false');
  assert(safeBoolean('0') === false, 'string "0" should be false');
  assert(safeBoolean(false) === false, 'boolean false should be false');
});

test('safeTimestamp: parses ISO 8601 timestamps', () => {
  const timestamp = '2026-05-15T14:00:00Z';
  const result = safeTimestamp(timestamp);
  assert(result !== null, 'should parse valid ISO timestamp');
  // Date.toISOString() adds .000Z, so compare the date values instead
  assert(result.getTime() === new Date(timestamp).getTime(), 'should preserve timestamp value');
});

test('safeTimestamp: returns null for invalid timestamp', () => {
  const result = safeTimestamp('invalid-date');
  assert(result === null, 'should return null for invalid timestamp');
});

test('safeTimestamp: returns null for empty timestamp', () => {
  const result = safeTimestamp('');
  assert(result === null, 'should return null for empty timestamp');
});

// ============================================================================
// Attendee Normalization Tests
// ============================================================================

test('normalizeAttendees: deduplicates by email', () => {
  const rawAttendees = [
    { name: 'Alice', user_email: 'alice@company.com' },
    { name: 'Alice Chen', user_email: 'alice@company.com' }, // Duplicate
  ];
  const { attendees, uniqueCount } = normalizeAttendees(rawAttendees, 'host@company.com');
  // Should have 2: Alice (deduplicated) + Host
  assert(uniqueCount === 2, 'should deduplicate to alice + host = 2');
  const aliceCount = attendees.filter(a => a.email === 'alice@company.com').length;
  assert(aliceCount === 1, 'should have only one alice after deduplication');
});

test('normalizeAttendees: marks host as isHost=true', () => {
  const rawAttendees = [
    { name: 'Alice', user_email: 'alice@company.com' },
    { name: 'Bob', user_email: 'bob@company.com' },
  ];
  const { attendees } = normalizeAttendees(rawAttendees, 'alice@company.com');
  const alice = attendees.find(a => a.email === 'alice@company.com');
  assert(alice.isHost === true, 'host should have isHost=true');
  const bob = attendees.find(a => a.email === 'bob@company.com');
  assert(bob.isHost === false, 'non-host should have isHost=false');
});

test('normalizeAttendees: calculates attendance duration', () => {
  const rawAttendees = [
    {
      name: 'Alice',
      user_email: 'alice@company.com',
      join_time: '2026-05-15T14:00:00Z',
      leave_time: '2026-05-15T15:30:00Z',
    },
  ];
  const { attendees } = normalizeAttendees(rawAttendees, 'alice@company.com');
  assert(attendees[0].durationMinutes === 90, 'should calculate 90 minute duration');
});

test('normalizeAttendees: handles missing attendees array', () => {
  const { attendees, uniqueCount } = normalizeAttendees(null, 'host@company.com');
  assert(Array.isArray(attendees), 'should return array for null');
  assert(uniqueCount === 1, 'should have 1 attendee (the host)');
  assert(attendees[0].email === 'host@company.com', 'host should be included');
});

test('normalizeAttendees: always includes host', () => {
  const rawAttendees = [
    { name: 'Bob', user_email: 'bob@company.com' },
  ];
  const { attendees } = normalizeAttendees(rawAttendees, 'alice@company.com');
  const alice = attendees.find(a => a.email === 'alice@company.com');
  assert(alice !== undefined, 'should include host even if not in attendee list');
});

// ============================================================================
// Recording Normalization Tests
// ============================================================================

test('normalizeRecordings: extracts download URLs', () => {
  const rawRecordings = [
    { download_url: 'https://zoom.us/download/rec1.m4a' },
  ];
  const { hasRecording, recordingUrls } = normalizeRecordings(rawRecordings);
  assert(hasRecording === true, 'should detect recording');
  assert(recordingUrls.includes('https://zoom.us/download/rec1.m4a'), 'should extract download URL');
});

test('normalizeRecordings: deduplicates URLs', () => {
  const rawRecordings = [
    {
      download_url: 'https://zoom.us/download/rec1.m4a',
      play_url: 'https://zoom.us/download/rec1.m4a', // Duplicate
    },
  ];
  const { recordingUrls } = normalizeRecordings(rawRecordings);
  assert(recordingUrls.length === 1, 'should deduplicate URLs');
});

test('normalizeRecordings: handles no recordings', () => {
  const { hasRecording, recordingUrls } = normalizeRecordings([]);
  assert(hasRecording === false, 'should return hasRecording=false for empty array');
  assert(recordingUrls.length === 0, 'should return empty URL array');
});

test('normalizeRecordings: handles null recordings', () => {
  const { hasRecording, recordingUrls } = normalizeRecordings(null);
  assert(hasRecording === false, 'should handle null recordings');
  assert(Array.isArray(recordingUrls), 'should return array');
});

// ============================================================================
// Main Adapter Tests
// ============================================================================

test('adaptZoomPayload: converts valid payload', () => {
  const result = adaptZoomPayload(EXAMPLE_ZOOM_PAYLOAD, 'event-123');
  assert(result !== null, 'should return non-null result');
  assert(result.zoomMeetingId === '12345678901', 'should extract meeting ID');
  assert(result.title === 'Q2 Planning Meeting', 'should extract title');
  assert(result.hostEmail === 'alice@company.com', 'should extract host email');
  assert(result.attendeeCount === 3, 'should count attendees');
  assert(result.source === 'zoom', 'should set source to "zoom"');
});

test('adaptZoomPayload: handles missing meeting ID', () => {
  const payload = { ...EXAMPLE_ZOOM_PAYLOAD, id: null, meeting_id: null };
  const result = adaptZoomPayload(payload, 'event-123');
  assert(result === null, 'should return null for missing meeting ID');
});

test('adaptZoomPayload: provides default title', () => {
  const payload = { ...EXAMPLE_ZOOM_PAYLOAD, topic: null };
  const result = adaptZoomPayload(payload, 'event-123');
  assert(result.title === 'Untitled Meeting', 'should provide default title');
});

test('adaptZoomPayload: records warnings for missing fields', () => {
  const payload = {
    ...EXAMPLE_ZOOM_PAYLOAD,
    host_email: null, // Missing required field
  };
  const result = adaptZoomPayload(payload, 'event-123');
  assert(Array.isArray(result.warnings), 'should have warnings array');
  assert(result.warnings.length > 0, 'should record warning for missing host email');
});

test('adaptZoomPayload: never exposes raw Zoom fields', () => {
  const result = adaptZoomPayload(EXAMPLE_ZOOM_PAYLOAD, 'event-123');
  assert(!result.hasOwnProperty('host_email'), 'should not expose raw host_email field');
  assert(!result.hasOwnProperty('topic'), 'should not expose raw topic field');
  assert(!result.hasOwnProperty('participants'), 'should not expose raw participants field');
  assert(!result.hasOwnProperty('recording_files'), 'should not expose raw recording_files field');
});

test('adaptZoomPayload: normalizes timestamps to ISO 8601', () => {
  const result = adaptZoomPayload(EXAMPLE_ZOOM_PAYLOAD, 'event-123');
  assert(typeof result.startTime === 'string', 'startTime should be string');
  assert(typeof result.endTime === 'string', 'endTime should be string');
  assert(result.extractedAt.includes('T'), 'extractedAt should be ISO format');
});

test('adaptZoomPayload: handles malformed payload gracefully', () => {
  const result = adaptZoomPayload('not an object', 'event-123');
  assert(result === null, 'should return null for non-object payload');
});

test('adaptZoomPayload: includes optional fields when present', () => {
  const payload = {
    ...EXAMPLE_ZOOM_PAYLOAD,
    key_points: ['Point 1', 'Point 2'],
    action_items: ['Task 1', 'Task 2'],
  };
  const result = adaptZoomPayload(payload, 'event-123');
  assert(Array.isArray(result.keyPoints), 'should include keyPoints');
  assert(result.keyPoints.length === 2, 'should have 2 key points');
  assert(Array.isArray(result.actionItems), 'should include actionItems');
});

test('adaptZoomPayload: omits optional fields when missing', () => {
  const payload = { ...EXAMPLE_ZOOM_PAYLOAD };
  delete payload.key_points;
  delete payload.action_items;
  const result = adaptZoomPayload(payload, 'event-123');
  assert(!result.hasOwnProperty('keyPoints'), 'should omit keyPoints when empty');
  assert(!result.hasOwnProperty('actionItems'), 'should omit actionItems when empty');
});

test('adaptZoomPayload: calculates duration from timestamps if missing', () => {
  const payload = {
    ...EXAMPLE_ZOOM_PAYLOAD,
    duration: null,
  };
  const result = adaptZoomPayload(payload, 'event-123');
  assert(result.durationMinutes === 90, 'should calculate duration from start/end times');
});

// ============================================================================
// Summary Report
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log(`Test Results: ${testsPassed} passed, ${testsFailed} failed`);
console.log('='.repeat(70));

if (testsFailed === 0) {
  console.log('✓ All tests passed!');
  process.exit(0);
} else {
  console.error(`✗ ${testsFailed} test(s) failed`);
  process.exit(1);
}
