/**
 * Pull of a team workflow with a step that says `scorers.start: workflow`: the scoring module starts no run for its
 * passes, so pull warns unless a `workflow: teamai-score` step after it reads `teamai score subjects` for that step.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A team workflow that takes teamai-score's inputs and scores nothing. */
const REVIEW_IT = `schemaVersion: v1alpha1
name: review-it
description: Review a subject.
inputs: { subject: string, scorers: [string], label: string, batch: boolean, demand: string }
steps:
  - id: review
    command: "true"
`;

/** What pull warned about the team workflow `fix-until-good`, whose steps after `fix` are `after`, beside `review-it`. */
async function warned(after: string): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-subjects-pull-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'review-it.yaml'), REVIEW_IT);
  fs.writeFileSync(path.join(knowledge, 'workflows', 'fix-until-good.yaml'), `schemaVersion: v1alpha1
name: fix-until-good
description: Fix a change.
inputs: { task: string }
steps:
  - id: fix
    prompt: "{{ inputs.task }}"
    scorers: { names: [review-quality], start: workflow }
${after}`);
  const config: LocalConfig = { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  const warn = vi.spyOn(log, 'warn');
  const result = await syncScorersThenWorkflows(config);
  expect(result.invalid).toEqual([]);
  return warn.mock.calls.map(([message]) => String(message));
}

const SUBJECTS = `  - id: subjects
    needs: [fix]
    command: teamai score subjects --run "$RUN" --step fix
    env: { RUN: "{{ run.id }}" }
    output: { list: [string] }
`;
const SCORE = `  - id: score
    needs: [subjects]
    for_each: steps.subjects.outputs.list
    workflow: teamai-score
    with: { subject: "{{ item }}", scorers: [], label: '', batch: false, demand: named }
    timeout: 1h
    continue_on_failure: true
`;
const UNREAD = '[workflows] workflows/fix-until-good.yaml: step "fix" says scorers.start: workflow, and no workflow: teamai-score step after it reads teamai score subjects --step fix, so its passes are scored only after the run ended, by the next teamai-finished-sessions that teamai score --drain or a session start runs. Add those steps, or drop start: workflow.';

describe('pull of a step that says scorers.start: workflow', () => {
  it('warns when no step after it scores its passes', async () => {
    expect(await warned('')).toContain(UNREAD);
  });

  it('warns when the subjects it lists reach no teamai-score step', async () => {
    expect(await warned(SUBJECTS)).toContain(UNREAD);
  });

  it.each([
    ['lists the subjects of another step', SUBJECTS.replace('--step fix', '--step review') + SCORE],
    ['runs another teamai command for it', SUBJECTS.replace('teamai score subjects --run', 'teamai score --run') + SCORE],
    ['reaches a workflow other than teamai-score', SUBJECTS + SCORE.replace('workflow: teamai-score', 'workflow: review-it')],
  ])('warns when the step before teamai-score %s', async (_, after) => {
    expect(await warned(after)).toContain(UNREAD);
  });

  it.each([
    ['--run "$RUN" --step fix', SUBJECTS + SCORE],
    ['--step=fix --run "$RUN"', SUBJECTS.replace('--run "$RUN" --step fix', '--step=fix --run "$RUN"') + SCORE],
    ['--step fix --run "$RUN"', SUBJECTS.replace('--run "$RUN" --step fix', '--step fix --run "$RUN"') + SCORE],
  ])('does not warn when a teamai-score step reads teamai score subjects %s for it', async (_, after) => {
    expect(await warned(after)).not.toContain(UNREAD);
  });
});
