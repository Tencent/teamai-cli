/** Conformance scenarios for what a step requires, its env and secrets, its setup, and the run's deadlines and budgets. */
import { PARALLEL_ROOTS, controlsYaml, bothSkillProfiles, type ConformanceScenario } from './conformance-interpreter.js';

export const limitsConformanceScenarios: ConformanceScenario[] = [];

const NO_NETWORK = controlsYaml('  - id: fetch\n    command: echo fetch\n    requires: { network: false }');
limitsConformanceScenarios.push(
  {
    name: 'a driver that cannot deny the network still gets the step, and the run records network as unenforced', workflowName: 'build', yaml: NO_NETWORK,
    operations: [
      { kind: 'next', saveAs: 'fetch', as: 'external', expect: { data: { lease: {
        step: 'fetch', requires: { network: false }, unenforced: [{ requirement: 'network', asked: false }],
      } } } },
      { kind: 'report', lease: 'fetch', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true, step: {
        id: 'fetch', status: 'succeeded', unenforced: [{ requirement: 'network', asked: false }],
      } } } },
      { kind: 'next', saveAs: 'done', as: 'external', expect: { data: { done: { outcome: 'succeeded' } } } },
    ],
    expectState: { steps: [{ id: 'fetch', status: 'succeeded', unenforced: [{ requirement: 'network', asked: false }] }] },
    expectRecord: { steps: [{ step: 'fetch', outcome: 'success', unenforced: [{ requirement: 'network', asked: false }] }] },
  },
  {
    name: 'defaults.requires applies to every step, and a step adds to it', workflowName: 'build',
    yaml: NO_NETWORK.replace('steps:\n', 'defaults:\n  requires: { isolation: sandbox }\nsteps:\n')
      .replace('requires: { network: false }', 'requires: { network: false }\n  - id: open\n    needs: []\n    command: echo open\n    requires: { network: true, isolation: worktree }'),
    operations: [
      { kind: 'next', saveAs: 'fetch', as: 'external', expect: { data: { lease: {
        step: 'fetch', requires: { network: false, isolation: 'sandbox' },
        unenforced: [{ requirement: 'network', asked: false }, { requirement: 'isolation', asked: 'sandbox', provided: 'none' }],
      } } } },
      { kind: 'next', saveAs: 'open', as: 'external', running: ['fetch'], expect: { data: { lease: {
        step: 'open', requires: { network: true, isolation: 'worktree' }, unenforced: [{ requirement: 'isolation', asked: 'worktree', provided: 'none' }],
      } } } },
    ],
  },
  {
    name: 'a hand-back keeps what the lease left unenforced', workflowName: 'build',
    yaml: controlsYaml('  - id: fetch\n    command: echo fetch\n    requires: { network: false, isolation: sandbox }'),
    operations: [
      { kind: 'next', saveAs: 'fetch', as: 'external', expect: { data: { lease: {
        unenforced: [{ requirement: 'network', asked: false }, { requirement: 'isolation', asked: 'sandbox', provided: 'none' }],
      } } } },
      { kind: 'next', saveAs: 'again', as: 'external', expect: { data: { lease: {
        unenforced: [{ requirement: 'network', asked: false }, { requirement: 'isolation', asked: 'sandbox', provided: 'none' }],
      } } } },
    ],
    expectState: { steps: [{ id: 'fetch', status: 'leased', lease: {
      unenforced: [{ requirement: 'network', asked: false }, { requirement: 'isolation', asked: 'sandbox', provided: 'none' }],
    } }] },
  },
);

