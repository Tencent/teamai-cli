/**
 * Pull of a team teamai-score.yaml: an override may reword the judge prompt or drop a stage, and is refused, with
 * teamai's default kept in effect, when it changes what the run takes or gives, runs other commands, drops a verb that
 * keeps a label honest, or lets a prompt read more than the evidence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { listCachedWorkflows, syncWorkflowDefinitions } from '../workflow/cache.js';
import { formatDiagnostic } from '../workflow/parse.js';

const SHIPPED = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'workflows', 'teamai-score.yaml'), 'utf8');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function teamWith(files: Record<string, string>): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-override-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(knowledge, 'workflows', `${name}.yaml`), body);
  return { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
}

/** The shipped file with `from` replaced by `to`, which must be in it. */
function shippedWith(from: string, to: string): string {
  if (!SHIPPED.includes(from)) throw new Error(`the shipped teamai-score.yaml has no ${from}`);
  return SHIPPED.replace(from, to);
}

/** Pulls `files`; the codes of what pull refused, and where teamai-score comes from after it. */
async function pulled(files: Record<string, string>): Promise<{ codes: Array<string | undefined>; refused: string[]; source: string | undefined; warned: string[] }> {
  const config = teamWith(files);
  const warn = vi.spyOn(log, 'warn');
  const result = await syncWorkflowDefinitions(config);
  const source = (await listCachedWorkflows(config)).find(({ definition }) => definition.name === 'teamai-score')?.source;
  return { codes: result.invalid.map(({ code }) => code), refused: result.invalid.map(formatDiagnostic), source, warned: warn.mock.calls.map(([message]) => String(message)) };
}

const JUDGE_PROMPT = 'Judge one piece of work against a scorer\'s rubric.';

describe('a team teamai-score.yaml', () => {
  it('replaces the default when it rewords the judge prompt around the rubric and the schema', async () => {
    const reworded = shippedWith(JUDGE_PROMPT, 'Judge this change for our team, strictly.');

    expect(await pulled({ 'teamai-score': reworded })).toMatchObject({ codes: [], source: 'team' });
  });

  it.each([
    ['takes another input', shippedWith('  batch: boolean\n', '  batch: boolean\n  ticket: string\n'), 'score_override_contract'],
    ['gives another output', shippedWith('outputs: { labels: steps.score.results }', 'outputs: { labels: steps.score.results, plan: steps.plan.outputs.groups }'), 'score_override_contract'],
    ['is not private', shippedWith('private: true\n', ''), 'score_override_contract'],
    ['lets an agent start it', shippedWith('invoke: deny', 'invoke: allow'), 'score_override_contract'],
    ['runs a verb with other arguments', shippedWith('--wait 2h', '--wait 0s'), 'score_override_command'],
    ['gives a verb other env', shippedWith('env: { DIR: "{{ steps.evidence.outputs.dir }}" }\n          output: { decided: boolean }\n        - id: ci', 'env: { DIR: "{{ steps.evidence.outputs.dir }}", EXTRA: "1" }\n          output: { decided: boolean }\n        - id: ci'), 'score_override_command'],
    ['drops settle', SHIPPED.slice(0, SHIPPED.indexOf('        - id: settle')) + 'outputs: { labels: steps.score.results }\n', 'score_override_step_missing'],
    ['lets the judge read the checkout', shippedWith('          workspace: { confined: "{{ steps.evidence.outputs.dir }}" }\n', ''), 'score_override_prompt'],
    ['has a judge prompt that does not read the schema', shippedWith('the schema in {{ steps.evidence.outputs.schema }}', 'the schema'), 'score_override_judge_prompt'],
    ['confines the judge to a directory no step before it wrote', shippedWith('workspace: { confined: "{{ steps.evidence.outputs.dir }}" }', 'workspace: { confined: evidence }'), 'score_override_confined_dir'],
    ['confines the judge to an output of a step it does not need', shippedWith('workspace: { confined: "{{ steps.evidence.outputs.dir }}" }', 'workspace: { confined: "{{ steps.check.outputs.decided }}" }'), 'score_override_confined_dir'],
    ['runs an inline workflow of its own', shippedWith('  - id: score\n', '  - id: notes\n    needs: [plan]\n    workflow:\n      steps:\n        - id: note\n          command: echo noted\n  - id: score\n'), 'score_override_workflow_step'],
  ])('is refused at pull when it %s, and the default stays in effect', async (_, body, code) => {
    const { codes, source } = await pulled({ 'teamai-score': body });

    expect(codes).toContain(code);
    expect(source).toBe('default');
  });

  it('says what each refusal breaks, by the field, at the top of the file', async () => {
    const dropped = SHIPPED.slice(0, SHIPPED.indexOf('        - id: settle')) + 'outputs: { labels: steps.score.results }\n';

    expect((await pulled({ 'teamai-score': shippedWith('private: true\n', '') })).refused).toEqual([
      'workflows/teamai-score.yaml:1: field "private": is not private, so its steps\' sessions and outputs could leave this machine. Set private: true',
    ]);
    expect((await pulled({ 'teamai-score': dropped })).refused).toEqual([
      'workflows/teamai-score.yaml:1: field "steps": drops step score.settle, which every label of teamai\'s default teamai-score goes through. Keep it',
    ]);
  });

  it('is refused as another workflow whose alias is teamai-score', async () => {
    const aliased = shippedWith('name: teamai-score', 'name: our-score\nalias: teamai-score');

    expect(await pulled({ 'our-score': aliased })).toMatchObject({ codes: ['default_override_alias'], source: 'default' });
  });

  it('warns at pull on a team step that runs teamai-score with no timeout, which only a timeout ends while its judge waits', async () => {
    const wrapper = `schemaVersion: v1alpha1
name: score-this
description: Score a session.
inputs: { subject: string }
steps:
  - id: score
    workflow: teamai-score
    with: { subject: "{{ inputs.subject }}", scorers: [], label: "", batch: false, demand: named }
`;

    expect((await pulled({ 'score-this': wrapper })).warned).toContain('[workflows] workflows/score-this.yaml: step "score" runs teamai-score with no timeout, so a judge no driver here can take holds it open until the run ends. Give it a timeout, such as timeout: 30m, and continue_on_failure: true.');
  });

  it('does not warn on a step that runs teamai-score with a timeout, or on one that runs another workflow', async () => {
    const wrapper = (step: string) => `schemaVersion: v1alpha1
name: score-this
description: Score a session.
inputs: { subject: string }
steps:
${step}`;
    const timed = '  - id: score\n    workflow: teamai-score\n    with: { subject: "{{ inputs.subject }}", scorers: [], label: "", batch: false, demand: named }\n    timeout: 30m\n    continue_on_failure: true\n';
    const other = '  - id: share\n    workflow: teamai-share-session\n    with: { session: "{{ inputs.subject }}", source: claude-code, publish: false, scorers: [], judge: here, demand: named }\n';

    for (const step of [timed, other]) expect((await pulled({ 'score-this': wrapper(step) })).warned.filter((line) => line.includes('no timeout'))).toEqual([]);
  });
});
