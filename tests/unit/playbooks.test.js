/**
 * Tests for the playbook rules + prompt-context builder. These verify
 * the data shape is internally consistent so a future refactor can't
 * silently break the gate→prompt→Claude→render pipeline.
 */

const { PLAYBOOKS, buildPlaybooksPromptContext } = require('../../src/extraction/playbooks');
const iroas = require('../../src/extraction/playbooks/iroas');
const salesLift = require('../../src/extraction/playbooks/sales-lift');

const VALID_ACTIONS = new Set([
  'confirm_with_client',
  'internal_check',
  'internal_setup',
  'sizing_check',
  'reconcile_conflict',
]);

describe('playbook rule files', () => {
  test('PLAYBOOKS array contains the two known playbooks', () => {
    expect(PLAYBOOKS).toHaveLength(2);
    expect(PLAYBOOKS.map((p) => p.id).sort()).toEqual(['iroas', 'sales_lift']);
  });

  test.each(PLAYBOOKS)('$id has required top-level shape', (pb) => {
    expect(typeof pb.id).toBe('string');
    expect(typeof pb.name).toBe('string');
    expect(typeof pb.shortName).toBe('string');
    expect(pb.trigger).toMatchObject({
      description: expect.any(String),
      keywords: expect.any(Array),
    });
    expect(pb.trigger.keywords.length).toBeGreaterThan(0);
    expect(Array.isArray(pb.feasibilityGates)).toBe(true);
    expect(pb.feasibilityGates.length).toBeGreaterThan(0);
  });

  test('every feasibility gate has the required fields and a valid action', () => {
    for (const pb of PLAYBOOKS) {
      for (const gate of pb.feasibilityGates) {
        expect(gate).toMatchObject({
          id: expect.any(String),
          action: expect.any(String),
          title: expect.any(String),
          detail: expect.any(String),
        });
        expect(VALID_ACTIONS.has(gate.action)).toBe(true);
        expect(gate.id.length).toBeGreaterThan(0);
      }
    }
  });

  test('gate ids are unique within each playbook', () => {
    for (const pb of PLAYBOOKS) {
      const ids = pb.feasibilityGates.map((g) => g.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('iROAS has 8 gates covering the documented requirements', () => {
    expect(iroas.feasibilityGates).toHaveLength(8);
    const ids = iroas.feasibilityGates.map((g) => g.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'min_duration',
        'national_preferred',
        'sku_volume',
        'core_kpi',
        'min_impressions',
        'frequency',
        'moments_cap',
        'feasibility_form',
      ])
    );
  });

  test('iROAS moments_cap gate is flagged as a conflict trigger', () => {
    const momentsCap = iroas.feasibilityGates.find((g) => g.id === 'moments_cap');
    expect(momentsCap.action).toBe('reconcile_conflict');
    expect(momentsCap.conflictTrigger).toBeDefined();
    expect(momentsCap.conflictTrigger).toMatch(/Moments/i);
  });

  test('iROAS includes tactical defaults and rules of thumb', () => {
    expect(iroas.tacticalDefaults.length).toBeGreaterThan(0);
    expect(iroas.rulesOfThumb.length).toBe(2);
  });

  test('Sales Lift has conditional gates with onlyApplyIf', () => {
    const conditionals = salesLift.feasibilityGates.filter((g) => g.onlyApplyIf);
    expect(conditionals.length).toBeGreaterThan(0);
    expect(conditionals.every((g) => typeof g.onlyApplyIf === 'string')).toBe(true);
  });
});

describe('buildPlaybooksPromptContext', () => {
  let context;

  beforeAll(() => {
    context = buildPlaybooksPromptContext();
  });

  test('returns a non-empty natural-language string', () => {
    expect(typeof context).toBe('string');
    expect(context.length).toBeGreaterThan(500);
  });

  test('includes both playbooks by id', () => {
    expect(context).toContain('iroas');
    expect(context).toContain('sales_lift');
  });

  test('includes the critical Moments cap rule (specific business rule)', () => {
    expect(context).toContain('Moments');
    expect(context).toContain('30%');
  });

  test('includes the iROAS trigger keywords', () => {
    expect(context).toContain('iROAS');
    expect(context).toContain('sales lift');
  });

  test('includes the Sales Lift measurement partner names', () => {
    expect(context).toContain('Pathformance');
    expect(context).toContain('Ansa');
  });

  test('includes output shape instructions for Claude', () => {
    expect(context).toMatch(/playbookId/);
    expect(context).toMatch(/gateId/);
    expect(context).toMatch(/reconcile_conflict/);
  });

  test('serializes every gate id from both playbooks', () => {
    for (const pb of PLAYBOOKS) {
      for (const gate of pb.feasibilityGates) {
        expect(context).toContain(gate.id);
      }
    }
  });
});
