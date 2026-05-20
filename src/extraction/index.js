const { extractMeetingIntelligence } = require('./claude');

async function extractFromRecording(recording) {
  const transcript = recording.transcript || recording.summary || '';

  if (!transcript.trim()) {
    throw new Error(
      'extractFromRecording requires recording.transcript or recording.summary. ' +
        'For Zoom meetings, transcript is populated by the orchestrator after ' +
        'fetching the VTT file from a recording.transcript_completed webhook. ' +
        'An empty value usually means the meeting was not cloud-recorded, ' +
        'transcription was disabled on the account, or the fetchTranscript ' +
        'stage failed.'
    );
  }

  const metadata = {
    title: recording.title,
    organizer: recording.hostEmail || recording.host || recording.organizer,
    meetingDate: recording.startTime || recording.meetingDate,
    accountName: recording.accountName || recording.company,
    opportunityName: recording.opportunityName,
  };

  return extractMeetingIntelligence(transcript, metadata);
}

module.exports = { extractFromRecording };
