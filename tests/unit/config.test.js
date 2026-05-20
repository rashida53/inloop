/**
 * Config parsing tests. The module reads env vars at require time, so each
 * test isolates a fresh require via jest.resetModules() after mutating
 * process.env.
 */

function loadConfigWith(env) {
  jest.resetModules();
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    return require('../../src/config');
  } finally {
    // Restore env so other tests aren't affected.
    process.env = original;
  }
}

describe('config.digestHostCcMap', () => {
  test('empty when env var is unset', () => {
    const config = loadConfigWith({ DIGEST_HOST_CC_MAP: '' });
    expect(config.digestHostCcMap).toBeInstanceOf(Map);
    expect(config.digestHostCcMap.size).toBe(0);
  });

  test('parses valid JSON into normalized Map', () => {
    const config = loadConfigWith({
      DIGEST_HOST_CC_MAP: JSON.stringify({
        'EGriffis@inmarket.com': ['Manager@inmarket.com', '  ops@inmarket.com  '],
        'another@inmarket.com': ['analyst@inmarket.com'],
      }),
    });

    expect(config.digestHostCcMap.size).toBe(2);

    const erinCcs = config.digestHostCcMap.get('egriffis@inmarket.com');
    expect(erinCcs).toBeInstanceOf(Set);
    expect([...erinCcs]).toEqual(
      expect.arrayContaining(['manager@inmarket.com', 'ops@inmarket.com'])
    );
    expect(erinCcs.size).toBe(2);

    const anotherCcs = config.digestHostCcMap.get('another@inmarket.com');
    expect([...anotherCcs]).toEqual(['analyst@inmarket.com']);
  });

  test('treats invalid JSON as empty map', () => {
    const config = loadConfigWith({ DIGEST_HOST_CC_MAP: 'not-json{' });
    expect(config.digestHostCcMap.size).toBe(0);
  });

  test('skips non-array CC values', () => {
    const config = loadConfigWith({
      DIGEST_HOST_CC_MAP: JSON.stringify({
        'host1@inmarket.com': 'not-an-array',
        'host2@inmarket.com': ['cc@inmarket.com'],
      }),
    });
    expect(config.digestHostCcMap.size).toBe(1);
    expect(config.digestHostCcMap.has('host1@inmarket.com')).toBe(false);
    expect(config.digestHostCcMap.has('host2@inmarket.com')).toBe(true);
  });

  test('skips entries whose CC list is empty after filtering', () => {
    const config = loadConfigWith({
      DIGEST_HOST_CC_MAP: JSON.stringify({
        'host@inmarket.com': ['', '   ', null],
      }),
    });
    expect(config.digestHostCcMap.size).toBe(0);
  });

  test('treats top-level array as empty (must be an object)', () => {
    const config = loadConfigWith({
      DIGEST_HOST_CC_MAP: JSON.stringify([['host@inmarket.com', ['cc@inmarket.com']]]),
    });
    expect(config.digestHostCcMap.size).toBe(0);
  });

  test('de-duplicates CC entries case-insensitively', () => {
    const config = loadConfigWith({
      DIGEST_HOST_CC_MAP: JSON.stringify({
        'host@inmarket.com': ['cc@inmarket.com', 'CC@INMARKET.COM', 'cc@inmarket.com'],
      }),
    });
    const ccs = config.digestHostCcMap.get('host@inmarket.com');
    expect(ccs.size).toBe(1);
    expect([...ccs]).toEqual(['cc@inmarket.com']);
  });
});
