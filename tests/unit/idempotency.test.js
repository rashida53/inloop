const { installDbMock } = require('../mocks/db');

const dbHandle = installDbMock();

const idempotency = require('../../src/db/idempotency');

describe('idempotency.claimKey', () => {
  beforeEach(() => {
    dbHandle.reset();
  });

  test('fresh claim (no prior row) returns claimed=true, reclaimed=false', async () => {
    dbHandle.mockQueryByName({
      idempotency_claim: {
        rows: [
          {
            key: 'zoom:meeting:42:evt-1',
            status: 'processing',
            response: null,
            owner_id: 'worker-1',
            reclaimed: false,
          },
        ],
        rowCount: 1,
      },
    });

    const result = await idempotency.claimKey('zoom:meeting:42:evt-1', { event: 'a' }, 'worker-1');

    expect(result).toEqual({ claimed: true, reclaimed: false, existing: null });
    expect(dbHandle.findQueryCalls('idempotency_claim')).toHaveLength(1);
    expect(dbHandle.findQueryCalls('idempotency_get')).toHaveLength(0);
  });

  test('reclaim after previous failure returns claimed=true, reclaimed=true', async () => {
    dbHandle.mockQueryByName({
      idempotency_claim: {
        rows: [
          {
            key: 'zoom:meeting:42:evt-1',
            status: 'processing',
            response: null,
            owner_id: 'worker-2',
            reclaimed: true,
          },
        ],
        rowCount: 1,
      },
    });

    const result = await idempotency.claimKey('zoom:meeting:42:evt-1', { event: 'a' }, 'worker-2');

    expect(result).toEqual({ claimed: true, reclaimed: true, existing: null });
    expect(dbHandle.findQueryCalls('idempotency_get')).toHaveLength(0);
  });

  test('row exists with status=done returns claimed=false plus cached response', async () => {
    dbHandle.mockQueryByName({
      idempotency_claim: { rows: [], rowCount: 0 },
      idempotency_get: {
        rows: [
          {
            status: 'done',
            response: { ok: true, delivered: true },
            owner_id: 'worker-prior',
          },
        ],
        rowCount: 1,
      },
    });

    const result = await idempotency.claimKey('zoom:meeting:42:evt-1', { event: 'a' });

    expect(result.claimed).toBe(false);
    expect(result.reclaimed).toBe(false);
    expect(result.existing).toEqual({
      status: 'done',
      response: { ok: true, delivered: true },
      ownerId: 'worker-prior',
    });
  });

  test('row exists with status=processing (concurrent in-flight) returns claimed=false', async () => {
    dbHandle.mockQueryByName({
      idempotency_claim: { rows: [], rowCount: 0 },
      idempotency_get: {
        rows: [
          {
            status: 'processing',
            response: null,
            owner_id: 'worker-prior',
          },
        ],
        rowCount: 1,
      },
    });

    const result = await idempotency.claimKey('zoom:meeting:42:evt-1', { event: 'a' });

    expect(result.claimed).toBe(false);
    expect(result.existing.status).toBe('processing');
  });

  test('UPSERT query uses ON CONFLICT DO UPDATE with WHERE status=failed', async () => {
    dbHandle.mockQueryByName({
      idempotency_claim: {
        rows: [
          {
            key: 'zoom:meeting:42:evt-1',
            status: 'processing',
            response: null,
            owner_id: 'worker-1',
            reclaimed: false,
          },
        ],
        rowCount: 1,
      },
    });

    await idempotency.claimKey('zoom:meeting:42:evt-1', { event: 'a' }, 'worker-1');

    const calls = dbHandle.findQueryCalls('idempotency_claim');
    expect(calls).toHaveLength(1);
    const sql = calls[0].sql;
    expect(sql).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(sql).toMatch(/WHERE idempotency_keys\.status = 'failed'/);
    expect(sql).toMatch(/xmax <> 0/);
  });

  test('throws when key is missing', async () => {
    await expect(idempotency.claimKey('', {})).rejects.toThrow(
      'Idempotency key is required'
    );
    expect(dbHandle.dbMock.query).not.toHaveBeenCalled();
  });
});
