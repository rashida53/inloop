/**
 * Zoom Webhook Payload Adapter
 *
 * Converts raw Zoom webhook event payloads into a normalized, validated
 * internal MeetingSummary object. This adapter acts as a boundary layer
 * to prevent downstream code from depending on Zoom's API structure.
 *
 * Philosophy:
 * - Validate once at the entry point
 * - Normalize field names and structures
 * - Never expose raw Zoom fields downstream
 * - Provide safe defaults for missing data
 * - Log all data quality issues for monitoring
 */

const logger = require('../utils/logger');

// ============================================================================
// JSDoc Type Definitions
// ============================================================================

/**
 * @typedef {Object} Attendee
 * @property {string} email - Attendee email address
 * @property {string} name - Attendee full name
 * @property {boolean} isHost - True if this is the meeting host
 * @property {number} [joinTime] - Unix timestamp when attendee joined
 * @property {number} [leaveTime] - Unix timestamp when attendee left
 * @property {number} [durationMinutes] - Duration of attendance in minutes
 */

/**
 * @typedef {Object} MeetingSummary
 * @property {string} zoomMeetingId - Zoom meeting ID (unique)
 * @property {string} title - Meeting title/topic
 * @property {string} hostEmail - Host email address
 * @property {string} [hostName] - Host full name
 * @property {number} startTime - ISO 8601 timestamp when meeting started
 * @property {number} endTime - ISO 8601 timestamp when meeting ended
 * @property {number} durationMinutes - Total duration in minutes
 * @property {Attendee[]} attendees - List of attendees
 * @property {number} attendeeCount - Total number of unique attendees
 * @property {boolean} hasRecording - Whether meeting was recorded
 * @property {string[]} [recordingUrls] - URLs to recording files if available
 * @property {string} [summary] - AI-generated or manual meeting summary
 * @property {string[]} [keyPoints] - Key discussion points
 * @property {string[]} [actionItems] - Action items identified in meeting
 * @property {string[]} [decisions] - Decisions made during meeting
 * @property {Object} [metadata] - Additional metadata (department, project, etc.)
 * @property {string} source - Always "zoom" for this adapter
 * @property {number} extractedAt - ISO 8601 timestamp when this summary was created
 * @property {string[]} [warnings] - Data quality warnings (missing fields, malformed data)
 */

/**
 * @typedef {Object} RawZoomPayload
 * @property {string} id - Zoom meeting ID
 * @property {string} [meeting_id] - Alternative field for meeting ID
 * @property {string} [topic] - Meeting title
 * @property {string} [subject] - Alternative field for title
 * @property {string} host_email - Host email
 * @property {string} [host_name] - Host name
 * @property {string} start_time - Start time ISO string
 * @property {string} end_time - End time ISO string
 * @property {number} duration - Duration in minutes
 * @property {Array} [participants] - List of attendees
 * @property {boolean} [has_recording] - Whether meeting was recorded
 * @property {Array} [recording_files] - Recording metadata
 */

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Safely extract a string field with fallback.
 * Returns trimmed string or fallback value if field is missing/invalid.
 *
 * @param {*} value - The value to extract
 * @param {string} [fallback=''] - Fallback value if extraction fails
 * @param {string} [fieldName='field'] - Field name for logging
 * @returns {string} - Extracted/fallback value
 */
function safeString(value, fallback = '', fieldName = 'field') {
  try {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    // Real Zoom sends numeric meeting IDs (e.g. id: 3293123694). Coerce
    // finite numbers to their decimal string so we don't lose them.
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    return fallback;
  } catch (err) {
    logger.warn({ fieldName, value, err: err.message }, 'Error extracting string field');
    return fallback;
  }
}

/**
 * Safely parse ISO 8601 timestamp.
 * Returns Date object or null if parsing fails.
 *
 * @param {*} value - ISO 8601 timestamp string
 * @param {string} [fieldName='timestamp'] - Field name for logging
 * @returns {Date|null} - Parsed date or null
 */
function safeTimestamp(value, fieldName = 'timestamp') {
  try {
    if (!value) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      logger.warn({ fieldName, value }, 'Invalid timestamp format');
      return null;
    }
    return date;
  } catch (err) {
    logger.warn({ fieldName, value, err: err.message }, 'Error parsing timestamp');
    return null;
  }
}

