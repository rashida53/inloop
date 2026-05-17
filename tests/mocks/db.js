/**
 * DB mock factory.
 *
 * We mock the entire `src/db/index.js` module so the db helpers
 * (db/users.js, db/meetings.js, db/idempotency.js) run real code over
 * a fake `query` implementation. Tests can either:
 *
 *   (a) call `mockQueryByName({ users_find_by_email: { rows: [...] } })`
 *       to register canned responses keyed by the `name` option each
 *       helper passes in, OR
 *   (b) reach for `dbMock.query.mockResolvedValueOnce(...)` directly for
 *       single-shot overrides in a specific test.
 *
 * Call `installDbMock()` once at the top of a test file (before requiring
 * any module that depends on db). Returns the mock for further use.
 */

function installDbMock() {
  const queryResponses = {};
  const queryLog = [];

  const query = jest.fn(async (sql, values, options = {}) => {
    queryLog.push({ name: options.name || null, sql, values });

    const name = options.name;
    if (name && Object.prototype.hasOwnProperty.call(queryResponses, name)) {
      const handler = queryResponses[name];
      if (Array.isArray(handler)) {
        if (handler.length === 0) {
          throw new Error(`No queued response left for db.query name=${name}`);
        }
        return handler.shift();
      }
      if (typeof handler === 'function') return handler({ sql, values });
      return handler;
    }

    // Default: empty result set. Tests that need richer behavior should
    // register handlers via mockQueryByName.
    return { rows: [], rowCount: 0 };
  });

  const transaction = jest.fn(async (callback) => {
    // Tests rarely use transactions; supply a no-op client so callers don't crash.
    const fakeClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    return callback(fakeClient);
  });

  const checkHealth = jest.fn().mockResolvedValue({ ok: true, latency: 1 });
  const shutdown = jest.fn().mockResolvedValue();

  const dbMock = { query, transaction, checkHealth, shutdown, getPool: jest.fn(), getSupabase: jest.fn() };

  // jest.doMock (not .mock) — doMock is not hoisted by babel-plugin-jest-hoist,
  // so the closure-captured `dbMock` is fully initialized when the factory
  // runs (the factory fires lazily on the first require of '../../src/db').
  jest.doMock('../../src/db', () => dbMock);

  return {
    dbMock,
    queryLog,
    mockQueryByName(map) {
      Object.assign(queryResponses, map);
    },
    findQueryCalls(name) {
      return queryLog.filter((entry) => entry.name === name);
    },
    reset() {
      Object.keys(queryResponses).forEach((k) => delete queryResponses[k]);
      queryLog.length = 0;
      query.mockClear();
      transaction.mockClear();
      checkHealth.mockClear();
      shutdown.mockClear();
    },
  };
}

module.exports = { installDbMock };
