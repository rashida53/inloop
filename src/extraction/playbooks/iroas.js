/**
 * Guaranteed iROAS Sales Lift playbook (source: AM team, shared 2026-05-21).
 *
 * Drives the playbookChecks output when Claude detects an opportunity is
 * seeking iROAS guarantee / sales-lift measurement. The rules are
 * embedded as context in the Claude system prompt, and Claude maps them
 * against the transcript to produce a structured checklist.
 *
 * Update this file when the AM team revises the playbook — there's no
 * other source of truth referenced at runtime.
 */

module.exports = {
  id: 'iroas',
  name: 'Guaranteed iROAS Sales Lift',
  shortName: 'gIROAS',

  // Hints to help Claude decide whether this playbook applies. Claude
  // reads these alongside the transcript and decides whether to populate
  // playbookChecks for this meeting.
  trigger: {
    description:
      'Opportunities where the client wants a guaranteed ROAS outcome or sales-lift measurement is on the table.',
    keywords: [
      'iROAS',
      'guaranteed iROAS',
      'gIROAS',
      'ROAS guarantee',
      'incremental ROAS',
      'sales lift',
      'lift measurement',
    ],
  },

  // The 8 hard feasibility gates. Each gate has an `action` enum that
  // tells the renderer how to badge it:
  //   - confirm_with_client  → ⚠️ "Confirm in next conversation"
  //   - internal_check       → 📊 "Internal data/team verification"
  //   - internal_setup       → ⚙️ "AdOps configuration"
  //   - sizing_check         → 📐 "Budget/impression sizing"
  //   - reconcile_conflict   → 🚨 "Surface as conflict if triggered"
  feasibilityGates: [
    {
      id: 'min_duration',
      action: 'confirm_with_client',
      title: 'Campaign duration ≥ 8 weeks',
      detail:
        'gIROAS requires campaigns of at least 8 weeks (preferably national). Confirm planned duration with client.',
    },
    {
      id: 'national_preferred',
      action: 'confirm_with_client',
      title: 'National campaign preferred',
      detail:
        'National geo is the preferred footprint for gIROAS. If client wants a regional/single-retailer focus, flag this as a tradeoff.',
    },
    {
      id: 'sku_volume',
      action: 'internal_check',
      title: 'Product/SKU has 5K+ purchases in last 12 weeks',
      detail:
        'Internal data check: verify the product/SKU has at least 5K purchases in our data over the trailing 12 weeks. If insufficient volume, gIROAS not feasible.',
    },
    {
      id: 'core_kpi',
      action: 'confirm_with_client',
      title: 'iROAS is the core KPI (not CTR)',
      detail:
        'Client must explicitly agree iROAS is the core KPI. CTR will NOT be optimized — expect 0.1-0.3 CTR on average campaigns. Set this expectation before the proposal goes out.',
    },
    {
      id: 'min_impressions',
      action: 'sizing_check',
      title: 'Minimum 7.5M impressions',
      detail:
        'Budget must support at least 7.5M impressions for the gIROAS guarantee to be honored. Validate against proposed budget tier(s).',
    },
    {
      id: 'frequency',
      action: 'internal_setup',
      title: 'Frequency target 3-4 across the full campaign',
      detail:
        'Setup target: 3-4 frequency measured across the entire campaign (not weekly/monthly cap). AdOps configures.',
    },
    {
      id: 'moments_cap',
      action: 'reconcile_conflict',
      title: 'Moments ≤ 30% of budget (hard cap)',
      detail:
        'gIROAS caps Moments at no more than 30% of total budget. If client requested Moments-heavy mix or "Moments-only", this is a hard CONFLICT that needs reconciling — either de-scope the Moments preference or move off gIROAS guarantee.',
      conflictTrigger: 'client expressed preference for Moments-heavy or Moments-only mix',
    },
    {
      id: 'feasibility_form',
      action: 'internal_setup',
      title: 'File feasibility form for Andrew & Michael approval',
      detail:
        'Every gIROAS opportunity that meets the requirements above must be submitted via the feasibility form for approval by both Andrew and Michael. Margin approvals follow the standard process separately.',
    },
  ],

  // Default operational settings the AM/AdOps team should apply when
  // setting up a gIROAS campaign. Surfaced as a single grouped item in
  // the digest so the AM has the recipe in front of them.
  tacticalDefaults: [
    'Audiences (P/A line items only): ISO (InStore Sales Optimizations) at high bid, Retargeting — store/retail visitors (regular bid), purchasers & competitors (very high bid), Expanded audiences (regular bid), Lost/lapsed.',
    'Dayparting: no serving between midnight and 6am.',
    'Frequency cap: 1/week until soft caps are in place (watch for delivery).',
    'DSP optimization type: conversions (optimized toward conversion bundles).',
  ],

  rulesOfThumb: [
    'Low Reach + High Frequency → high sales lift figure, LOW iROAS.',
    'High Reach + Low/Maintained Frequency → lower sales lift, STRONGER iROAS.',
  ],
};