/** A value long enough to be masked, which no scenario output may carry. */
const CONFORMANCE_SECRET = 'conformance-secret-value-1082';
const NEEDS_TOKEN = controlsYaml('  - id: deploy\n    command: echo deploy\n    requires: { env: [CONFORMANCE_TOKEN] }\n  - id: build\n    needs: []\n    command: echo build');
limitsConformanceScenarios.push(
  {
    name: 'a step that requires env waits for a driver that scopes env, which gets the key name and no value',
    workflowName: 'build', yaml: NEEDS_TOKEN, env: { CONFORMANCE_TOKEN: CONFORMANCE_SECRET },
    operations: [
      { kind: 'next', saveAs: 'build', as: 'external', expect: { data: { lease: {
        step: 'build', unenforced: [{ requirement: 'withhold', keys: ['CONFORMANCE_TOKEN'] }],
      } } } },
      { kind: 'report', lease: 'build', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'held', as: 'external', expect: { data: { wait: {
        held: [{ step: 'deploy', reason: 'step "deploy" needs env, which this driver does not declare', missing: ['env'] }],
      } } } },
      { kind: 'next', saveAs: 'deploy', as: 'local', absent: ['env', 'unenforced'], expect: { data: { lease: {
        step: 'deploy', requires: { env: ['CONFORMANCE_TOKEN'] }, envScope: { provide: ['CONFORMANCE_TOKEN'], withhold: [] },
      } } } },
    ],
    refusedBy: { 'skill-bare': { at: 'deploy', expect: { data: { wait: { held: [{ step: 'deploy', missing: ['env'] }] } } } } },
  },
  {
    name: 'a step whose required env has no value here fails missing_env before it is leased', workflowName: 'build', yaml: NEEDS_TOKEN,
    operations: [
      { kind: 'next', saveAs: 'build', as: 'local', expect: { data: { lease: { step: 'build', envScope: { provide: [], withhold: ['CONFORMANCE_TOKEN'] } } } } },
      { kind: 'report', lease: 'build', as: 'local', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'done', as: 'local', expect: { data: { done: { outcome: 'failed' } } } },
    ],
    expectState: { steps: [{ id: 'deploy', status: 'failed', failure: {
      code: 'missing_env',
      message: 'Step "deploy" requires env CONFORMANCE_TOKEN, which has no value on this machine. Set it in the environment, or declare it in the team repo (teamai env add CONFORMANCE_TOKEN --secret), then retry the step.',
    } }, { id: 'build', status: 'succeeded' }] },
    expectRecord: { failure: { code: 'missing_env' } },
    refusedBy: { 'skill-bare': { at: 'build', expect: { data: { lease: { step: 'build', unenforced: [{ requirement: 'withhold', keys: ['CONFORMANCE_TOKEN'] }] } } } } },
  },
  {
    name: 'a secret a driver reports reaches neither the run file, the record, nor an envelope the CLI prints', workflowName: 'build',
    yaml: NEEDS_TOKEN.replace('command: echo deploy', 'command: echo deploy\n    output:\n      note: string'), env: { CONFORMANCE_TOKEN: CONFORMANCE_SECRET },
    operations: [
      { kind: 'next', saveAs: 'deploy', as: 'local', expect: { data: { lease: { step: 'deploy' } } } },
      // An error that names what the driver sent masks it too.
      { kind: 'report', lease: 'deploy', as: 'local', attempt: CONFORMANCE_SECRET, body: { outcome: 'success' }, expect: { error: { code: 'wrong_attempt' } } },
      { kind: 'report', lease: 'deploy', as: 'local', body: { outcome: 'success', model: CONFORMANCE_SECRET, outputs: { note: `token ${CONFORMANCE_SECRET}` } }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'build', as: 'local', expect: { data: { lease: { step: 'build' } } } },
      { kind: 'report', lease: 'build', as: 'local', body: { outcome: 'failed', message: `build saw ${CONFORMANCE_SECRET}` }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'done', as: 'local', expect: { data: { done: { outcome: 'failed' } } } },
    ],
    expectState: { steps: [
      { id: 'deploy', status: 'succeeded', outputs: { note: 'token <REDACTED:CONFORMANCE_TOKEN>' } },
      { id: 'build', status: 'failed', message: 'build saw <REDACTED:CONFORMANCE_TOKEN>' },
    ] },
    refusedBy: { 'skill-bare': { at: 'deploy', expect: { data: { lease: { step: 'build' } } } } },
  },
  {
    name: 'a step env that names a required key fails env_conflict', workflowName: 'build',
    yaml: NEEDS_TOKEN.replace('command: echo build', 'command: echo build\n    env: { CONFORMANCE_TOKEN: plain }'), env: { CONFORMANCE_TOKEN: CONFORMANCE_SECRET },
    operations: [
      { kind: 'next', saveAs: 'deploy', as: 'local', expect: { data: { lease: { step: 'deploy' } } } },
      { kind: 'next', saveAs: 'after', as: 'local', running: ['deploy'], expect: { data: { wait: { reason: 'deploy is leased' } } } },
    ],
    expectState: { steps: [{ id: 'deploy', status: 'leased' }, { id: 'build', status: 'failed', failure: { code: 'env_conflict' } }] },
    refusedBy: { 'skill-bare': { at: 'deploy', expect: { data: { wait: { held: [{ step: 'deploy', missing: ['env'] }] } } } } },
  },
);