/**
 * Safely extract a number field.
 * Returns number or fallback if extraction fails.
 *
 * @param {*} value - The value to extract
 * @param {number} [fallback=0] - Fallback value
 * @param {string} [fieldName='field'] - Field name for logging
 * @returns {number} - Extracted/fallback value
 */
function safeNumber(value, fallback = 0, fieldName = 'field') {
  try {
    const num = Number(value);
    if (!isNaN(num) && num >= 0) {
      return num;
    }
    return fallback;
  } catch (err) {
    logger.warn({ fieldName, value, err: err.message }, 'Error extracting number field');
    return fallback;
  }
}

/**
 * Safely extract a boolean field.
 *
 * @param {*} value - The value to extract
 * @param {boolean} [fallback=false] - Fallback value
 * @param {string} [fieldName='field'] - Field name for logging
 * @returns {boolean} - Extracted/fallback value
 */
function safeBoolean(value, fallback = false, fieldName = 'field') {
  try {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1' || value === 1) return true;
    if (value === 'false' || value === '0' || value === 0) return false;
    return fallback;
  } catch (err) {
    logger.warn({ fieldName, value, err: err.message }, 'Error extracting boolean field');
    return fallback;
  }
}

/**
 * Validate that required fields are present.
 * Logs warnings for missing fields.
 *
 * @param {Object} payload - Payload to validate
 * @param {string[]} requiredFields - List of required field names
 * @returns {string[]} - Array of warning messages for missing fields
 */
function validateRequired(payload, requiredFields) {
  const warnings = [];
  for (const field of requiredFields) {
    if (!payload[field]) {
      const msg = `Missing required field: ${field}`;
      logger.warn({ field }, msg);
      warnings.push(msg);
    }
  }
  return warnings;
}

// ============================================================================
// Attendee Normalization
// ============================================================================

/**
 * Normalize a single attendee record.
 * Extracts email, name, join/leave times, and calculates duration.
 *
 * @param {Object} attendee - Raw Zoom attendee object
 * @param {string} hostEmail - Host email for comparison
 * @returns {Attendee} - Normalized attendee
 */
function normalizeAttendee(attendee, hostEmail) {
  if (!attendee || typeof attendee !== 'object') {
    logger.warn({ attendee }, 'Malformed attendee record');
    return null;
  }

  const email = safeString(attendee.email || attendee.user_email, '', 'attendee.email');
  const name = safeString(attendee.name || attendee.user_name, 'Unknown', 'attendee.name');
  const joinTime = safeTimestamp(attendee.join_time, 'attendee.join_time');
  const leaveTime = safeTimestamp(attendee.leave_time, 'attendee.leave_time');

  // Calculate duration in minutes if both join and leave times present
  let durationMinutes = null;
  if (joinTime && leaveTime) {
    durationMinutes = Math.round((leaveTime - joinTime) / (1000 * 60));
  }

  return {
    email: email || `attendee-${Math.random().toString(36).substr(2, 9)}`,
    name,
    isHost: email === hostEmail,
    ...(joinTime && { joinTime: joinTime.toISOString() }),
    ...(leaveTime && { leaveTime: leaveTime.toISOString() }),
    ...(durationMinutes !== null && { durationMinutes }),
  };
}

/**
 * Normalize attendee list from raw Zoom payload.
 * Deduplicates by email, filters out null/invalid entries.
 *
 * @param {Array} rawAttendees - Raw attendee array from Zoom
 * @param {string} hostEmail - Host email
 * @returns {Object} - { attendees: Attendee[], uniqueCount: number }
 */
