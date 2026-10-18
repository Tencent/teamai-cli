import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../workflow/parse.js';

function parse(steps: string) {
  return parseWorkflow('workflows/hitl.yaml', `schemaVersion: v1alpha1\nname: hitl\ndescription: Ask before working.\nsteps:\n${steps}`);
}

describe('HITL request format', () => {
  it('normalizes approve and choose, and omits interactive false', () => {
    const result = parse(`  - id: approve
    approve: Continue?
  - id: choose
    needs: [approve]
    choose: { message: Pick one, options: [build, drop], default: build }
    interactive: false
  - id: pair
    needs: [choose]
    prompt: Work together.
    interactive: true
  - id: alone
    needs: [pair]
    prompt: Work alone.
    interactive: false`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps[0]?.hitl).toEqual({ kind: 'approve', message: 'Continue?', options: ['yes', 'no'], required: false });
    expect(result.definition.steps[1]?.hitl).toEqual({ kind: 'choose', message: 'Pick one', options: ['build', 'drop'], default: 'build', required: false });
    expect(result.definition.steps[2]?.interactive).toBe(true);
    expect(result.definition.steps[3]?.interactive).toBeUndefined();
  });

  it.each([
    ['approve: ""', 'approve'],
    ['approve: { required: true }', 'approve.message'],
    ['approve: { message: Go, required: yes }', 'approve.required'],
    ['choose: { message: Pick, options: [one] }', 'choose.options'],
    ['choose: { message: Pick, options: [one, one] }', 'choose.options'],
    ['choose: { message: Pick, options: [one, "two words"] }', 'choose.options'],
    ['choose: { message: Pick, options: [one, two], default: three }', 'choose.default'],
    ['choose: { message: Pick, options: [one, two], required: true, default: one }', 'choose.required'],
    ['approve: Go\n    choose: { message: Pick, options: [one, two] }', 'choose'],
    ['choose: { message: Pick, options: [one, two] }\n    command: echo no', 'choose'],
    ['approve: Go\n    command: echo no\n    for_each: inputs.items', 'for_each'],
    ['interactive: true\n    command: echo no', 'interactive'],
    ['interactive: yes\n    prompt: Work', 'interactive'],
  ])('rejects %s at its YAML key', (fields, key) => {
    const result = parse(`  - id: ask\n    ${fields}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.field)).toContain(`steps[0].${key}`);
  });

  it.each(['approve', 'choose'])('drops cached meanings for unknown %s keys', (kind) => {
    const result = parse(`  - id: ask\n    ${kind}: { message: Go, options: [one, two], typo: true }`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ field: `steps[0].${kind}.typo`, code: 'unknown_key' }));
  });

  it('checks HITL templates and choice reads against the declared options', () => {
    const result = parse(`  - id: ask
    choose: { message: Pick, options: [build, drop] }
  - id: build
    needs: [ask]
    if: steps.ask.choice == 'typo'
    approve: "Build {{ steps.ask.note }}?"
    command: echo build`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ field: 'steps[1].if', message: expect.stringContaining('not one of its options') }));
  });

  it.each(['choice', 'note'])('rejects %s on a step with no HITL', (field) => {
    const result = parse(`  - id: work
    command: echo ok
  - id: ask
    needs: [work]
    approve: "{{ steps.work.${field} }}"`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ field: 'steps[1].approve.message', code: 'bad_template', message: expect.stringContaining('has no approve or choose') }));
  });

  it('reports a bad approve template at the message line in mapping form', () => {
    const result = parse(`  - id: ask
    approve:
      required: true
      message: "{{ inputs.nope }}"`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      file: 'workflows/hitl.yaml', field: 'steps[0].approve.message', code: 'bad_template', line: 8,
    }));
  });

  it('allows choice and note in passes and HITL-only loops', () => {
    const result = parse(`  - id: plan
    prompt: "Revise {{ steps.decide.note }} {{ steps.decide.passes[0].choice }}"
  - id: decide
    needs: [plan]
    choose: { message: Pick, options: [build, revise] }
    loop: { back_to: plan, while: "steps.decide.choice == 'revise'", max_iterations: 3 }`);
    expect(result.ok).toBe(true);
  });
});


it('checks unknown HITL keys even when both YAML spellings are present', () => {
  const result = parse('  - id: ask\n    approve: Continue?\n    choose: { message: Pick, options: [one, two], future: true }');
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ field: 'steps[0].choose.future', code: 'unknown_key' }));
});