const BASE = { ref: 'main', commit: 'a'.repeat(40) };
const WITH_SETUP = controlsYaml('  - id: change\n    workspace: new\n    command: echo change\n  - id: look\n    needs: []\n    command: echo look')
  .replace('steps:\n', 'setup:\n  command: npm ci\n  requires: { env: [CONFORMANCE_TOKEN] }\nsteps:\n');
limitsConformanceScenarios.push(
  {
    name: 'a step in a workspace the driver creates waits for a driver that runs setup, which gets setup with its own keys only',
    workflowName: 'build', yaml: WITH_SETUP, env: { CONFORMANCE_TOKEN: CONFORMANCE_SECRET },
    operations: [
      { kind: 'next', saveAs: 'look', as: 'external', base: BASE, absent: ['setup'], expect: { data: { lease: { step: 'look' } } } },
      { kind: 'next', saveAs: 'held', as: 'external', base: BASE, running: ['look'], expect: { data: { wait: {
        held: [{ step: 'change', reason: 'step "change" needs setup, env, which this driver does not declare', missing: ['setup', 'env'] }],
      } } } },
      { kind: 'report', lease: 'look', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'change', as: 'local', base: BASE, expect: { data: { lease: {
        step: 'change',
        envScope: { provide: [], withhold: ['CONFORMANCE_TOKEN'] },
        setup: { command: 'npm ci', envScope: { provide: ['CONFORMANCE_TOKEN'], withhold: [] } },
      } } } },
    ],
    refusedBy: { 'skill-bare': { at: 'change', expect: { data: { wait: { held: [{ step: 'change', missing: ['setup', 'env'] }] } } } } },
  },
);

const SETUP_SECRET = 'conformance-setup-value-1304';
const COMMANDS_ONLY = controlsYaml(`  - id: publish
    workspace: new
    command: echo publish
    requires: { env: [CONFORMANCE_TOKEN] }
  - id: notify
    needs: []
    prompt: Tell the channel
    requires: { env: [CONFORMANCE_TOKEN] }`).replace('steps:\n', 'setup:\n  command: npm ci\n  requires: { env: [SETUP_TOKEN] }\nsteps:\n');
