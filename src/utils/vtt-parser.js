/**
 * Parse a WebVTT transcript (the format Zoom delivers for meeting transcripts)
 * into plain text suitable for feeding to an LLM.
 *
 * Zoom VTT shape:
 *
 *   WEBVTT
 *
 *   1
 *   00:00:00.000 --> 00:00:03.500
 *   <v Alice Chen>So shall we start with the pricing discussion?
 *
 *   2
 *   00:00:03.500 --> 00:00:08.200
 *   <v Bob Customer>Yes, my main concern is the enterprise tier.
 *
 * Output:
 *
 *   Alice Chen: So shall we start with the pricing discussion?
 *   Bob Customer: Yes, my main concern is the enterprise tier.
 *
 * Speaker labels are preserved because they materially improve Claude's
 * extraction quality (better decisionMakers attribution, more accurate
 * "who said what" context for pain points and risks).
 *
 * Consecutive turns from the same speaker are merged into one line. This
 * reduces token count and reads better — Zoom often splits a single
 * utterance into multiple back-to-back VTT cues at sentence boundaries.
 */
function parseVtt(vttText) {
  if (typeof vttText !== 'string' || !vttText.trim()) return '';

  // Normalize line endings; split into cue blocks separated by blank lines.
  const blocks = vttText
    .replace(/\r\n/g, '\n')
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const turns = [];

  for (const block of blocks) {
    // Skip the WEBVTT header / STYLE / NOTE blocks.
    if (/^(WEBVTT|STYLE|NOTE)\b/i.test(block)) continue;

    const lines = block.split('\n');
    // Find the timestamp line ("HH:MM:SS.mmm --> HH:MM:SS.mmm").
    const timestampIdx = lines.findIndex((l) => l.includes('-->'));
    if (timestampIdx === -1) continue;

    const contentLines = lines.slice(timestampIdx + 1).filter((l) => l.length > 0);
    if (contentLines.length === 0) continue;

    const text = contentLines.join(' ').trim();
    if (!text) continue;

    const { speaker, content } = extractSpeaker(text);
    if (!content) continue;

    if (
      speaker !== null &&
      turns.length > 0 &&
      turns[turns.length - 1].speaker === speaker
    ) {
      // Same identified speaker as the previous cue — merge into one turn.
      // Unattributed cues (speaker === null) never merge — each VTT cue
      // was a separate utterance and we shouldn't run them together just
      // because neither had a name.
      turns[turns.length - 1].content += ` ${content}`;
    } else {
      turns.push({ speaker, content });
    }
  }

  return turns.map((t) => (t.speaker ? `${t.speaker}: ${t.content}` : t.content)).join('\n');
}

/**
 * Extract the speaker name from a VTT cue's content, supporting both
 * Zoom's `<v Speaker Name>text` voice-span format and the simpler
 * `Speaker Name: text` format. Returns { speaker, content } where
 * speaker may be null if no speaker was identified.
 */
function extractSpeaker(text) {
  // <v Speaker Name>text — voice-span markup
  const voiceMatch = text.match(/^<v\s+([^>]+)>\s*(.*?)(?:<\/v>)?\s*$/i);
  if (voiceMatch) {
    return { speaker: voiceMatch[1].trim(), content: voiceMatch[2].trim() };
  }

  // Speaker Name: text — older Zoom format. Only accept as a speaker label
  // if it looks like one (no internal punctuation before the colon, capital
  // letter to start). This avoids treating sentences like "She said: ..." as
  // speaker labels.
  const colonMatch = text.match(/^([A-Z][A-Za-z'.\- ]{1,40}):\s+(.+)$/);
  if (colonMatch) {
    return { speaker: colonMatch[1].trim(), content: colonMatch[2].trim() };
  }

  return { speaker: null, content: text };
}

module.exports = { parseVtt };
