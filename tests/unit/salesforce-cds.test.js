/**
 * Tests for the Salesforce CDS builder. Mocks salesforce-api so the
 * tests assert on the field mapping + AM Lead gate logic without
 * needing live Salesforce access.
 */

const mockGetRecord = jest.fn();
const mockQueryRecords = jest.fn();
const mockCreateRecord = jest.fn();

jest.mock('../../src/integrations/salesforce-api', () => ({
  getRecord: mockGetRecord,
  queryRecords: mockQueryRecords,
  createRecord: mockCreateRecord,
}));

const {
  loadOppContextForCds,
  createDraftCds,
  AmLeadNotPopulatedError,
  CDS_OBJECT,
  OPP_FIELDS_FOR_CDS,
} = require('../../src/integrations/salesforce-cds');

// Reusable fixture: a "good" Opportunity record with all CDS-relevant
// fields populated. Tests override individual fields as needed.
function oppFixture(overrides = {}) {
  return {
    Id: '006Rd00000XKgRVIA1',
    Name: 'Taylor Farms — FY26/27 BTS Sales Lift',
    AccountId: '001TaylorFarmsAcc',
    OwnerId: '005ErinGriffis',
    Account_Manager2__c: '005JasmineImes',
    Agency__c: '001HunterbluMediaAg',
    Vertical__c: 'CPG - Food',
    Campaign_Start_Date__c: '2026-08-01',
    Campaign_End_Date__c: '2026-10-31',
    Campaign_Text_ID__c: 'Taylor Farms|Hunterblu|BTS 2026|Q3Q4 2026 - 006Rd00000XKgRVIA1',
    ...overrides,
  };
}