limitsConformanceScenarios.push(
  {
    name: 'env-commands-scope: a driver that scopes env for commands only gets the command step and its setup scoped, and the prompt step waits',
    workflowName: 'build', yaml: COMMANDS_ONLY, env: { CONFORMANCE_TOKEN: CONFORMANCE_SECRET, SETUP_TOKEN: SETUP_SECRET },
    operations: [
      { kind: 'next', saveAs: 'bare', as: 'external', base: BASE, can: { setup: true }, expect: { data: { wait: { held: [
        { step: 'publish', missing: ['env'] },
        { step: 'notify', missing: ['env'] },
      ] } } } },
      { kind: 'next', saveAs: 'publish', as: 'external', base: BASE, can: { setup: true, env: 'commands' }, absent: ['unenforced'], expect: { data: { lease: {
        step: 'publish',
        envScope: { provide: ['CONFORMANCE_TOKEN'], withhold: ['SETUP_TOKEN'] },
        setup: { command: 'npm ci', envScope: { provide: ['SETUP_TOKEN'], withhold: ['CONFORMANCE_TOKEN'] } },
      } } } },
      { kind: 'next', saveAs: 'held', as: 'external', base: BASE, can: { setup: true, env: 'commands' }, running: ['publish'], expect: { data: { wait: {
        held: [{ step: 'notify', reason: 'step "notify" needs env, which this driver does not declare', missing: ['env'] }],
      } } } },
    ],
    expectState: { steps: [{ id: 'publish', status: 'leased' }, { id: 'notify', status: 'pending' }] },
  },
);

// The CLI runner waits for real, so each deadline leaves room for the calls made before the clock moves past it.
const TIMED_STEP = controlsYaml(`  - id: work
    command: echo work
    timeout: 2s
  - id: recover
    needs: [work]
    if: steps.work.outcome == 'timeout'
    command: echo recover`);
const TIMED_FAN_OUT = controlsYaml(`  - id: plan
    command: echo plan
    output:
      targets: [string]
  - id: batch
    needs: [plan]
    timeout: 3s
    for_each: { items: steps.plan.outputs.targets }
    workflow:
      steps:
        - id: work
          command: echo work`);
