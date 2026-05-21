/**
 * Sales Lift Study Execution Best Practices playbook (source: AM team,
 * shared 2026-05-21).
 *
 * Applies whenever a campaign promises sales-lift measurement (with or
 * without a ROAS guarantee). Often co-applies with the iROAS playbook;
 * Claude can output checks from both when both trigger.
 *
 * Update this file when the AM team revises the playbook.
 */

module.exports = {
  id: 'sales_lift',
  name: 'Sales Lift Study Execution Best Practices',
  shortName: 'Sales Lift',

  trigger: {
    description:
      'Campaigns where sales-lift measurement is on the table — single-retailer or multi-retailer measurement, with or without a ROAS goal/guarantee.',
    keywords: [
      'sales lift',
      'lift study',
      'measurement partner',
      'Pathformance',
      'Ansa',
      'Circana',
      'ABCS',
      'ROAS goal',
      'incremental sales',
    ],
  },

  // Sales Lift rules are mostly process gates — different shape from the
  // iROAS hard requirements. We use the same action enum for renderer
  // consistency, plus a couple of conditional rules that only fire when
  // their trigger is present in the transcript.
  feasibilityGates: [
    {
      id: 'feasibility_check',
      action: 'internal_check',
      title: 'Confirm $1 ROAS feasibility with measurement partner BEFORE promising ROAS',
      detail:
        'Ask the measurement partner (Ansa or Pathformance) whether the campaign can hit $1.00 ROAS. If NO: tell client we deliver sales lift only. If YES: we can deliver both sales lift and ROAS measurement.',
    },
    {
      id: 'never_promise_roas',
      action: 'confirm_with_client',
      title: 'Do NOT promise ROAS up front',
      detail:
        'Never promise a specific ROAS during the sales conversation. If client has a ROAS goal, validate realism with the measurement partner first; possible adjustments include lowering budget, lengthening campaign, or adding larger retailers.',
    },
    {
      id: 'brand_size_expectation',
      action: 'confirm_with_client',
      title: 'Set ROAS expectation based on brand size',
      detail:
        '$1.00 ROAS is break-even — no industry benchmark exists. Larger brands have a much greater opportunity to achieve $1 ROAS; smaller brands are more challenged. Set client expectations accordingly during scoping.',
    },
    {
      id: 'hero_halo_classification',
      action: 'internal_setup',
      title: 'Classify Hero vs Halo products in creative',
      detail:
        'Hero = ALL products featured in creative + slight variations (different flavors, package sizes, scents). Halo = any product carrying the brand name that could be reasonably influenced by the media. Review ALL creative versions. Verify accuracy in Ansa portal if applicable.',
    },
    {
      id: 'single_retailer_setup',
      action: 'internal_setup',
      title: 'Single-retailer campaign: full budget + test/controls in one retailer',
      detail:
        'If measuring lift in a single retailer: the full budget goes to that retailer, and test/control zips exist only in that retailer.',
      onlyApplyIf: 'campaign discussed measures lift in exactly one retailer',
    },
    {
      id: 'multi_retailer_setup',
      action: 'internal_setup',
      title: 'Multi-retailer campaign: budget goal + clean control zips across ALL retailers',
      detail:
        'For multi-retailer campaigns measuring lift in one retailer while running media in others: test/controls identified in the measured retailer (Pathformance or Ansa). Control zips must be CLEAN of media across ALL retailers — not just the measured one. Allocate budget for measured retailer as a "goal" (flexible, not hard-locked on IO). Pathformance recommends budget split per client ROAS goal.',
      onlyApplyIf: 'campaign mentions multiple retailers with measurement in one',
    },
    {
      id: 'multi_retailer_roas_calc',
      action: 'internal_setup',
      title: 'Multi-retailer: calculate ROAS only on MEASURED retailer spend',
      detail:
        'In multi-retailer campaigns, final ROAS is calculated only against the portion of media spend delivered to the measured retailer — NOT total campaign spend. Communicate this methodology to client during scoping.',
      onlyApplyIf: 'campaign mentions multiple retailers with measurement in one',
    },
    {
      id: 'mid_campaign_optimization',
      action: 'internal_setup',
      title: 'AM responsibilities mid-campaign',
      detail:
        'AM pulls Ansa portal data midway through the campaign for optimization. For Pathformance, AM requests data via email. Schedule these touchpoints in the campaign plan.',
    },
    {
      id: 'final_results_handoff',
      action: 'internal_setup',
      title: 'End-of-campaign handoff',
      detail:
        'Final results go to the Insights lead for media recap. Invite Pathformance and/or Ansa to high-profile client meetings to review the data.',
    },
  ],

  // No tactical defaults block — Sales Lift is a process playbook, not a
  // tactical setup recipe. AdOps defaults come from the iROAS playbook
  // when both apply.
  tacticalDefaults: [],

  rulesOfThumb: [
    'For multi-retailer events: ROAS is always calculated against the MEASURED retailer\'s spend only.',
    'Don\'t commit ROAS in front of the client before checking with the measurement partner.',
  ],
};
