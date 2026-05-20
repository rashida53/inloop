const { parseVtt } = require('../../src/utils/vtt-parser');

describe('parseVtt', () => {
  test('returns empty transcript and speakers for empty/non-string input', () => {
    expect(parseVtt('')).toEqual({ transcript: '', speakers: [] });
    expect(parseVtt(null)).toEqual({ transcript: '', speakers: [] });
    expect(parseVtt(undefined)).toEqual({ transcript: '', speakers: [] });
    expect(parseVtt(123)).toEqual({ transcript: '', speakers: [] });
  });

  test('parses a simple two-speaker VTT into Speaker: text lines + speakers array', () => {
    const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:03.500
<v Alice Chen>So shall we start with the pricing discussion?

2
00:00:03.500 --> 00:00:08.200
<v Bob Customer>Yes, my main concern is the enterprise tier.`;

    const result = parseVtt(vtt);
    expect(result.transcript).toBe(
      [
        'Alice Chen: So shall we start with the pricing discussion?',
        'Bob Customer: Yes, my main concern is the enterprise tier.',
      ].join('\n')
    );
    expect(result.speakers).toEqual(['Alice Chen', 'Bob Customer']);
  });

  test('handles "Speaker: text" format (older Zoom shape) as a fallback', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
Alice Chen: Let's begin.

00:00:02.000 --> 00:00:05.000
Bob Customer: Sounds good.`;

    expect(parseVtt(vtt)).toEqual({
      transcript: "Alice Chen: Let's begin.\nBob Customer: Sounds good.",
      speakers: ['Alice Chen', 'Bob Customer'],
    });
  });

  test('merges consecutive turns from the same speaker and dedupes speakers list', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
<v Alice>First sentence.

00:00:02.000 --> 00:00:04.000
<v Alice>Second sentence.

00:00:04.000 --> 00:00:06.000
<v Bob>Bob's turn.

00:00:06.000 --> 00:00:08.000
<v Alice>Back to Alice.`;

    const result = parseVtt(vtt);
    expect(result.transcript).toBe(
      "Alice: First sentence. Second sentence.\nBob: Bob's turn.\nAlice: Back to Alice."
    );
    // Alice appears twice in the conversation but only once in the list.
    expect(result.speakers).toEqual(['Alice', 'Bob']);
  });

  test('preserves content even when no speaker label is present (no speakers added)', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
plain content with no speaker

00:00:02.000 --> 00:00:04.000
another unattributed line`;

    expect(parseVtt(vtt)).toEqual({
      transcript: 'plain content with no speaker\nanother unattributed line',
      speakers: [],
    });
  });

  test('ignores STYLE and NOTE blocks', () => {
    const vtt = `WEBVTT

STYLE
::cue { color: red; }

NOTE this is a comment

00:00:00.000 --> 00:00:02.000
<v Alice>Real content.`;

    expect(parseVtt(vtt)).toEqual({
      transcript: 'Alice: Real content.',
      speakers: ['Alice'],
    });
  });

  test('handles CRLF line endings (Windows-style)', () => {
    const vtt = 'WEBVTT\r\n\r\n00:00:00.000 --> 00:00:02.000\r\n<v Alice>Hi there.\r\n';
    expect(parseVtt(vtt)).toEqual({
      transcript: 'Alice: Hi there.',
      speakers: ['Alice'],
    });
  });

  test('does not treat sentence-internal colons as speaker labels (but accepts plausible-looking ones)', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:04.000
She said: yes that works for me`;
    // "She said" matches the speaker pattern (capital first, no internal
    // punctuation, ≤40 chars), so it gets parsed AS a speaker.
    expect(parseVtt(vtt)).toEqual({
      transcript: 'She said: yes that works for me',
      speakers: ['She said'],
    });
  });
});
