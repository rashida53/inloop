// Extraction layer: responsible for extracting structured data from recordings
// and transcripts. Implement processors / pipelines here.

async function extractFromRecording(recording) {
  // TODO: wire up transcription and model calls (Claude)
  return { recordingId: recording.id };
}

module.exports = { extractFromRecording };
