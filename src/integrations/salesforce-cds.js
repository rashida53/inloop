/**
 * Salesforce Campaign Details Form (CDS) builder.
 *
 * Mirrors the "CDS Campaign Details Screen Flow" without the screen step:
 * given an Opportunity ID, queries the Opp + its product line items,
 * builds the Bucket A field map (the values the screen flow auto-fills
 * from the Opp), and inserts a Campaign_Details_Form__c record once the
 * caller layers in Bucket B (the transcript-extracted, normally-rep-typed
 * values).
 *
 * Field source mapping authority: confirmed via describeObject queries
 * against the AI Builder sandbox on 2026-05-26, cross-referenced with
 * the Flow Builder "Create Campaign Details Form Record" element. See
 * the memory file [[campaign-detail-sheet]] and [[salesforce-integration-context]].
 */

const logger = require('../utils/logger');
const sf = require('./salesforce-api');

const CDS_OBJECT = 'Campaign_Details_Form__c';

// Opp fields the screen flow's "Get Opp Info" step pulls. Kept as a
// module-level constant so tests can assert on the exact projection.
//
// Note: the Opp has TWO "Account Manager" fields with the same label:
//   - Account_Manager__c  (picklist; legacy)
//   - Account_Manager2__c (reference / Lookup(User); current)
// The CDS's AM_Lead__c is Lookup(User), so the source MUST be the
// reference field. The picklist would silently fail type-coerce on insert.
const OPP_FIELDS_FOR_CDS = Object.freeze([
  'Id',
  'Name',
  'AccountId',
  'OwnerId',
  'Account_Manager2__c',
  'Agency__c',
  'Vertical__c',
  'Campaign_Start_Date__c',
  'Campaign_End_Date__c',
  'Campaign_Text_ID__c',
]);

// Substrings that flag a product as a "measurement product" for the
// Measurement_Products_Included__c picklist. The screen flow walks each
// OpportunityLineItem and checks Product2 against an internal definition;
// we approximate via a name match against the known measurement partners
// (Pathformance, Ansa, Circana, ABCS — confirmed in the AM playbook).
// If InMarket adds a new partner this list needs updating.
const MEASUREMENT_PARTNER_PATTERN = /pathformance|ansa|circana|abcs/i;

/**
 * Thrown when the Opp's Account_Manager2__c is null. Mirrors the
 * "AM NOT POPULATED ERROR SCREEN" hard gate in the screen flow — the
 * AM lead must be assigned on the Opp before any CDS can be created.
 */
class AmLeadNotPopulatedError extends Error {
  constructor(oppId, oppName = null) {
    super(
      `Opportunity ${oppId}${
        oppName ? ` (${oppName})` : ''
      } has no Account Manager assigned. The CDS Campaign Details Screen Flow gates on this — assign an AM Lead on the Opportunity before generating the CDS draft.`
    );
    this.code = 'AM_LEAD_NOT_POPULATED';
    this.oppId = oppId;
    this.oppName = oppName;
  }
}

/**
 * Load everything from Salesforce needed to pre-fill a CDS record for
 * the given Opportunity. Returns:
 *   - opp:     the raw Opp record (for caller diagnostics)
 *   - bucketA: the Opp/product-derived field map ready to merge with
 *              caller-provided Bucket B (Claude-extracted) values
 *
 * Throws AmLeadNotPopulatedError if the Opp has no Account_Manager2__c
 * — the screen flow's hard gate.
 *
 * @param {string} oppId - 15- or 18-char Salesforce Opportunity ID
 * @returns {Promise<{opp: object, bucketA: object}>}
 */
