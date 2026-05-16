const { extractMeetingIntelligence } = require('./claude');

async function extractFromRecording(recording) {
  const transcript = recording.transcript || recording.summary || '';

  if (!transcript.trim()) {
    throw new Error(
      'extractFromRecording requires recording.transcript or recording.summary; ' +
        'the upstream pipeline must transcribe the recording (e.g. via Zoom transcript API or Whisper) before extraction.'
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