describe('loadOppContextForCds', () => {
  beforeEach(() => {
    mockGetRecord.mockReset();
    mockQueryRecords.mockReset();
    mockCreateRecord.mockReset();
  });

  test('throws when oppId is empty', async () => {
    await expect(loadOppContextForCds('')).rejects.toThrow('oppId is required');
    await expect(loadOppContextForCds(null)).rejects.toThrow('oppId is required');
    expect(mockGetRecord).not.toHaveBeenCalled();
  });

  test('queries Opportunity with the exact CDS field projection', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({ records: [] });

    await loadOppContextForCds('006Rd00000XKgRVIA1');

    expect(mockGetRecord).toHaveBeenCalledWith(
      'Opportunity',
      '006Rd00000XKgRVIA1',
      Array.from(OPP_FIELDS_FOR_CDS)
    );
    // Sanity: the projection includes the reference-type Account_Manager2__c,
    // NOT the legacy picklist Account_Manager__c.
    const fields = Array.from(OPP_FIELDS_FOR_CDS);
    expect(fields).toContain('Account_Manager2__c');
    expect(fields).not.toContain('Account_Manager__c');
  });

  test('throws AmLeadNotPopulatedError when Account_Manager2__c is null', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture({ Account_Manager2__c: null }));

    await expect(loadOppContextForCds('006Rd00000XKgRVIA1')).rejects.toThrow(
      AmLeadNotPopulatedError
    );
  });

  test('AmLeadNotPopulatedError carries oppId, oppName, and a stable code', async () => {
    mockGetRecord.mockResolvedValueOnce(
      oppFixture({ Account_Manager2__c: null, Name: 'Orphan Opp' })
    );

    try {
      await loadOppContextForCds('006Rd00000XKgRVIA1');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AmLeadNotPopulatedError);
      expect(err.code).toBe('AM_LEAD_NOT_POPULATED');
      expect(err.oppId).toBe('006Rd00000XKgRVIA1');
      expect(err.oppName).toBe('Orphan Opp');
      expect(err.message).toMatch(/Orphan Opp/);
      expect(err.message).toMatch(/screen flow/i);
    }
  });

  test('does NOT query product line items when AM Lead is missing (short-circuit)', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture({ Account_Manager2__c: null }));

    await expect(loadOppContextForCds('006Rd00000XKgRVIA1')).rejects.toThrow();

    expect(mockQueryRecords).not.toHaveBeenCalled();
  });

  test('builds the Bucket A payload mapping Opp fields to CDS field names', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({ records: [] });

    const { bucketA } = await loadOppContextForCds('006Rd00000XKgRVIA1');

    expect(bucketA).toEqual({
      Name: 'Taylor Farms — FY26/27 BTS Sales Lift',
      OwnerId: '005ErinGriffis',
      Opportunity__c: '006Rd00000XKgRVIA1',
      Brand__c: '001TaylorFarmsAcc',
      AM_Lead__c: '005JasmineImes',
      Agency__c: '001HunterbluMediaAg',
      Brand_Vertical__c: 'CPG - Food',
      Campaign_Start_Date__c: '2026-08-01',
      Campaign_End_Date__c: '2026-10-31',
      Campaign_Name__c: 'Taylor Farms|Hunterblu|BTS 2026|Q3Q4 2026 - 006Rd00000XKgRVIA1',
      Measurement_Products_Included__c: 'No',
    });
  });

  test('falls back to Opp.Name for Campaign_Name__c when Campaign_Text_ID__c is empty', async () => {
    // Defensive: older Opps may pre-date the structured-name field.
    mockGetRecord.mockResolvedValueOnce(
      oppFixture({ Campaign_Text_ID__c: null, Name: 'Legacy Opp Name' })
    );
    mockQueryRecords.mockResolvedValueOnce({ records: [] });

    const { bucketA } = await loadOppContextForCds('006Rd00000XKgRVIA1');

    expect(bucketA.Campaign_Name__c).toBe('Legacy Opp Name');
  });

  test('sets Measurement_Products_Included__c=Yes when a line item is a measurement product', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({
      records: [
        { Id: 'oli1', Product2: { Name: 'Pathformance Sales Lift Measurement' } },
        { Id: 'oli2', Product2: { Name: 'Standard Display' } },
      ],
    });

    const { bucketA } = await loadOppContextForCds('006Rd00000XKgRVIA1');

    expect(bucketA.Measurement_Products_Included__c).toBe('Yes');
  });

  test('matches all four documented measurement partners case-insensitively', async () => {
    const partners = ['Pathformance', 'pathformance', 'Ansa Measurement', 'CIRCANA', 'ABCS Partner'];
    for (const partnerName of partners) {
      mockGetRecord.mockReset();
      mockQueryRecords.mockReset();
      mockGetRecord.mockResolvedValueOnce(oppFixture());
      mockQueryRecords.mockResolvedValueOnce({
        records: [{ Id: 'oli', Product2: { Name: partnerName } }],
      });

      const { bucketA } = await loadOppContextForCds('006Rd00000XKgRVIA1');
      expect(bucketA.Measurement_Products_Included__c).toBe('Yes');
    }
  });

  test('sets Measurement_Products_Included__c=No when no line items match a partner', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({
      records: [
        { Id: 'oli1', Product2: { Name: 'Display Programmatic' } },
        { Id: 'oli2', Product2: { Name: 'Moments In-Store' } },
      ],
    });

    const { bucketA } = await loadOppContextForCds('006Rd00000XKgRVIA1');

    expect(bucketA.Measurement_Products_Included__c).toBe('No');
  });

  test('sets Measurement_Products_Included__c=No when the Opp has no line items', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({ records: [] });

    const { bucketA } = await loadOppContextForCds('006Rd00000XKgRVIA1');

    expect(bucketA.Measurement_Products_Included__c).toBe('No');
  });

  test('handles missing Product2 relationship gracefully', async () => {
    // Defensive: an OLI without a populated Product2 should be skipped,
    // not crash.
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({
      records: [
        { Id: 'oli1', Product2: null },
        { Id: 'oli2', Product2: { Name: 'Ansa Lift Study' } },
      ],
    });

    const { bucketA } = await loadOppContextForCds('006Rd00000XKgRVIA1');

    expect(bucketA.Measurement_Products_Included__c).toBe('Yes');
  });

  test('returns the raw Opp record alongside bucketA for caller diagnostics', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({ records: [] });

    const { opp } = await loadOppContextForCds('006Rd00000XKgRVIA1');

    expect(opp.Id).toBe('006Rd00000XKgRVIA1');
    expect(opp.Name).toBe('Taylor Farms — FY26/27 BTS Sales Lift');
  });
});