function normalizeAttendees(rawAttendees, hostEmail) {
  const attendeeMap = new Map();

  // Process attendees if array is provided
  if (Array.isArray(rawAttendees)) {
    for (const rawAttendee of rawAttendees) {
      try {
        const attendee = normalizeAttendee(rawAttendee, hostEmail);
        if (attendee && attendee.email) {
          attendeeMap.set(attendee.email, attendee);
        }
      } catch (err) {
        logger.warn({ err: err.message, rawAttendee }, 'Error normalizing attendee');
      }
    }
  } else if (rawAttendees !== null && rawAttendees !== undefined) {
    logger.warn({ rawAttendees }, 'Attendees field is not an array');
  }

  // Always include host if not already present
  if (hostEmail && !attendeeMap.has(hostEmail)) {
    attendeeMap.set(hostEmail, {
      email: hostEmail,
      name: 'Meeting Host',
      isHost: true,
    });
  }

  const attendees = Array.from(attendeeMap.values());
  return { attendees, uniqueCount: attendees.length };
}

// ============================================================================
// Recording Normalization
// ============================================================================

/**
 * Normalize recording metadata.
 * Extracts download URLs and file types.
 *
 * @param {Array} rawRecordings - Raw recording_files array from Zoom
 * @returns {Object} - { hasRecording: boolean, recordingUrls: string[] }
 */
function normalizeRecordings(rawRecordings) {
  const recordingUrls = [];

  if (!Array.isArray(rawRecordings)) {
    return { hasRecording: false, recordingUrls: [] };
  }

  for (const recording of rawRecordings) {
    try {
      if (recording && recording.download_url) {
        recordingUrls.push(safeString(recording.download_url, '', 'recording.download_url'));
      }
      if (recording && recording.play_url) {
        recordingUrls.push(safeString(recording.play_url, '', 'recording.play_url'));
      }
    } catch (err) {
      logger.warn({ err: err.message, recording }, 'Error extracting recording URL');
    }
  }

  return {
    hasRecording: recordingUrls.length > 0,
    recordingUrls: [...new Set(recordingUrls)], // Deduplicate URLs
  };
}

// ============================================================================
// Main Adapter Function
// ============================================================================

/**
 * Convert a raw Zoom meeting.summary_completed webhook payload
 * into a normalized MeetingSummary object.
 *
 * This is the main entry point for the adapter. It validates the payload,
 * extracts and normalizes all fields, and returns an internal representation
 * that downstream code can safely depend on.
 *
 * @param {RawZoomPayload} rawPayload - Raw Zoom webhook payload (payload.object from event)
 * @param {string} eventId - Zoom event_id for tracking
 * @returns {MeetingSummary|null} - Normalized meeting summary or null if validation fails
 */
