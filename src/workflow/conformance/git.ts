import { bothSkillProfiles, type DriverProfile } from '../conformance-interpreter.js';

/** A value a scenario reads from the run once it is done: its base, or what a step reported in `changes`. */
export type GitConformanceName = 'base.commit' | 'base.ref' | `steps.${string}.commit` | `steps.${string}.branch`;

/**
 * A git-level case for any driver that takes workspace leases. The runner makes a bare `origin` whose `main` has one
 * commit and clones it twice: a checkout of another machine, and the checkout the driver under test runs in. It starts
 * the run with its base on `main`: origin's tip, or with `base: 'elsewhere'` a commit only the other machine has. A
 * driver of that machine then runs the `elsewhere` steps through `next` and `report`, the driver under test drives the
 * run from its checkout until it ends, and the runner checks the persisted run and origin. With `handoff`, the other
 * machine has an install of its own: it starts the run there and publishes it after its steps, and the driver under
 * test claims the run before it drives it.
 */
export interface GitConformanceScenario {
  name: string;
  workflowName: string;
  yaml: string;
  base: 'origin' | 'elsewhere';
  /**
   * Steps the other machine runs first, in this order, each the next step `next` leases it with no merges. It commits
   * `files` on the leased branch from `start`, pushes that branch to origin unless `push` is false, and reports success
   * with that commit as `changes`.
   */
  elsewhere?: Array<{ step: string; files: Record<string, string>; push: boolean }>;
  /** Origin refuses every push once the `elsewhere` steps ran. */
  refusePushes?: true;
  /** The run reaches the driver under test through a publish on the other machine and a claim on its own. */
  handoff?: true;
  /** Expected fields in the persisted run after the driver under test is done. */
  expectState: Record<string, unknown>;
  /** By step id: the step's reported `changes.to` is the tip of `changes.branch` on origin, and that tip holds these files. */
  expectPushed?: Record<string, Record<string, string>>;
  /** The step's `message` contains each named value as a whole word, and its `failure.code` is not `codeIsNot`. */
  expectFailure?: { step: string; names: GitConformanceName[]; codeIsNot?: string };
  /**
   * The profiles designed to end the scenario otherwise, each with the end it reaches instead. A driver that prepares
   * through the protocol, as the skill driver does, makes its places in the checkout the run started from, which holds
   * every commit that checkout made.
   */
  refusedBy?: Partial<Record<DriverProfile, Pick<GitConformanceScenario, 'expectState' | 'expectPushed'>>>;
}

const FAILING_WRITER = `schemaVersion: v1alpha1
name: build
description: A step commits a file and then fails.
steps:
  - id: broken
    workspace: new
    command: node -e "require('fs').writeFileSync('broken.txt', 'B'); process.exit(1)"
`;

const JOIN = `schemaVersion: v1alpha1
name: build
description: A step starts from one branch and merges another.
steps:
  - id: right
    workspace: new
    command: node -e "require('fs').writeFileSync('right.txt', 'R')"
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "require('fs').writeFileSync('joined.txt', 'J')"
`;

const CONTINUED = `schemaVersion: v1alpha1
name: build
description: Two changes made one after another in one copy.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          command: node -e "require('fs').writeFileSync('write.txt', 'W')"
        - id: more
          needs: [write]
          workspace: continue
          command: node -e "require('fs').writeFileSync('more.txt', 'M')"
`;

/**
 * The git rules every driver keeps: it pushes the commits it reports before it reports them, failed steps included,
 * and it fetches the run's branches for a lease commit its checkout lacks, or fails `workspace_base` naming it. A run
 * it claims carries its base and its copies on those branches.
 */