limitsConformanceScenarios.push(
  {
    name: 'a lease past its timeout is cancelled, its report is lease_cancelled, and the step settles with outcome timeout',
    workflowName: 'build', yaml: TIMED_STEP,
    operations: [
      { kind: 'next', saveAs: 'work', expect: { data: { lease: { step: 'work' } } } },
      { kind: 'advance', ms: 2000 },
      { kind: 'next', saveAs: 'recover', running: ['work'], cancelled: ['work'], expect: { data: { lease: { step: 'recover' } } } },
      { kind: 'report', lease: 'work', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
      { kind: 'report', lease: 'recover', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
    ],
    expectState: { steps: [{ id: 'work', status: 'failed', failure: { code: 'timeout' } }, { id: 'recover', status: 'succeeded' }] },
    expectRecord: { failure: { code: 'timeout' }, steps: [{ step: 'work', outcome: 'timeout' }, { step: 'recover', outcome: 'success' }] },
  },
  {
    name: 'a for_each past its timeout cancels the leases of its items with it',
    workflowName: 'build', yaml: TIMED_FAN_OUT,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', outputs: { targets: ['a', 'b'] } }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'first', expect: { data: { lease: { step: 'batch[0].work' } } } },
      { kind: 'next', saveAs: 'second', running: ['first'], expect: { data: { lease: { step: 'batch[1].work' } } } },
      { kind: 'advance', ms: 3000 },
      { kind: 'next', saveAs: 'done', running: ['first', 'second'], cancelled: ['first', 'second'], expect: { data: { done: { outcome: 'failed' } } } },
      { kind: 'report', lease: 'second', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
    ],
    expectState: { steps: [
      { id: 'plan', status: 'succeeded' },
      { id: 'batch', status: 'failed', failure: { code: 'timeout' } },
      { id: 'batch[0]', status: 'cancelled' },
      { id: 'batch[0].work', status: 'cancelled' },
      { id: 'batch[1]', status: 'cancelled' },
      { id: 'batch[1].work', status: 'cancelled' },
    ] },
    expectRecord: { failure: { code: 'timeout' } },
  },
  {
    name: 'a run past its workflow timeout cancels its open leases and fails with timeout',
    workflowName: 'build', yaml: PARALLEL_ROOTS.replace('steps:\n', 'timeout: 3s\nsteps:\n'),
    operations: [
      { kind: 'next', saveAs: 'a', expect: { data: { lease: { step: 'a' } } } },
      { kind: 'next', saveAs: 'b', running: ['a'], expect: { data: { lease: { step: 'b' } } } },
      { kind: 'advance', ms: 3000 },
      { kind: 'next', saveAs: 'done', running: ['a', 'b'], cancelled: ['a', 'b'], expect: { data: { done: { outcome: 'failed', failure: { code: 'timeout' } } } } },
      { kind: 'report', lease: 'a', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
    ],
    expectState: { status: 'failed', failure: { code: 'timeout' } },
    expectRecord: { failure: { code: 'timeout' } },
  },
  {
    name: 'a retry that reopens a run its workflow timeout ended gives it a fresh window',
    workflowName: 'build', yaml: controlsYaml('  - id: work\n    command: echo work').replace('steps:\n', 'timeout: 3s\nsteps:\n'),
    operations: [
      { kind: 'next', saveAs: 'work', expect: { data: { lease: { step: 'work' } } } },
      { kind: 'advance', ms: 3000 },
      { kind: 'next', saveAs: 'done', running: ['work'], expect: { data: { done: { outcome: 'failed', failure: { code: 'timeout' } } } } },
      { kind: 'retry', step: 'work', expect: { data: { reopened: true } } },
      { kind: 'next', saveAs: 'again', expect: { data: { lease: { step: 'work' } } } },
      { kind: 'report', lease: 'again', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'end', expect: { data: { done: { outcome: 'succeeded' } } } },
    ],
    expectState: { status: 'succeeded' },
  },
  {
    name: "another driver's lease past its timeout no longer holds the run",
    workflowName: 'build', yaml: TIMED_STEP,
    operations: [
      { kind: 'next', saveAs: 'work', as: 'external', expect: { data: { lease: { step: 'work' } } } },
      { kind: 'next', saveAs: 'blocked', as: 'local', expect: { data: { wait: { reason: 'work is leased' } } } },
      { kind: 'advance', ms: 2000 },
      { kind: 'next', saveAs: 'recover', as: 'local', expect: { data: { lease: { step: 'recover' } } } },
      { kind: 'report', lease: 'work', as: 'external', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
    ],
    expectState: { steps: [{ id: 'work', status: 'failed', failure: { code: 'timeout' } }, { id: 'recover', status: 'leased' }] },
  },
);

const BUDGETED = (tokens: number, steps: string): string => controlsYaml(steps).replace('steps:\n', `budget: { tokens: ${tokens} }\nsteps:\n`);
limitsConformanceScenarios.push(
  {
    name: 'a prompt under a budget waits for a driver that reports tokens, and a success that reports none fails budget_unmeasured',
    workflowName: 'build', yaml: BUDGETED(100, '  - id: plan\n    prompt: Plan it.\n  - id: check\n    needs: []\n    command: echo check'),
    operations: [
      { kind: 'next', saveAs: 'check', as: 'external', expect: { data: { lease: { step: 'check' } } } },
      { kind: 'next', saveAs: 'held', as: 'external', running: ['check'], expect: { data: { wait: {
        held: [{ step: 'plan', reason: 'step "plan" needs tokens, which this driver does not declare', missing: ['tokens'] }],
      } } } },
      { kind: 'report', lease: 'check', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'plan', as: 'local', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', as: 'local', body: { outcome: 'success' }, expect: { data: { accepted: true, step: { id: 'plan', status: 'failed' } } } },
      { kind: 'next', saveAs: 'done', as: 'local', expect: { data: { done: { outcome: 'failed' } } } },
    ],
    expectState: { steps: [{ id: 'plan', status: 'failed', failure: { code: 'budget_unmeasured' } }, { id: 'check', status: 'succeeded' }] },
    expectRecord: { failure: { code: 'budget_unmeasured' } },
    refusedBy: bothSkillProfiles({ at: 'plan', expect: { data: { wait: { held: [{ step: 'plan', missing: ['tokens'] }] } } } }),
  },
  {
    name: 'a run that spent its token budget cancels its open leases and fails budget_exceeded',
    workflowName: 'build', yaml: BUDGETED(10, '  - id: a\n    prompt: Do a.\n  - id: b\n    needs: []\n    prompt: Do b.'),
    operations: [
      { kind: 'next', saveAs: 'a', expect: { data: { lease: { step: 'a' } } } },
      { kind: 'next', saveAs: 'b', running: ['a'], expect: { data: { lease: { step: 'b' } } } },
      { kind: 'report', lease: 'a', body: { outcome: 'success', tokens: { input: 8, output: 4 } }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'done', running: ['b'], cancelled: ['b'], expect: { data: { done: { outcome: 'failed', failure: { code: 'budget_exceeded' } } } } },
      { kind: 'report', lease: 'b', body: { outcome: 'success', tokens: { input: 1, output: 1 } }, expect: { error: { code: 'lease_cancelled' } } },
    ],
    expectState: { status: 'failed', steps: [{ id: 'a', status: 'succeeded' }, { id: 'b', status: 'cancelled', failure: { code: 'budget_exceeded' } }] },
    expectRecord: { failure: { code: 'budget_exceeded' } },
    refusedBy: bothSkillProfiles({ at: 'a', expect: { data: { wait: { held: [{ step: 'a', missing: ['tokens'] }, { step: 'b', missing: ['tokens'] }] } } } }),
  },
);

const MAX_TURNS = controlsYaml('  - id: plan\n    prompt: Plan it.\n    max_turns: 5\n  - id: check\n    needs: []\n    command: echo check');
const TURNS_UNENFORCED = [{ requirement: 'max_turns', asked: 5 }];
limitsConformanceScenarios.push(
  {
    name: 'a driver that cannot cap turns gets a max_turns prompt without maxTurns, and the run records max_turns as unenforced',
    workflowName: 'build', yaml: MAX_TURNS,
    operations: [
      { kind: 'next', saveAs: 'plan', as: 'external', absent: ['maxTurns'], expect: { data: { lease: { step: 'plan', unenforced: TURNS_UNENFORCED } } } },
      { kind: 'report', lease: 'plan', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true, step: { id: 'plan', unenforced: TURNS_UNENFORCED } } } },
    ],
    expectState: { steps: [{ id: 'plan', status: 'succeeded', unenforced: TURNS_UNENFORCED }, { id: 'check', status: 'pending' }] },
  },
  {
    name: 'a driver that caps turns gets maxTurns, and its report may say the tool it ran did not enforce it',
    workflowName: 'build', yaml: MAX_TURNS,
    operations: [
      { kind: 'next', saveAs: 'plan', absent: ['unenforced'], expect: { data: { lease: { step: 'plan', maxTurns: 5 } } } },
      { kind: 'next', saveAs: 'check', running: ['plan'], absent: ['maxTurns'], expect: { data: { lease: { step: 'check' } } } },
      { kind: 'report', lease: 'check', body: { outcome: 'success', unenforced: ['max_turns'] }, expect: { error: { code: 'invalid_report' } } },
      { kind: 'report', lease: 'check', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', tokens: { input: 1, output: 1 }, unenforced: ['max_turns'] }, expect: { data: { accepted: true, step: {
        id: 'plan', unenforced: TURNS_UNENFORCED,
      } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded' } } } },
    ],
    expectRecord: { steps: [{ step: 'plan', unenforced: TURNS_UNENFORCED }, { step: 'check' }] },
    refusedBy: bothSkillProfiles({ at: 'plan', expect: { data: { lease: { step: 'plan', unenforced: TURNS_UNENFORCED } } } }),
  },
);
