import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runsDir } from '../workflow/store.js';
import { fakeJudge, skillHarness } from './helpers/skill-harness.js';

const RELEASE_DOCS = `schemaVersion: v1alpha1
name: release-docs
description: Draft the release notes, then sign them
invoke: allow
steps:
  - id: docs
    workspace: new
    workflow:
      steps:
        - id: draft
          prompt: Draft the release notes.
        - id: sign
          needs: [draft]
          prompt: Sign the notes.
          requires: { env: [SIGNING_KEY] }
`;

// Every fact describe states: inputs, width, an interactive step, a required and an optional approval, a delivery, env
// with no value here, a held step, a budget, a timeout, judging here, and invoke: ask.
const SHIP = `schemaVersion: v1alpha1
name: ship
description: Build, review and ship a change
invoke: ask
inputs:
  ticket: string
  count: number
timeout: 2h
steps:
  - id: api
    workspace: new
    prompt: Write the API.
  - id: ui
    needs: []
    workspace: new
    prompt: Write the UI.
  - id: plan-review
    needs: [api, ui]
    approve: Approve the plan?
    command: node -e "process.exit(0)"
  - id: notes
    needs: [plan-review]
    interactive: true
    prompt: Write the release notes with the person.
  - id: integrate
    needs: [notes]
    workspace: new
    deliver: pr
    prompt: Integrate the API and the UI.
    scorers: [review-quality]
  - id: publish
    needs: [integrate]
    requires: { env: [NPM_TOKEN] }
    command: node -e "process.exit(0)"
  - id: announce
    needs: [publish]
    budget: { tokens: 20000 }
    workflow:
      steps:
        - id: post
          prompt: Announce the release.
          requires: { env: [SLACK_TOKEN] }
  - id: go-live
    needs: [announce]
    approve: { message: Deploy?, required: true }
    command: node -e "process.exit(0)"
`;

// Nothing to ask, and two facts to tell: env with no value here, and a timeout.
const LINT = `schemaVersion: v1alpha1
name: lint
description: Lint the change
invoke: allow
timeout: 30m
steps:
  - id: lint
    requires: { env: [LINT_TOKEN] }
    command: node -e "process.exit(0)"
`;

const SCORERS = { 'review-quality': `---
labels:
  - { value: thorough, score: 1, description: Did the work it was asked for }
  - { value: shallow, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
---
Judge the change.
` };

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function harness(workflows: Record<string, string>, options: Parameters<typeof skillHarness>[1] = {}) {
  const made = await skillHarness(workflows, options);
  roots.push(made.root);
  return made;
}

/** How many runs this machine has. */
function runCount(made: Awaited<ReturnType<typeof harness>>): number {
  return fs.existsSync(runsDir(made.config)) ? fs.readdirSync(runsDir(made.config)).length : 0;
}

describe('skill driver preflight', () => {
  it('states every fact in one question, and offers the recommended start first and at most four others', async () => {
    const made = await harness({ ship: SHIP }, { scorers: SCORERS });
    fakeJudge(made.root, 'thorough');
    const start = (flags: string) => `teamai workflow start ship --driver skill ${flags} --inputs '{inputs}'`;
    expect(await made.call({ kind: 'describe', name: 'ship' })).toMatchObject({ data: { describe: { ask: { kind: 'ask', question: {
      text: [
        '- ship needs the inputs ticket (string) and count (number).',
        '- It can run up to 2 steps at once.',
        '- notes is interactive: you work in it here, with this session\'s agent.',
        '- Only you can answer the approval at go-live, from your own terminal or teamai dashboard.',
        '- Optional approvals: plan-review.',
        '- It opens a pull request from integrate into main.',
        '- NPM_TOKEN and SLACK_TOKEN have no value on this machine: set them with teamai env set NPM_TOKEN and teamai env set SLACK_TOKEN before the steps that require them run, or those steps fail.',
        '- announce.post needs env SLACK_TOKEN, which a coding session keeps from its agents, and runs under a token budget, which no coding session meters for teamai, so you finish it in your own terminal with teamai workflow resume once the run reaches it.',
        '- announce may spend at most 20000 tokens each time it starts.',
        '- It stops after 2h.',
        '- claude judges integrate here, with one confined judge call per pass.',
        '- The team asks that you agree before it starts.',
        'Start it, and if so, how should it run?',
      ].join('\n'),
      inputs: [{ name: 'ticket', type: { type: 'string' } }, { name: 'count', type: { type: 'number' } }],
      options: [
        { label: 'Recommended: up to 2 steps at once, you decide optional approvals, with judging', start: start('--parallel 2 --confirmed --hitl recommend') },
        { label: 'Same, but ask me at optional approvals', start: start('--parallel 2 --confirmed --hitl person') },
        { label: 'Same, but answer optional approvals automatically', start: start('--parallel 2 --confirmed --auto-approve') },
        { label: 'Same, but one step at a time', start: start('--parallel 1 --confirmed --hitl recommend') },
        { label: 'Same, but without judging', start: start('--parallel 2 --confirmed --hitl recommend --no-judge') },
      ],
    } } } } });
  });

  it('refuses a start without the answers describe asked for, and creates no run', async () => {
    const made = await harness({ ship: SHIP }, { scorers: SCORERS });
    const before = runCount(made);
    expect(await made.call({ kind: 'start', name: 'ship', answers: { confirmed: false }, inputs: undefined }))
      .toMatchObject({ error: { code: 'confirm_needed', next: 'teamai workflow start --describe ship --driver skill' } });
    expect(runCount(made)).toBe(before);
  });

  it('starts a workflow with nothing to ask at once, and gives the facts to tell the person first', async () => {
    const made = await harness({ lint: LINT });
    expect(await made.call({ kind: 'describe', name: 'lint' })).toMatchObject({ data: { describe: { ask: {
      kind: 'start',
      say: [
        '- LINT_TOKEN has no value on this machine: set it with teamai env set LINT_TOKEN before the steps that require it run, or those steps fail.',
        '- It stops after 30m.',
      ].join('\n'),
      start: 'teamai workflow start lint --driver skill',
    } } } });
  });

  it('routes a run whose continue step needs env to the local driver', async () => {
    const made = await harness({ 'release-docs': RELEASE_DOCS });
    expect(await made.call({ kind: 'describe', name: 'release-docs' })).toMatchObject({ data: { describe: {
      workflow: { facts: { localRoute: { opener: 'docs', held: 'docs.sign', missing: 'env' } } },
      ask: { kind: 'local', start: 'teamai workflow start release-docs --driver local --tools default=claude' },
    } } });
    expect(await made.call({ kind: 'start', name: 'release-docs', answers: { confirmed: false }, inputs: undefined }))
      .toMatchObject({ error: { code: 'needs_local_driver', next: null } });
    expect(runCount(made)).toBe(0);
  });
});
