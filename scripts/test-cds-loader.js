#!/usr/bin/env node
/**
 * scripts/test-cds-loader.js
 *
 * Exercise loadOppContextForCds and createDraftCds against a real Opp
 * in the sandbox. Prints what the CDS payload would look like, then
 * (optionally) inserts a draft CDS record so we can verify it lands
 * cleanly in Salesforce.
 *
 * Run:
 *   TEST_OPP_ID=006Rd00000XKgRVIA1 node scripts/test-cds-loader.js
 *
 * Skip the actual CDS insert (dry run):
 *   TEST_OPP_ID=... DRY_RUN=1 node scripts/test-cds-loader.js
 */

require('dotenv').config();
const cds = require('../src/integrations/salesforce-cds');
const db = require('../src/db');

const TEST_OPP_ID = process.env.TEST_OPP_ID;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

function banner(t) {
  const bar = '='.repeat(60);
  console.log(`\n${bar}\n  ${t}\n${bar}`);
}

if (!TEST_OPP_ID) {
  console.error('Set TEST_OPP_ID. Run seed-sandbox-opp.js first to create one.');
  process.exit(1);
}

// Stand-in Bucket B values that simulate what Claude would extract
// from a Taylor Farms-style meeting transcript. Real orchestrator
// builds this from intelligence.playbookChecks + transcript.
const SAMPLE_BUCKET_B = {
  Primary_KPI__c: 'iROAS',
  Primary_KPI_Client_Benchmark__c: '$14+ iROAS (cited from category case study)',
  Moments_vs_Precep_Audiences_Allocation__c: '30/70',
  Are_There_Flighted_Budgets__c: 'Yes',
  Budget_Goal_Tier_1__c: 150000,
  Budget_Goal_Tier_2__c: 300000,
  Custom_Mocks_Needed__c: 'Yes',
  Geo_Targeting_and_Restrictions__c:
    'National: Whole Foods, Sprouts, Meijer. Regional: Publix (Fresh Express conquest)',
  Moments_Targeting__c: 'InPath InStore (50%) — heavy buyers + new-to-brand',
  Precep_Aud_Out_of_Location_Targeting__c:
    'Known Shoppers of WF, Sprouts, Meijer. Purchasers of Earthbound Farms, salad kits, produce. Moms with kids, healthy organic purchasers.',
  Notes__c:
    '<p>Dates: 8/1 - 10/31. $150k tier: CPE .70, CPM $7.50, 5% bonus impressions. $300k tier: CPE .65, CPM $6.50, 10% bonus impressions. Sales lift mandatory across all plans.</p>',
};

async function main() {
  banner('Loading Opp context for CDS');
  console.log('Opp Id:', TEST_OPP_ID);

  const { opp, bucketA } = await cds.loadOppContextForCds(TEST_OPP_ID);

  banner('Raw Opp record');
  console.log(JSON.stringify(opp, null, 2));

  banner('Bucket A (Opp/products-derived field map)');
  console.log(JSON.stringify(bucketA, null, 2));

  banner('Bucket B (simulated Claude-extracted values)');
  console.log(JSON.stringify(SAMPLE_BUCKET_B, null, 2));

  const merged = { ...bucketA, ...SAMPLE_BUCKET_B };

  banner('Merged CDS payload');
  console.log(JSON.stringify(merged, null, 2));

  if (DRY_RUN) {
    banner('DRY_RUN=1 — skipping actual insert');
    return;
  }

  banner('Inserting Campaign_Details_Form__c via createDraftCds...');
  const result = await cds.createDraftCds(TEST_OPP_ID, SAMPLE_BUCKET_B);
  console.log('Salesforce response:');
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    banner('Success — new CDS record id:');
    console.log('  ' + result.id);
    console.log('');
    console.log('Open in Salesforce sandbox:');
    console.log(
      `  https://inmarket--aibuilder.sandbox.lightning.force.com/lightning/r/Campaign_Details_Form__c/${result.id}/view`
    );
  } else {
    banner('Insert FAILED — see errors above');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    banner('Error');
    console.error(err.message);
    if (err.code === 'AM_LEAD_NOT_POPULATED') {
      console.error('Fix: set Account_Manager2__c on Opp', err.oppId);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.shutdown().catch(() => {});
  });
