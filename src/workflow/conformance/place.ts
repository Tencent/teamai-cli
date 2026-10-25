import type { ConformanceOperation, ConformanceScenario, DriverProfile } from '../conformance-interpreter.js';

/** What the checkout of every place scenario holds on `main`, which origin has too. */
export const PLACE_CHECKOUT_FILES: Record<string, string> = { 'README.md': '# fixture\n', 'AGENTS.md': 'Trusted base instructions.\n' };

const PREPARED_CHANGE = `schemaVersion: v1alpha1
name: build
description: Two prompts a driver runs in one prepared copy.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Edit the project.
        - id: polish
          needs: [write]
          prompt: Polish the project.
`;

/** Two roots that each add `shared.txt`, then `join`, which merges both. */
function conflictingJoin(join: string): string {
  return `schemaVersion: v1alpha1
name: build
description: Two copies add the same file, and a step joins them.
steps:
  - id: left
    workspace: new
    prompt: Write the left side.
  - id: right
    needs: []
    workspace: new
    prompt: Write the right side.
  - id: join
    needs: [left, right]
    workspace: new
    ${join}
`;
}

const conflictingSides: ConformanceOperation[] = [
  { kind: 'next', saveAs: 'left', as: 'external', prepare: true, expect: { data: { lease: { step: 'left' } } } },
  { kind: 'edit', lease: 'left', files: { 'shared.txt': 'left\n' } },
  { kind: 'report', lease: 'left', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
  { kind: 'next', saveAs: 'right', as: 'external', prepare: true, expect: { data: { lease: { step: 'right' } } } },
  { kind: 'edit', lease: 'right', files: { 'shared.txt': 'right\n' } },
  { kind: 'report', lease: 'right', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
];

/**
 * The places `next --prepare` makes, for a driver that runs the protocol from other processes than the one that
 * prepared its lease. The runner starts the run in a git checkout holding `PLACE_CHECKOUT_FILES`, whose origin is a
 * bare repository, and a runner through the CLI gives every call a temporary directory of its own.
 */
const TWO_WRITERS = `schemaVersion: v1alpha1
name: build
description: Two changes, each in a copy of its own.
steps:
  - id: work
    workspace: new
    prompt: Change the code.
  - id: more
    needs: []
    workspace: new
    prompt: Change more code.
`;

/** A driver that took a lease prepares that attempt later, and only that attempt. */
function prepareLeasedAttempt(profile: DriverProfile): ConformanceScenario {
  return {
    name: `prepare-leased-attempt (${profile}): next --prepare --attempt prepares the attempt it names, never another, and refuses one the run no longer leases`,
    workflowName: 'build',
    yaml: TWO_WRITERS,
    operations: [
      { kind: 'next', saveAs: 'work', as: profile, absent: ['cwd'], expect: { data: { lease: { step: 'work' } } } },
      { kind: 'next', saveAs: 'more', as: profile, running: ['work'], absent: ['cwd'], expect: { data: { lease: { step: 'more' } } } },
      { kind: 'next', saveAs: 'work', as: profile, prepare: true, attempt: 'work', expect: { data: { lease: { step: 'work' } } } },
      { kind: 'edit', lease: 'work', files: { 'code.txt': 'prepared\n' } },
      { kind: 'report', lease: 'work', as: profile, body: { outcome: 'success' }, expect: { data: { accepted: true, cleanup: true } } },
      { kind: 'files', lease: 'work', expect: { 'code.txt': null } },
      {
        kind: 'next', saveAs: 'reported', as: profile, prepare: true, attempt: 'work', expect: { error: { code: 'wrong_attempt' } },
        state: { steps: [{ id: 'work', status: 'succeeded' }, { id: 'more', status: 'leased' }] },
      },
    ],
    expectPushed: { work: { 'code.txt': 'prepared\n' } },
  };
}

const ONE_WRITER = `schemaVersion: v1alpha1
name: build
description: One change in a place the host makes.
steps:
  - id: work
    workspace: new
    prompt: Change the code.
`;

/** A host makes the place of a leased attempt, and TeamAI adopts it, or refuses it and keeps the attempt leased. */
function adoptHostPlace(profile: DriverProfile): ConformanceScenario {
  const refused = (adopt: string): ConformanceOperation => ({
    kind: 'next', saveAs: 'work', as: profile, prepare: true, attempt: 'work', adopt,
    expect: { error: { code: 'adopt_mismatch' } }, state: { steps: [{ id: 'work', status: 'leased' }] },
  });
  return {
    name: `adopt-host-place (${profile}): a host worktree on the lease's branch is adopted, reported with its changes and left after cleanup; a wrong branch, a dirty tree and another repository answer adopt_mismatch, and the attempt stays leased`,
    workflowName: 'build',
    yaml: ONE_WRITER,
    operations: [
      { kind: 'next', saveAs: 'work', as: profile, absent: ['cwd'], expect: { data: { lease: { step: 'work' } } } },
      { kind: 'host', name: 'other', lease: 'work', on: 'other' },
      refused('other'),
      { kind: 'host', name: 'dirty', lease: 'work', on: 'start', files: { 'stray.txt': 'stray\n' } },
      refused('dirty'),
      { kind: 'host', name: 'foreign', lease: 'work', on: 'foreign' },
      refused('foreign'),
      { kind: 'host', name: 'host', lease: 'work', on: 'branch' },
      { kind: 'next', saveAs: 'work', as: profile, prepare: true, attempt: 'work', adopt: 'host', expect: { data: { lease: { step: 'work' } } } },
      { kind: 'files', lease: 'work', expect: { 'AGENTS.md': 'Trusted base instructions.\n' } },
      { kind: 'edit', lease: 'work', files: { 'code.txt': 'adopted\n' } },
      { kind: 'report', lease: 'work', as: profile, body: { outcome: 'success' }, expect: { data: { accepted: true, cleanup: true } } },
      { kind: 'files', lease: 'work', expect: { 'code.txt': 'adopted\n' } },
    ],
    expectPushed: { work: { 'code.txt': 'adopted\n' } },
  };
}

export const workflowPlaceConformanceScenarios: ConformanceScenario[] = [
  ...(['local', 'session', 'external'] as const).flatMap((profile) => [prepareLeasedAttempt(profile), adoptHostPlace(profile)]),
  {
    name: 'a prepared lease is reported from another process, which commits and pushes its changes and puts the branch agent files back',
    workflowName: 'build',
    yaml: PREPARED_CHANGE,
    operations: [
      { kind: 'next', saveAs: 'first', as: 'external', prepare: true, expect: { data: { lease: { step: 'change.write' } } } },
      { kind: 'edit', lease: 'first', files: { 'code.txt': 'first\n', 'AGENTS.md': 'Untrusted branch instructions.\n' } },
      { kind: 'next', saveAs: 'again', as: 'external', prepare: true, expect: { data: { lease: { step: 'change.write' } } } },
      { kind: 'files', lease: 'again', expect: { 'code.txt': 'first\n', 'AGENTS.md': 'Untrusted branch instructions.\n' } },
      { kind: 'report', lease: 'first', as: 'external', changes: {}, body: { outcome: 'success' }, expect: { error: { code: 'invalid_report' } } },
      { kind: 'report', lease: 'first', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'second', as: 'external', prepare: true, expect: { data: { lease: { step: 'change.polish' } } } },
      { kind: 'files', lease: 'second', expect: { 'code.txt': 'first\n', 'AGENTS.md': 'Trusted base instructions.\n' } },
      { kind: 'edit', lease: 'second', files: { 'code.txt': 'first\nsecond\n' } },
      { kind: 'report', lease: 'second', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true, cleanup: true } } },
      { kind: 'files', lease: 'second', expect: { '.': null } },
      { kind: 'files', expect: { 'code.txt': null } },
    ],
    expectPushed: { second: { 'code.txt': 'first\nsecond\n', 'AGENTS.md': 'Untrusted branch instructions.\n' } },
  },
  {
    name: 'a prepared reader whose run is cancelled gets lease_cancelled, and its copy is put back as it found it',
    workflowName: 'build',
    yaml: `schemaVersion: v1alpha1
name: build
description: A reader of a copy whose run is cancelled while it runs.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          prompt: Change the agent rules.
        - id: check
          needs: [write]
          workspace: read-only
          prompt: Check the change.
`,
    operations: [
      { kind: 'next', saveAs: 'write', as: 'external', prepare: true, expect: { data: { lease: { step: 'change.write' } } } },
      { kind: 'edit', lease: 'write', files: { 'AGENTS.md': 'Branch rules.\n' } },
      { kind: 'report', lease: 'write', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'check', as: 'external', prepare: true, expect: { data: { lease: { step: 'change.check' } } } },
      { kind: 'files', lease: 'check', expect: { 'AGENTS.md': 'Trusted base instructions.\n' } },
      { kind: 'edit', lease: 'check', files: { 'junk.txt': 'reader\n' } },
      { kind: 'cancel', expect: { data: { run: { status: 'cancelled' } } } },
      { kind: 'report', lease: 'check', as: 'external', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
      { kind: 'files', lease: 'check', expect: { 'AGENTS.md': 'Branch rules.\n', 'junk.txt': null } },
    ],
  },
  {
    name: 'a lease from next without --prepare has no place: no cwd, and no worktree in the checkout',
    workflowName: 'build',
    yaml: PREPARED_CHANGE,
    operations: [
      { kind: 'next', saveAs: 'write', as: 'external', absent: ['cwd'], expect: { data: { lease: { step: 'change.write' } } } },
      { kind: 'files', expect: { '.teamai/workflow-worktrees': null } },
    ],
  },
  {
    name: 'a prepare whose setup fails settles the attempt failed with setup_failed',
    workflowName: 'build',
    yaml: `schemaVersion: v1alpha1
name: build
description: A step whose setup fails.
setup:
  command: exit 3
steps:
  - id: change
    workspace: new
    command: echo change
`,
    operations: [
      {
        kind: 'next', saveAs: 'change', as: 'local', prepare: true, expect: { error: { code: 'setup_failed' } },
        state: { steps: [{ id: 'change', status: 'failed', failure: { code: 'setup_failed' } }] },
      },
    ],
    refusedBy: { 'skill-bare': { at: 'change', expect: { data: { wait: { held: [{ step: 'change', missing: ['setup'] }] } } } } },
  },
  {
    name: 'a prepare whose start commit is on no branch of origin settles the attempt failed with workspace_base',
    workflowName: 'build',
    yaml: `schemaVersion: v1alpha1
name: build
description: A copy continued from a commit nobody pushed.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          command: echo write
        - id: more
          needs: [write]
          workspace: continue
          command: echo more
`,
    operations: [
      { kind: 'next', saveAs: 'write', as: 'external', expect: { data: { lease: { step: 'change.write' } } } },
      { kind: 'report', lease: 'write', as: 'external', changes: {}, body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      {
        kind: 'next', saveAs: 'more', as: 'external', prepare: true, expect: { error: { code: 'workspace_base' } },
        state: { steps: [{ id: 'change' }, { id: 'change.write', status: 'succeeded' }, { id: 'change.more', status: 'failed', failure: { code: 'workspace_base' } }] },
      },
    ],
  },
  {
    name: 'a prepared command whose merge conflicts settles the attempt failed with merge_conflict',
    workflowName: 'build',
    yaml: conflictingJoin('command: echo join'),
    operations: [
      ...conflictingSides,
      {
        kind: 'next', saveAs: 'join', as: 'external', prepare: true, expect: { error: { code: 'merge_conflict' } },
        state: { steps: [{ id: 'left', status: 'succeeded' }, { id: 'right', status: 'succeeded' }, { id: 'join', status: 'failed', failure: { code: 'merge_conflict' } }] },
      },
    ],
  },
  {
    name: 'a prepared prompt whose merge conflicts is told about the conflict on every prepare, and its resolution is committed',
    workflowName: 'build',
    yaml: conflictingJoin('prompt: Join both sides.'),
    operations: [
      ...conflictingSides,
      { kind: 'next', saveAs: 'join', as: 'external', prepare: true, promptHas: ['Join both sides.\n\nMerge conflict with teamai/', '(shared.txt). Resolve the conflict in the workspace.'], expect: { data: { lease: { step: 'join' } } } },
      { kind: 'next', saveAs: 'again', as: 'external', prepare: true, promptHas: ['(shared.txt). Resolve the conflict in the workspace.'], expect: { data: { lease: { step: 'join' } } } },
      { kind: 'edit', lease: 'join', files: { 'shared.txt': 'left\nright\n' } },
      { kind: 'report', lease: 'join', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
    ],
    expectPushed: { join: { 'shared.txt': 'left\nright\n' } },
  },
];