export const workflowGitConformanceScenarios: GitConformanceScenario[] = [
  {
    name: 'a step that fails pushes the commits it reports',
    workflowName: 'build',
    yaml: FAILING_WRITER,
    base: 'origin',
    expectState: { steps: [{ id: 'broken', status: 'failed' }] },
    expectPushed: { broken: { 'broken.txt': 'B' } },
  },
  {
    name: 'a step that fails keeps its own failure when origin refuses the push, and names the branch it could not push',
    workflowName: 'build',
    yaml: FAILING_WRITER,
    base: 'origin',
    refusePushes: true,
    expectState: { steps: [{ id: 'broken', status: 'failed', changes: {} }] },
    expectFailure: { step: 'broken', names: ['steps.broken.branch'], codeIsNot: 'push_failed' },
  },
  {
    name: 'a step whose start, merge, and base commits are only on the run branches of origin fetches them',
    workflowName: 'build',
    yaml: JOIN,
    base: 'elsewhere',
    elsewhere: [{ step: 'right', files: { 'right.txt': 'R' }, push: true }, { step: 'left', files: { 'left.txt': 'L' }, push: true }],
    expectState: { steps: [{ id: 'right', status: 'succeeded' }, { id: 'left', status: 'succeeded' }, { id: 'join', status: 'succeeded' }] },
    expectPushed: { join: { 'left.txt': 'L', 'right.txt': 'R', 'joined.txt': 'J' } },
  },
  {
    name: 'a step whose merge commit is on no branch of origin fails workspace_base naming the commit and its branch',
    workflowName: 'build',
    yaml: JOIN,
    base: 'origin',
    elsewhere: [{ step: 'right', files: { 'right.txt': 'R' }, push: false }],
    expectState: { steps: [{ id: 'right', status: 'succeeded' }, { id: 'left', status: 'succeeded' }, { id: 'join', status: 'failed', failure: { code: 'workspace_base' } }] },
    expectPushed: { left: { 'left.txt': 'L' } },
    expectFailure: { step: 'join', names: ['steps.right.commit', 'steps.right.branch'] },
    refusedBy: bothSkillProfiles({
      expectState: { steps: [{ id: 'right', status: 'succeeded' }, { id: 'left', status: 'succeeded' }, { id: 'join', status: 'succeeded' }] },
      expectPushed: { join: { 'left.txt': 'L', 'right.txt': 'R', 'joined.txt': 'J' } },
    }),
  },
  {
    name: 'a step whose base commit is on no branch of origin fails workspace_base naming the commit and its branch',
    workflowName: 'build',
    yaml: FAILING_WRITER,
    base: 'elsewhere',
    expectState: { steps: [{ id: 'broken', status: 'failed', failure: { code: 'workspace_base' } }] },
    expectFailure: { step: 'broken', names: ['base.commit', 'base.ref'] },
    refusedBy: bothSkillProfiles({
      expectState: { steps: [{ id: 'broken', status: 'failed', message: 'command exited with status 1' }] },
      expectPushed: { broken: { 'broken.txt': 'B', 'elsewhere.txt': 'only on the other machine' } },
    }),
  },
  {
    name: 'a claimed run whose base only the publishing machine had starts its copies from that base',
    workflowName: 'build',
    yaml: JOIN,
    base: 'elsewhere',
    handoff: true,
    expectState: { status: 'succeeded', steps: [{ id: 'right', status: 'succeeded' }, { id: 'left', status: 'succeeded' }, { id: 'join', status: 'succeeded' }] },
    expectPushed: { join: { 'elsewhere.txt': 'only on the other machine', 'left.txt': 'L', 'right.txt': 'R', 'joined.txt': 'J' } },
  },
  {
    name: 'a claimed run continues a copy from the commit the publishing machine recorded',
    workflowName: 'build',
    yaml: CONTINUED,
    base: 'elsewhere',
    elsewhere: [{ step: 'change.write', files: { 'write.txt': 'W' }, push: true }],
    handoff: true,
    expectState: { status: 'succeeded', steps: [{ id: 'change', status: 'succeeded' }, { id: 'change.write', status: 'succeeded' }, { id: 'change.more', status: 'succeeded' }] },
    expectPushed: { 'change.more': { 'elsewhere.txt': 'only on the other machine', 'write.txt': 'W', 'more.txt': 'M' } },
  },
];
