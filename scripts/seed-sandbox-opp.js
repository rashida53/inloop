#!/usr/bin/env node
/**
 * scripts/seed-sandbox-opp.js
 *
 * Create a test Opportunity in the connected Salesforce org (sandbox)
 * so loadOppContextForCds can be exercised end-to-end against real data.
 *
 * What it does:
 *   1. Resolves the authenticated user's Id via /services/oauth2/userinfo
 *   2. Describes Opportunity to find valid picklist values for
 *      StageName and Vertical__c (so we don't 400 on a bad enum)
 *   3. Creates an Opportunity owned by the current user with the CDS-
 *      relevant fields populated (AccountId, Account_Manager2__c,
 *      Vertical__c, Campaign_*_Date__c, Campaign_Text_ID__c)
 *   4. Prints the new Opp Id for use with downstream tests
 *
 * Run:
 *   node scripts/seed-sandbox-opp.js
 *
 * Override the test Account:
 *   TEST_ACCOUNT_ID=001Ru00001WofmdIAB node scripts/seed-sandbox-opp.js
 *
 * Not idempotent — each run creates a fresh Opp. That's fine for
 * sandbox tinkering; production wouldn't use this script.
 */

require('dotenv').config();
const sf = require('../src/integrations/salesforce-api');
const db = require('../src/db');

const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || '001Ru00001WofmdIAB';

function banner(t) {
  const bar = '='.repeat(60);
  console.log(`\n${bar}\n  ${t}\n${bar}`);
}

function isoDateOffsetDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
}

async function fetchCurrentUserId() {
  const { access_token, instance_url } = await sf.ensureValidAccessToken();
  const url = `${instance_url}/services/oauth2/userinfo`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`userinfo failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return await res.json();
}

function pickPicklistValue(field, predicates) {
  if (!field || !Array.isArray(field.picklistValues)) {
    throw new Error(`Field ${field?.name || '<unknown>'} has no picklist values`);
  }
  const active = field.picklistValues.filter((v) => v.active);
  for (const pred of predicates) {
    const match = active.find((v) => pred.test(v.value));
    if (match) return match.value;
  }
  return active[0]?.value;
}

async function main() {
  banner('Seed sandbox Opportunity');

  // 1. Current user (will become Owner + AM Lead)
  const userInfo = await fetchCurrentUserId();
  console.log('Authenticated as:');
  console.log('  user_id:           ', userInfo.user_id);
  console.log('  preferred_username:', userInfo.preferred_username);
  console.log('  organization_id:   ', userInfo.organization_id);

  // 2. Look up valid picklist values to avoid INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST
  banner('Resolving valid picklist values');
  const oppDesc = await sf.describeObject('Opportunity');

  const stageField = oppDesc.fields.find((f) => f.name === 'StageName');
  const chosenStage = pickPicklistValue(stageField, [
    /Proposal/i,
    /Quote/i,
    /Negotiation/i,
    /Discovery/i,
  ]);
  console.log('Chosen StageName:    ', chosenStage);

  const verticalField = oppDesc.fields.find((f) => f.name === 'Vertical__c');
  // Print all valid options for visibility — the sandbox has a "CPG Opp Alert"
  // process trigger that fires on CPG-vertical Opps and fails because the
  // sandbox user's email domain isn't verified. Pick a non-CPG default
  // (Retail, Tech, Auto, etc.) to dodge it. Override via VERTICAL env var.
  const allVerticals = verticalField.picklistValues
    .filter((v) => v.active)
    .map((v) => v.value);
  console.log('All valid Vertical__c values:');
  allVerticals.forEach((v) => console.log('  -', v));

  let chosenVertical;
  if (process.env.VERTICAL) {
    if (!allVerticals.includes(process.env.VERTICAL)) {
      throw new Error(
        `VERTICAL=${process.env.VERTICAL} is not a valid picklist value. See list above.`
      );
    }
    chosenVertical = process.env.VERTICAL;
  } else {
    // Pick a non-CPG default to avoid the CPG Opp Alert process trigger.
    chosenVertical = pickPicklistValue(verticalField, [
      /^Retail/i,
      /^Tech/i,
      /^Auto/i,
      /^Travel/i,
      /^Restaurant/i,
      /^Other/i,
      /^(?!CPG)/i, // any non-CPG value
    ]);
  }
  console.log('Chosen Vertical__c:  ', chosenVertical);

  // 3. Build the Opp payload
  const closeDate = isoDateOffsetDays(90);
  const startDate = isoDateOffsetDays(60);
  const endDate = isoDateOffsetDays(150);

  // Campaign_Start_Date__c, Campaign_End_Date__c, and Campaign_Text_ID__c
  // are read-only for our user profile — they're populated by Salesforce
  // automation (Flow/trigger) when products are added to the Opp, not by
  // direct write. Ian confirmed in the 2026-05-22 meeting that "Opportunity
  // creation triggers automatic revenue opportunity generation that pulls
  // earliest start date and latest end date from products." We leave
  // these null on the seed Opp; the CDS loader's Campaign_Text_ID__c-or-
  // fallback-to-Name handling exercises the empty path. To populate them,
  // we'd need to add OpportunityLineItems via a second API call after this.
  const oppPayload = {
    Name: `TEST — InLoop Sandbox Seed (Taylor Farms BTS) — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    StageName: chosenStage,
    CloseDate: closeDate,
    AccountId: TEST_ACCOUNT_ID,
    OwnerId: userInfo.user_id,
    Account_Manager2__c: userInfo.user_id,
    Vertical__c: chosenVertical,
  };

  banner('Opp payload to insert');
  console.log(JSON.stringify(oppPayload, null, 2));

  banner('Creating Opportunity...');
  const result = await sf.createRecord('Opportunity', oppPayload);
  console.log('Salesforce response:');
  console.log(JSON.stringify(result, null, 2));

  if (!result.success) {
    banner('Insert FAILED — see errors above');
    process.exit(1);
  }

  banner('Success — record this Opp Id for later tests');
  console.log(`  TEST_OPP_ID=${result.id}`);
  console.log('');
  console.log('To verify with the CDS loader, run:');
  console.log('  TEST_OPP_ID=' + result.id + ' node scripts/test-cds-loader.js');
}

main()
  .catch((err) => {
    banner('Error');
    console.error(err.message);
    if (err.response) console.error(JSON.stringify(err.response, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.shutdown().catch(() => {});
  });
