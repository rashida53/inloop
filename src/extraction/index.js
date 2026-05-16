const { extractMeetingIntelligence } = require('./claude');

async function extractFromRecording(recording) {
  const transcript = recording.transcript || recording.summary || '';

  if (!transcript.trim()) {
    throw new Error(
      'extractFromRecording requires recording.transcript or recording.summary. ' +
        'For Zoom meetings, this is the AI Companion summary (summary_overview + ' +
        'summary_details) assembled by the zoom-adapter. An empty value usually ' +
        'means the meeting was not AI-summarized by Zoom.'
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