describe('createDraftCds', () => {
  beforeEach(() => {
    mockGetRecord.mockReset();
    mockQueryRecords.mockReset();
    mockCreateRecord.mockReset();
  });

  test('merges bucketA + bucketB and POSTs to Campaign_Details_Form__c', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    mockCreateRecord.mockResolvedValueOnce({
      id: 'a2ZRd000001eH9dMAE',
      success: true,
      errors: [],
    });

    const bucketB = {
      Primary_KPI__c: 'Clicks',
      Primary_KPI_Client_Benchmark__c: 'iROAS',
      Moments_vs_Precep_Audiences_Allocation__c: '50/50',
      Notes__c: 'Real notes extracted from the transcript',
    };

    const result = await createDraftCds('006Rd00000XKgRVIA1', bucketB);

    expect(result.id).toBe('a2ZRd000001eH9dMAE');
    expect(mockCreateRecord).toHaveBeenCalledTimes(1);

    const [objectName, payload] = mockCreateRecord.mock.calls[0];
    expect(objectName).toBe(CDS_OBJECT);
    expect(objectName).toBe('Campaign_Details_Form__c');

    // Bucket A fields present and correct
    expect(payload.AM_Lead__c).toBe('005JasmineImes');
    expect(payload.Brand__c).toBe('001TaylorFarmsAcc');
    expect(payload.OwnerId).toBe('005ErinGriffis');
    expect(payload.Opportunity__c).toBe('006Rd00000XKgRVIA1');
    expect(payload.Measurement_Products_Included__c).toBe('No');

    // Bucket B fields merged in unchanged
    expect(payload.Primary_KPI__c).toBe('Clicks');
    expect(payload.Primary_KPI_Client_Benchmark__c).toBe('iROAS');
    expect(payload.Moments_vs_Precep_Audiences_Allocation__c).toBe('50/50');
    expect(payload.Notes__c).toBe('Real notes extracted from the transcript');
  });

  test('Bucket B values override Bucket A on collision', async () => {
    // Defensive: if a caller mistakenly passes a Bucket A field name in
    // bucketB (e.g. they want to override the Opp's Vertical with a
    // transcript-derived value), the caller's value wins.
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    mockCreateRecord.mockResolvedValueOnce({ id: 'a2Z', success: true });

    await createDraftCds('006Rd00000XKgRVIA1', {
      Brand_Vertical__c: 'OVERRIDE',
    });

    const payload = mockCreateRecord.mock.calls[0][1];
    expect(payload.Brand_Vertical__c).toBe('OVERRIDE');
  });

  test('propagates AmLeadNotPopulatedError from the Opp loader', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture({ Account_Manager2__c: null }));

    await expect(createDraftCds('006Rd00000XKgRVIA1', {})).rejects.toThrow(
      AmLeadNotPopulatedError
    );

    expect(mockCreateRecord).not.toHaveBeenCalled();
  });

  test('omits Bucket B when not provided (just inserts Bucket A)', async () => {
    mockGetRecord.mockResolvedValueOnce(oppFixture());
    mockQueryRecords.mockResolvedValueOnce({ records: [] });
    mockCreateRecord.mockResolvedValueOnce({ id: 'a2Z', success: true });

    await createDraftCds('006Rd00000XKgRVIA1');

    const payload = mockCreateRecord.mock.calls[0][1];
    expect(Object.keys(payload)).toEqual(
      expect.arrayContaining(['AM_Lead__c', 'Brand__c', 'OwnerId', 'Opportunity__c'])
    );
    // No Bucket B fields leaked in
    expect(payload.Primary_KPI__c).toBeUndefined();
    expect(payload.Notes__c).toBeUndefined();
  });
});