function adaptZoomPayload(rawPayload, eventId) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    logger.error({ rawPayload }, 'Invalid Zoom payload type');
    return null;
  }

  const warnings = [];

  // Extract and validate required fields
  const zoomMeetingId = safeString(
    rawPayload.id || rawPayload.meeting_id,
    '',
    'meetingId'
  );
  if (!zoomMeetingId) {
    logger.error({ payload: rawPayload }, 'Missing meeting ID in Zoom payload');
    return null;
  }

  const hostEmail = safeString(
    rawPayload.host_email,
    '',
    'hostEmail'
  );
  if (!hostEmail) {
    const msg = `Meeting ${zoomMeetingId}: missing host email`;
    logger.warn(msg);
    warnings.push(msg);
  }

  // Extract timestamps
  const startTime = safeTimestamp(rawPayload.start_time, 'startTime');
  const endTime = safeTimestamp(rawPayload.end_time, 'endTime');

  if (!startTime || !endTime) {
    const msg = `Meeting ${zoomMeetingId}: missing or invalid timestamps`;
    logger.warn(msg);
    warnings.push(msg);
  }

  // Calculate duration
  let durationMinutes = safeNumber(rawPayload.duration, 0, 'duration');
  if (!durationMinutes && startTime && endTime) {
    durationMinutes = Math.round((endTime - startTime) / (1000 * 60));
  }

  // Extract title
  const title = safeString(
    rawPayload.topic || rawPayload.subject || rawPayload.title,
    'Untitled Meeting',
    'title'
  );

  // Normalize attendees
  const { attendees, uniqueCount } = normalizeAttendees(
    rawPayload.participants,
    hostEmail
  );

  // Normalize recordings
  const { hasRecording, recordingUrls } = normalizeRecordings(
    rawPayload.recording_files || rawPayload.recordings
  );

  // Assemble the meeting body for downstream extraction. Zoom AI Companion
  // delivers two fields on meeting.summary_completed:
  //   - summary_overview: a short narrative recap
  //   - summary_details:  an array of { label, summary } sections (e.g.
  //                       "Discussion", "Decisions", "Next steps")
  //
  // We concatenate them with section headers into a single text blob the
  // extraction layer feeds to Claude. Falls back to a legacy `summary`
  // field if neither AI Companion field is present, so the adapter still
  // works against payloads from non-AI workspaces or test fixtures.
  const summaryParts = [];
  const summaryOverview = safeString(rawPayload.summary_overview, '', 'summary_overview');
  if (summaryOverview) {
    summaryParts.push(`Overview:\n${summaryOverview}`);
  }
  if (Array.isArray(rawPayload.summary_details)) {
    for (const section of rawPayload.summary_details) {
      const label = safeString(section?.label, 'Section', 'summary_section_label');
      const content = safeString(section?.summary, '', 'summary_section_content');
      if (content) {
        summaryParts.push(`${label}:\n${content}`);
      }
    }
  }
  if (!summaryParts.length) {
    const legacySummary = safeString(rawPayload.summary, '', 'summary');
    if (legacySummary) {
      summaryParts.push(legacySummary);
    }
  }
  const summary = summaryParts.join('\n\n');
  const keyPoints = Array.isArray(rawPayload.key_points)
    ? rawPayload.key_points.map(p => safeString(p))
    : [];
  const actionItems = Array.isArray(rawPayload.action_items)
    ? rawPayload.action_items.map(a => safeString(a))
    : [];
  const decisions = Array.isArray(rawPayload.decisions)
    ? rawPayload.decisions.map(d => safeString(d))
    : [];

  // Build internal representation
  const meetingSummary = {
    zoomMeetingId,
    title,
    hostEmail,
    hostName: safeString(rawPayload.host_name || rawPayload.host, '', 'hostName'),
    startTime: startTime ? startTime.toISOString() : new Date().toISOString(),
    endTime: endTime ? endTime.toISOString() : new Date().toISOString(),
    durationMinutes,
    attendees,
    attendeeCount: uniqueCount,
    hasRecording,
    source: 'zoom',
    extractedAt: new Date().toISOString(),
    warnings,
  };

  // Add optional fields only if present
  if (recordingUrls.length > 0) {
    meetingSummary.recordingUrls = recordingUrls;
  }
  if (summary) {
    meetingSummary.summary = summary;
  }
  if (keyPoints.length > 0) {
    meetingSummary.keyPoints = keyPoints;
  }
  if (actionItems.length > 0) {
    meetingSummary.actionItems = actionItems;
  }
  if (decisions.length > 0) {
    meetingSummary.decisions = decisions;
  }

  // Add metadata if present
  const metadata = {};
  if (rawPayload.department) metadata.department = safeString(rawPayload.department);
  if (rawPayload.project) metadata.project = safeString(rawPayload.project);
  if (rawPayload.custom_fields) metadata.customFields = rawPayload.custom_fields;
  if (Object.keys(metadata).length > 0) {
    meetingSummary.metadata = metadata;
  }

  logger.info({
    zoomMeetingId,
    title,
    attendeeCount: uniqueCount,
    hasRecording,
    warnings: warnings.length,
    eventId,
  }, 'Zoom payload adapted successfully');

  return meetingSummary;
}

// ============================================================================
// Example Usage & Testing
// ============================================================================

/**
 * Example Zoom webhook payload (from meeting.summary_completed event)
 */
const EXAMPLE_ZOOM_PAYLOAD = {
  id: '12345678901',
  topic: 'Q2 Planning Meeting',
  host_email: 'alice@company.com',
  host_name: 'Alice Chen',
  start_time: '2026-05-15T14:00:00Z',
  end_time: '2026-05-15T15:30:00Z',
  duration: 90,
  participants: [
    {
      name: 'Alice Chen',
      user_email: 'alice@company.com',
      join_time: '2026-05-15T14:00:00Z',
      leave_time: '2026-05-15T15:30:00Z',
    },
    {
      name: 'Bob Smith',
      user_email: 'bob@company.com',
      join_time: '2026-05-15T14:02:00Z',
      leave_time: '2026-05-15T15:25:00Z',
    },
    {
      name: 'Carol Johnson',
      user_email: 'carol@company.com',
      join_time: '2026-05-15T14:05:00Z',
      leave_time: '2026-05-15T15:30:00Z',
    },
  ],
  has_recording: true,
  recording_files: [
    {
      id: 'rec123',
      file_type: 'M4A',
      file_size: 1024000,
      download_url: 'https://zoom.us/download/rec123.m4a',
      play_url: 'https://zoom.us/play/rec123',
    },
  ],
};

