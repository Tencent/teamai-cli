/**
 * Real CLI for the score verbs: a skill-driven run's scored step starts the default teamai-score run, which the same
 * session drives, and its judge step goes to a fresh subagent of that session. The subagent's answer becomes a label
 * that `teamai score label` keeps, judged by the session's tool at best-effort with read access.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadLocalConfigForScope } from '../../config.js';
import { syncScorersThenWorkflows } from '../../scorers/team-sync.js';
import { LabelStore } from '../../scorers/label-store.js';
import { AttemptIdSchema, RunIdSchema } from '../../workflow/store.js';
import { skillHarness } from '../helpers/skill-harness.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

const REVIEW = `schemaVersion: v1alpha1
name: review
description: Review the change
invoke: allow
steps:
  - id: review
    prompt: Review the change.
    scorers: [review-quality]
`;

const REVIEW_QUALITY = `---
labels:
  - { value: thorough, score: 1, description: Did the work it was asked for }
  - { value: shallow, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
---
Judge the review.
`;

type Harness = Awaited<ReturnType<typeof skillHarness>>;

const DispatchSchema = z.object({ kind: z.literal('dispatch'), attempt: AttemptIdSchema, step: z.string(), brief: z.string(), ack: z.string() });
const TurnSchema = z.object({ data: z.object({ turn: z.object({ actions: z.array(z.object({ kind: z.string() }).passthrough()), events: z.array(z.object({ kind: z.string() }).passthrough()) }) }) });

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * A member's user-scope install under a home of its own, which the teamai the steps run reads too: a team repository
 * holding REVIEW and its scorer, and a checkout. On PATH: a teamai that runs the built CLI, and a claude with no verified
 * judge profile, so the session judges.
 */
async function install(): Promise<{ root: string; home: string; checkout: string; config: NonNullable<Awaited<ReturnType<typeof loadLocalConfigForScope>>> }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-judge-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const team = path.join(home, '.teamai', 'team-repo');
  const checkout = path.join(root, 'work');
  for (const dir of [path.join(team, 'workflows'), path.join(team, 'scorers'), checkout, path.join(root, 'bin')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(team, 'teamai.yaml'), 'team: acme\nrepo: https://example.test/acme/team.git\n');
  fs.writeFileSync(path.join(team, 'workflows', 'review.yaml'), REVIEW);
  fs.writeFileSync(path.join(team, 'scorers', 'review-quality.md'), REVIEW_QUALITY);
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), `repo:\n  localPath: ${team}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n`);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  fs.writeFileSync(path.join(root, 'bin', 'teamai'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin', 'claude'), `#!${process.execPath}\nconsole.log('0.0.1 (Claude Code)');\n`, { mode: 0o755 });
  atHome(root, home);
  const config = await loadLocalConfigForScope('user', undefined, { dryRun: true });
  if (!config) throw new Error('the member has no user-scope config');
  await syncScorersThenWorkflows(config);
  return { root, home, checkout, config };
}

/** HOME is `home`, and PATH starts with the fixture's own bin. */
function atHome(root: string, home: string): void {
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('PATH', `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`);
}

/**
 * Works the child `dispatch` names as the session's subagent would: acks it, leaves `output` as its result, and reports
 * it, for the run its ack names, which is the run that scores a pass for a judge.
 */
async function worked(harness: Harness, dispatch: z.infer<typeof DispatchSchema>, output: unknown): Promise<void> {
  const run = RunIdSchema.parse(/ (r[0-9a-f]+) /u.exec(dispatch.ack)?.[1]);
  await harness.call({ kind: 'ack', run, attempt: dispatch.attempt });
  const file = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(dispatch.brief, 'utf8'))?.[1];
  if (!file) throw new Error(`${dispatch.brief} names no result file`);
  fs.writeFileSync(file, JSON.stringify({ kind: 'output', output }));
  expect(await harness.call({ kind: 'report', run, attempt: dispatch.attempt, role: 'agent', modelUnavailable: false })).toMatchObject({ data: { runner: { status: 'reported' } } });
}

describe('a skill-driven session judges its run with a subagent', () => {
  it('keeps the label its subagent judge gave, judged by the session tool at best-effort with read access', async () => {
    const member = await install();
    const harness = await skillHarness({}, { install: { config: member.config, checkout: member.checkout } });
    roots.push(harness.root);
    // The harness gives itself a home; the member's install is in this one.
    atHome(member.root, member.home);

    const started = await harness.call({ kind: 'start', name: 'review', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.turn.run);
    const chosen = TurnSchema.parse(await harness.call({ kind: 'choose', run, choice: 'h1' }));
    const [review] = chosen.data.turn.actions.flatMap((action) => DispatchSchema.safeParse(action).data ?? []);
    if (!review) throw new Error(JSON.stringify(chosen));
    await worked(harness, review, 'Reviewed the change.');

    const events: Array<{ kind: string }> = [];
    let judged = false;
    for (let poll = 0; poll < 20 && !events.some((event) => event.kind === 'judged'); poll += 1) {
      for (const wait of [true, false]) {
        const turn = TurnSchema.parse(await harness.call({ kind: 'next', run, wait }));
        events.push(...turn.data.turn.events);
        const judge = turn.data.turn.actions.flatMap((action) => DispatchSchema.safeParse(action).data ?? []).find((dispatch) => dispatch.step.endsWith('judge'));
        if (judge && !judged) {
          await worked(harness, judge, { answer: { label: 'thorough', reasoning: 'It read the change.' } });
          judged = true;
        }
      }
    }

    expect(judged).toBe(true);
    expect(events).toContainEqual({ kind: 'judged', step: 'review', scorer: 'review-quality', label: 'thorough' });
    expect(await LabelStore.local(member.config)).toEqual([expect.objectContaining({
      scorer: 'review-quality', label: 'thorough', judge: { kind: 'model', tool: 'claude', isolation: 'best-effort', access: 'read' },
    })]);
  }, 120_000);
});