async function loadOppContextForCds(oppId) {
  if (!oppId) throw new Error('loadOppContextForCds: oppId is required');

  // 1. Pull the Opp's CDS-relevant fields.
  const opp = await sf.getRecord('Opportunity', oppId, Array.from(OPP_FIELDS_FOR_CDS));

  // 2. Hard gate — flow stops here; we match that.
  if (!opp.Account_Manager2__c) {
    logger.warn(
      { oppId, oppName: opp.Name },
      'Opportunity has no Account_Manager2__c set; blocking CDS creation (mirrors screen flow gate)'
    );
    throw new AmLeadNotPopulatedError(oppId, opp.Name);
  }

  // 3. Pull the Opp's product line items and derive
  //    Measurement_Products_Included__c. The flow does this with a
  //    record loop; SOQL-then-filter gets the same answer in one round
  //    trip. Product2.Name comes from the relationship traversal.
  //
  //    Note: Salesforce SOQL doesn't allow parameterized queries, so we
  //    inline the oppId. Since oppId came from our own DB / matching
  //    logic (not user input), injection risk is low; if that ever
  //    changes, escape single quotes.
  const liResult = await sf.queryRecords(
    `SELECT Id, Product2.Name FROM OpportunityLineItem WHERE OpportunityId = '${oppId}'`
  );
  const productNames = (liResult.records || []).map((r) => r.Product2?.Name || '');
  const measurementProducts = productNames.filter((name) =>
    MEASUREMENT_PARTNER_PATTERN.test(name)
  );
  // Picklist value. Sandbox describes the field as a picklist; "Yes"/"No"
  // is the standard convention but we may need to adjust if the picklist
  // restricts to different values. An insert with a wrong picklist value
  // returns INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST.
  const measurementValue = measurementProducts.length > 0 ? 'Yes' : 'No';

  logger.info(
    {
      oppId,
      oppName: opp.Name,
      productsCount: productNames.length,
      measurementProductsCount: measurementProducts.length,
      measurementValue,
    },
    'Loaded Opportunity context for CDS pre-fill'
  );

  // 4. Build the Bucket A field map. Each entry mirrors a left-side
  //    field assignment in the flow's "Create Campaign Details Form
  //    Record" step. Order matches the flow's display order for ease
  //    of cross-reference.
  const bucketA = {
    Name: opp.Name,
    OwnerId: opp.OwnerId,
    Opportunity__c: opp.Id,
    Brand__c: opp.AccountId,
    AM_Lead__c: opp.Account_Manager2__c,
    Agency__c: opp.Agency__c,
    Brand_Vertical__c: opp.Vertical__c,
    Campaign_Start_Date__c: opp.Campaign_Start_Date__c,
    Campaign_End_Date__c: opp.Campaign_End_Date__c,
    // The flow maps CDS.Campaign_Name__c ← Opp.Campaign_Text_ID__c.
    // Fall back to Opp.Name when Campaign_Text_ID__c is empty so the
    // CDS doesn't insert with a null Campaign Name on older Opps that
    // pre-date the structured-name field.
    Campaign_Name__c: opp.Campaign_Text_ID__c || opp.Name,
    Measurement_Products_Included__c: measurementValue,
  };

  return { opp, bucketA };
}

/**
 * Insert a Campaign_Details_Form__c record by merging Opp-derived
 * Bucket A with caller-provided Bucket B (Claude-extracted) values.
 *
 * Bucket B fields are passed as-is — caller is responsible for using
 * the correct CDS API names (e.g. Primary_KPI__c, not "Primary KPI").
 *
 * Future: once Ian adds a Status__c field for the human-in-the-loop
 * draft workflow, we add Status__c='Draft' to bucketA here so the
 * Asana automation can filter on it.
 *
 * @param {string} oppId - Opportunity to base the CDS on
 * @param {object} bucketB - Field map of CDS API name → value
 * @returns {Promise<{id: string, success: boolean, errors: array}>}
 */
async function createDraftCds(oppId, bucketB = {}) {
  const { bucketA, opp } = await loadOppContextForCds(oppId);
  const payload = { ...bucketA, ...bucketB };

  logger.info(
    {
      oppId,
      oppName: opp.Name,
      fieldCount: Object.keys(payload).length,
      bucketAKeys: Object.keys(bucketA),
      bucketBKeys: Object.keys(bucketB),
    },
    'Inserting Campaign_Details_Form__c record'
  );

  const result = await sf.createRecord(CDS_OBJECT, payload);

  logger.info(
    { oppId, cdsId: result.id, success: result.success },
    'Campaign_Details_Form__c record created'
  );

  return result;
}

module.exports = {
  loadOppContextForCds,
  createDraftCds,
  AmLeadNotPopulatedError,
  // Exported for tests + diagnostics
  CDS_OBJECT,
  OPP_FIELDS_FOR_CDS,
  MEASUREMENT_PARTNER_PATTERN,
};