/**
 * Example output from adaptZoomPayload()
 */
const EXAMPLE_MEETING_SUMMARY = {
  zoomMeetingId: '12345678901',
  title: 'Q2 Planning Meeting',
  hostEmail: 'alice@company.com',
  hostName: 'Alice Chen',
  startTime: '2026-05-15T14:00:00.000Z',
  endTime: '2026-05-15T15:30:00.000Z',
  durationMinutes: 90,
  attendees: [
    {
      email: 'alice@company.com',
      name: 'Alice Chen',
      isHost: true,
      joinTime: '2026-05-15T14:00:00.000Z',
      leaveTime: '2026-05-15T15:30:00.000Z',
      durationMinutes: 90,
    },
    {
      email: 'bob@company.com',
      name: 'Bob Smith',
      isHost: false,
      joinTime: '2026-05-15T14:02:00.000Z',
      leaveTime: '2026-05-15T15:25:00.000Z',
      durationMinutes: 83,
    },
    {
      email: 'carol@company.com',
      name: 'Carol Johnson',
      isHost: false,
      joinTime: '2026-05-15T14:05:00.000Z',
      leaveTime: '2026-05-15T15:30:00.000Z',
      durationMinutes: 85,
    },
  ],
  attendeeCount: 3,
  hasRecording: true,
  recordingUrls: [
    'https://zoom.us/download/rec123.m4a',
    'https://zoom.us/play/rec123',
  ],
  source: 'zoom',
  extractedAt: '2026-05-15T16:45:30.123Z',
  warnings: [],
};

// ============================================================================
// Exports
// ============================================================================

/**
 * Adapter for recording.transcript_completed events.
 *
 * Unlike meeting.summary_completed (which carries the summary text inline),
 * this event carries POINTERS to recording files. The actual transcript
 * (VTT) is downloaded separately by the orchestrator's fetchTranscript
 * stage using the stored OAuth tokens for the installing account.
 *
 * Returns a MeetingSummary with:
 *   - transcriptDownloadUrl: where the orchestrator fetches the VTT
 *   - zoomAccountId: which account's OAuth tokens to use
 *   - transcriptDownloadToken: short-lived per-event token (some Zoom events
 *     include this as an alternative to OAuth auth on the download)
 *
 * @param {object} rawObject - The `payload.object` from the event
 * @param {string|null} accountId - The `payload.account_id` from the event
 * @param {object} rawEvent - Full event (for downloadToken)
 * @param {string} eventId
 * @returns {object|null} MeetingSummary, or null if essential fields are missing
 */
