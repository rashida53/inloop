const { installDbMock } = require('../mocks/db');

const dbHandle = installDbMock();

const sfTokens = require('../../src/db/salesforce-tokens');

describe('salesforce-tokens DB helpers', () => {
  beforeEach(() => {
    dbHandle.reset();
  });

  describe('findByOrgId', () => {
    test('returns null when orgId is empty', async () => {
      const result = await sfTokens.findByOrgId('');
      expect(result).toBeNull();
      expect(dbHandle.dbMock.query).not.toHaveBeenCalled();
    });

    test('returns null when no row exists', async () => {
      dbHandle.mockQueryByName({
        salesforce_tokens_find_by_org_id: { rows: [], rowCount: 0 },
      });
      const result = await sfTokens.findByOrgId('00DAB000000XYZ123');
      expect(result).toBeNull();
    });

    test('returns the row when one exists', async () => {
      const row = {
        org_id: '00DAB000000XYZ123',
        access_token: 'tok-1',
        refresh_token: 'ref-1',
        instance_url: 'https://inmarket.my.salesforce.com',
        token_type: 'Bearer',
        scope: 'api refresh_token',
        identity_url: 'https://login.salesforce.com/id/00DAB000000XYZ123/005AB000000USERID',
        login_url: 'https://login.salesforce.com',
        expires_at: new Date('2026-05-21T18:00:00Z'),
      };
      dbHandle.mockQueryByName({
        salesforce_tokens_find_by_org_id: { rows: [row], rowCount: 1 },
      });
      const result = await sfTokens.findByOrgId('00DAB000000XYZ123');
      expect(result).toEqual(row);
    });
  });

  describe('findCurrent', () => {
    test('returns most-recent row (ORDER BY updated_at DESC)', async () => {
      const row = {
        org_id: '00DAB000000XYZ123',
        access_token: 'tok-1',
        refresh_token: 'ref-1',
        instance_url: 'https://inmarket.my.salesforce.com',
        login_url: 'https://login.salesforce.com',
      };
      dbHandle.mockQueryByName({
        salesforce_tokens_find_current: { rows: [row], rowCount: 1 },
      });
      const result = await sfTokens.findCurrent();
      expect(result).toEqual(row);

      // Verify the SOQL ordering & LIMIT in the SQL
      const calls = dbHandle.findQueryCalls('salesforce_tokens_find_current');
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toMatch(/ORDER BY updated_at DESC/);
      expect(calls[0].sql).toMatch(/LIMIT 1/);
    });

    test('returns null when no installs exist', async () => {
      dbHandle.mockQueryByName({
        salesforce_tokens_find_current: { rows: [], rowCount: 0 },
      });
      const result = await sfTokens.findCurrent();
      expect(result).toBeNull();
    });
  });

  describe('upsert', () => {
    test('throws when orgId is missing', async () => {
      await expect(
        sfTokens.upsert('', {
          access_token: 'a',
          refresh_token: 'b',
          instance_url: 'https://x.salesforce.com',
        })
      ).rejects.toThrow('orgId is required');
    });

    test('throws when access_token is missing', async () => {
      await expect(
        sfTokens.upsert('00DAB', {
          refresh_token: 'b',
          instance_url: 'https://x.salesforce.com',
        })
      ).rejects.toThrow('access_token and refresh_token');
    });

    test('throws when refresh_token is missing', async () => {
      await expect(
        sfTokens.upsert('00DAB', {
          access_token: 'a',
          instance_url: 'https://x.salesforce.com',
        })
      ).rejects.toThrow('access_token and refresh_token');
    });

    test('throws when instance_url is missing', async () => {
      await expect(
        sfTokens.upsert('00DAB', { access_token: 'a', refresh_token: 'b' })
      ).rejects.toThrow('instance_url');
    });

    test('persists row and returns it', async () => {
      const persisted = {
        org_id: '00DAB000000XYZ123',
        access_token: 'tok-1',
        refresh_token: 'ref-1',
        instance_url: 'https://inmarket.my.salesforce.com',
        login_url: 'https://login.salesforce.com',
      };
      dbHandle.mockQueryByName({
        salesforce_tokens_upsert: { rows: [persisted], rowCount: 1 },
      });

      const result = await sfTokens.upsert('00DAB000000XYZ123', {
        access_token: 'tok-1',
        refresh_token: 'ref-1',
        instance_url: 'https://inmarket.my.salesforce.com',
        token_type: 'Bearer',
        scope: 'api refresh_token',
        identity_url: 'https://login.salesforce.com/id/00DAB.../005...',
        login_url: 'https://login.salesforce.com',
        expires_at: new Date('2026-05-21T18:00:00Z'),
      });

      expect(result).toEqual(persisted);
      const calls = dbHandle.findQueryCalls('salesforce_tokens_upsert');
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toMatch(/ON CONFLICT \(org_id\) DO UPDATE/);
      expect(calls[0].values[0]).toBe('00DAB000000XYZ123');
      expect(calls[0].values[3]).toBe('https://inmarket.my.salesforce.com');
    });

    test('defaults login_url to login.salesforce.com when omitted', async () => {
      dbHandle.mockQueryByName({
        salesforce_tokens_upsert: { rows: [{}], rowCount: 1 },
      });
      await sfTokens.upsert('00DAB', {
        access_token: 'a',
        refresh_token: 'b',
        instance_url: 'https://x.salesforce.com',
        expires_at: new Date(),
      });
      const calls = dbHandle.findQueryCalls('salesforce_tokens_upsert');
      // login_url is the 8th positional value (1-indexed): $1=orgId,
      // $2=access_token, $3=refresh_token, $4=instance_url, $5=token_type,
      // $6=scope, $7=identity_url, $8=login_url, $9=expires_at
      expect(calls[0].values[7]).toBe('https://login.salesforce.com');
    });
  });
});
