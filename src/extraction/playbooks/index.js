/**
 * Playbook registry + prompt-context builder.
 *
 * The two playbook files (iroas.js, sales-lift.js) hold the source rules.
 * This module aggregates them and produces:
 *   - PLAYBOOKS: the array of playbook objects, used by tests / future code
 *     that needs to reason about playbook structure programmatically
 *   - buildPlaybooksPromptContext(): a serialized natural-language string
 *     that gets embedded in the Claude system prompt as additional context,
 *     so the model knows what rules to map against the transcript
 *
 * Keeping serialization in this module means the prompt stays in
 * lock-step with the playbook data — change a rule, the prompt updates
 * automatically.
 */

const iroas = require('./iroas');
const salesLift = require('./sales-lift');

const PLAYBOOKS = [iroas, salesLift];

function serializeGate(gate) {
  const lines = [
    `  - id: ${gate.id}`,
    `    action: ${gate.action}`,
    `    title: ${gate.title}`,
    `    detail: ${gate.detail}`,
  ];
  if (gate.conflictTrigger) {
    lines.push(`    conflictTrigger: ${gate.conflictTrigger}`);
  }
  if (gate.onlyApplyIf) {
    lines.push(`    onlyApplyIf: ${gate.onlyApplyIf}`);
  }
  return lines.join('\n');
}

function serializePlaybook(pb) {
  const sections = [
    `### Playbook: ${pb.name} (id: ${pb.id})`,
    ``,
    `Trigger: ${pb.trigger.description}`,
    `Keywords to look for: ${pb.trigger.keywords.join(', ')}`,
    ``,
    `Feasibility gates:`,
    pb.feasibilityGates.map(serializeGate).join('\n'),
  ];
  if (pb.tacticalDefaults && pb.tacticalDefaults.length > 0) {
    sections.push(``, `Tactical defaults (group these under a single check with action=internal_setup, title="Recommended AdOps setup"):`);
    pb.tacticalDefaults.forEach((d) => sections.push(`  - ${d}`));
  }
  if (pb.rulesOfThumb && pb.rulesOfThumb.length > 0) {
    sections.push(``, `Rules of thumb (for context, not as checks):`);
    pb.rulesOfThumb.forEach((r) => sections.push(`  - ${r}`));
  }
  return sections.join('\n');
}

/**
 * Build the natural-language playbook context that gets embedded in the
 * Claude system prompt. Includes a brief instruction header explaining
 * how Claude should use the playbook data to populate playbookChecks.
 */
function buildPlaybooksPromptContext() {
  const header = `
AM Playbook context — for the playbookChecks output field.

When the transcript indicates one or more of these InMarket playbooks
apply (look for the keywords listed under each playbook's Trigger), map
the transcript against the playbook's feasibility gates and output a
playbookCheck for each gate that warrants surfacing in the AM Handoff.

Rules for emitting checks:
  - Emit gates conservatively. Skip a gate when its content is already
    obviously resolved in the transcript (e.g. skip "Confirm 8-week
    duration" if the client and rep both confirmed an 8-week campaign).
  - For gates with conflictTrigger: only emit them if the trigger
    condition is detected in the transcript. When emitted, set
    action=reconcile_conflict and make the detail field call out the
    specific conflict (e.g. "Client requested Moments-only but gIROAS
    caps Moments at 30%").
  - For gates with onlyApplyIf: only emit if the conditional context is
    present (e.g. multi-retailer rules only fire if a multi-retailer
    setup is discussed).
  - If neither playbook is triggered by the transcript, return an empty
    array for playbookChecks.

Output shape for each playbookCheck:
  {
    playbookId: "iroas" | "sales_lift",
    gateId: <one of the gate ids listed below>,
    action: "confirm_with_client" | "internal_check" | "internal_setup" | "sizing_check" | "reconcile_conflict",
    title: <short title — use the gate's title unless context demands tightening>,
    detail: <specific detail tailored to THIS meeting's transcript — not a generic restatement of the gate>
  }

`.trimStart();

  return [header, ...PLAYBOOKS.map(serializePlaybook)].join('\n\n');
}

module.exports = {
  PLAYBOOKS,
  buildPlaybooksPromptContext,
};