function adaptTranscriptCompleted(rawObject, accountId, rawEvent, eventId) {
  if (!rawObject || typeof rawObject !== 'object') {
    logger.error({ rawObject }, 'Invalid recording.transcript_completed payload');
    return null;
  }

  const warnings = [];

  const zoomMeetingId = safeString(
    rawObject.id || rawObject.meeting_id || rawObject.uuid,
    '',
    'meetingId'
  );
  if (!zoomMeetingId) {
    logger.error(
      { payload: JSON.stringify(rawObject).substring(0, 200), eventId },
      'recording.transcript_completed missing meeting ID'
    );
    return null;
  }

  // Locate the TRANSCRIPT file in the recording bundle.
  const recordingFiles = Array.isArray(rawObject.recording_files)
    ? rawObject.recording_files
    : [];
  const transcriptFile = recordingFiles.find(
    (f) =>
      f &&
      (f.file_type === 'TRANSCRIPT' ||
        f.recording_type === 'audio_transcript' ||
        f.file_extension === 'VTT')
  );

  if (!transcriptFile?.download_url) {
    const msg = `Meeting ${zoomMeetingId}: no TRANSCRIPT file with download_url in recording_files`;
    logger.warn({ recordingFileCount: recordingFiles.length }, msg);
    warnings.push(msg);
  }

  const hostEmail = safeString(rawObject.host_email, '', 'hostEmail');
  if (!hostEmail) {
    warnings.push(`Meeting ${zoomMeetingId}: missing host email`);
  }

  const startTime = safeTimestamp(rawObject.start_time, 'startTime');
  const endTime = safeTimestamp(rawObject.end_time, 'endTime');
  let durationMinutes = safeNumber(rawObject.duration, 0, 'duration');
  if (!durationMinutes && startTime && endTime) {
    durationMinutes = Math.round((endTime - startTime) / (1000 * 60));
  }

  const title = safeString(
    rawObject.topic || rawObject.subject || rawObject.title,
    'Untitled Meeting',
    'title'
  );

  const { attendees, uniqueCount } = normalizeAttendees(rawObject.participants, hostEmail);

  const result = {
    zoomMeetingId,
    title,
    hostEmail,
    hostName: safeString(rawObject.host_name || rawObject.host, '', 'hostName'),
    startTime: startTime ? startTime.toISOString() : new Date().toISOString(),
    endTime: endTime ? endTime.toISOString() : new Date().toISOString(),
    durationMinutes,
    attendees,
    attendeeCount: uniqueCount,
    hasRecording: true, // by definition — this event fires after recording
    source: 'zoom',
    extractedAt: new Date().toISOString(),
    warnings,
    // Transcript-specific fields. The orchestrator's fetchTranscript stage
    // reads these and populates `transcript` with the downloaded + parsed
    // VTT content. Extraction then uses `transcript` directly.
    transcriptDownloadUrl: transcriptFile?.download_url || null,
    transcriptDownloadToken: safeString(rawEvent?.download_token, '', 'downloadToken'),
    zoomAccountId: accountId || null,
  };

  logger.info(
    {
      zoomMeetingId,
      title,
      hostEmail,
      attendeeCount: uniqueCount,
      hasTranscriptUrl: !!result.transcriptDownloadUrl,
      warnings: warnings.length,
      eventId,
    },
    'recording.transcript_completed adapted successfully'
  );

  return result;
}

/**
 * Dispatcher: picks the right per-event-type adapter based on rawEvent.event.
 * Synthetic test events that don't carry rawEvent.payload still work — they
 * route to adaptZoomPayload using rawEvent.object directly.
 *
 * @param {object} rawEvent - Full Zoom webhook event
 * @returns {object|null}
 */
function adaptZoomEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return null;

  const eventType = rawEvent.event;
  const eventId = rawEvent.event_id;
  // Real Zoom events nest the meeting object under payload.object.
  // Synthetic test events (legacy shape) put it directly on event.object.
  const obj = rawEvent.payload?.object || rawEvent.object || rawEvent.payload || {};
  // account_id is usually at payload level per Zoom docs, but real
  // recording.transcript_completed events sometimes nest it inside the
  // meeting object. Look in both places.
  const accountId = rawEvent.payload?.account_id || obj.account_id || null;

  if (eventType === 'recording.transcript_completed') {
    return adaptTranscriptCompleted(obj, accountId, rawEvent, eventId);
  }

  // Default to the legacy summary adapter for meeting.summary_completed and
  // for synthetic events that don't specify an event type.
  return adaptZoomPayload(obj, eventId);
}

module.exports = {
  // Main adapter function
  adaptZoomPayload,
  adaptZoomEvent,
  adaptTranscriptCompleted,

  // Validation helpers (for testing or direct use)
  safeString,
  safeTimestamp,
  safeNumber,
  safeBoolean,
  validateRequired,

  // Normalization helpers (for testing or reuse)
  normalizeAttendee,
  normalizeAttendees,
  normalizeRecordings,

  // Examples (for documentation and testing)
  EXAMPLE_ZOOM_PAYLOAD,
  EXAMPLE_MEETING_SUMMARY,
};
