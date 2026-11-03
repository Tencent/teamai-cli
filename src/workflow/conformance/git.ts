import { bothSkillProfiles, type DriverProfile, type ScenarioJson } from '../conformance-interpreter.js';

/** A value a scenario reads from the run once it is done: its base, or what a step reported in `changes`. */
export type GitConformanceName = 'base.commit' | 'base.ref' | `steps.${string}.commit` | `steps.${string}.branch`;

/**
 * A git-level case for any driver that takes workspace leases. The runner makes a bare `origin` whose `main` has one
 * commit and clones it twice: a checkout of another machine, and the checkout the driver under test runs in. It starts
 * the run with its base on `main`: origin's tip, or with `base: 'elsewhere'` a commit only the other machine has. A
 * driver of that machine then runs the `elsewhere` steps through `next` and `report`, the driver under test drives the
 * run from its checkout until it ends, and the runner checks the persisted run and origin. With `handoff`, the other
 * machine has an install of its own: it starts the run there and publishes it after its steps, and the driver under
 * test claims the run before it drives it. A prompt is a shell command: the scenario's agent runs it in the step's place.
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
  expectState: ScenarioJson;
  /** By step id: the step's reported `changes.to` is the tip of `changes.branch` on origin, and that tip holds these files. */
  expectPushed?: Record<string, Record<string, string>>;
  /** The other workflow files the team repo holds, by name, which `yaml` runs. */
  workflows?: Record<string, string>;
  /**
   * The run's copies, by branch with `<run>` for the run id, and the files the tip of each holds on origin: the run
   * records these copies and no other.
   */
  expectCopies?: Record<string, Record<string, string>>;
  /**
   * The branch, with `<run>` for the run id, the run left its changes on: `workflow start` and `resume` with the local
   * driver name it on stderr with the `git merge` that brings it in. Only the CLI runner reads it.
   */
  expectMergeBranch?: string;
  /**
   * By step id: the branch the step reported is gone from origin and from the checkout the driver under test ran in,
   * since the run succeeded and a branch that stays holds its tip.
   */
  expectGone?: string[];
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

const FIXED_IN_LOOP = `schemaVersion: v1alpha1
name: build
description: A step starts from a copy whose fix loop ended on a skipped pass.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          command: node -e "require('fs').writeFileSync('a.txt', 'broken')"
        - id: check
          needs: [write]
          command: node -e "process.exit(require('fs').readFileSync('a.txt', 'utf8') === 'fixed' ? 0 :1)"
        - id: fix
          needs: [check]
          if: steps.check.outcome == 'failed'
          workspace: continue
          command: node -e "require('fs').writeFileSync('a.txt', 'fixed')"
          loop: { back_to: check, max_iterations: 2 }
  - id: after
    needs: [change]
    workspace: new
    command: node -e "const fs = require('fs'); if (fs.readFileSync('a.txt', 'utf8') !== 'fixed') process.exit(1); fs.writeFileSync('after.txt', 'A')"
`;

/**
 * `review-and-fix` reviews, fixes what the review finds, and reviews again, in one copy: the second review sees the
 * fix, and passes. It runs on its own, in a copy the run opens, or in the copy of the step that runs it. `fix` is a
 * prompt with no `workspace`, so it continues whichever copy that is.
 */
const REVIEW_AND_FIX = `schemaVersion: v1alpha1
name: review-and-fix
description: Review the change, fix what the review finds, and review the fix, in one copy.
invoke: allow
workspace: new
steps:
  - id: review
    command: |
      node -e "process.stdout.write(JSON.stringify({ verdict: require('fs').existsSync('fixed.txt') ? 'pass' : 'fix' }))"
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict == 'fix'
    prompt: node -e "require('fs').writeFileSync('fixed.txt', 'F')"
    loop: { back_to: review, max_iterations: 2 }
`;

const SHIP_ISSUE = `schemaVersion: v1alpha1
name: ship-issue
description: Make the change, then review and fix it in the change's copy.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: implement
          workspace: continue
          command: node -e "require('fs').writeFileSync('change.txt', 'C')"
        - id: check
          needs: [implement]
          workflow: review-and-fix
`;

const CHECK_BRANCH = `schemaVersion: v1alpha1
name: check-branch
description: Review and fix the branch, from a step with no copy around it.
steps:
  - id: check
    workflow: review-and-fix
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
    expectGone: ['left', 'right'],
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
    expectGone: ['left', 'right'],
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
  {
    name: 'a step that needs a copy whose fix loop ended on a skipped pass starts from the fix',
    workflowName: 'build',
    yaml: FIXED_IN_LOOP,
    base: 'origin',
    expectState: {
      status: 'succeeded',
      steps: [
        { id: 'change', status: 'succeeded' }, { id: 'change.write', status: 'succeeded' }, { id: 'change.check', status: 'succeeded' },
        { id: 'change.fix', status: 'skipped' }, { id: 'after', status: 'succeeded' },
      ],
    },
    expectPushed: { after: { 'a.txt': 'fixed', 'after.txt': 'A' } },
    expectGone: ['change.write'],
  },
  {
    name: 'a workflow whose header says workspace: new works in one copy the run opens, and its second review sees the fix',
    workflowName: 'review-and-fix',
    yaml: REVIEW_AND_FIX,
    base: 'origin',
    expectState: { status: 'succeeded', steps: [{ id: 'review', status: 'succeeded', pass: 2, outputs: { verdict: 'pass' } }, { id: 'fix', status: 'skipped' }] },
    expectCopies: { 'teamai/<run>/_run': { 'fixed.txt': 'F' } },
    expectMergeBranch: 'teamai/<run>/_run',
  },
  {
    name: 'a workflow whose header says workspace: new continues the copy of the step it runs in, and opens none',
    workflowName: 'ship-issue',
    yaml: SHIP_ISSUE,
    workflows: { 'review-and-fix': REVIEW_AND_FIX },
    base: 'origin',
    expectState: { status: 'succeeded', steps: [{ id: 'change', status: 'succeeded' }, { id: 'change.implement', status: 'succeeded' }, { id: 'change.check', status: 'succeeded' }, { id: 'change.check.review', status: 'succeeded', pass: 2, outputs: { verdict: 'pass' } }, { id: 'change.check.fix', status: 'skipped' }] },
    expectCopies: { 'teamai/<run>/change/p1': { 'change.txt': 'C', 'fixed.txt': 'F' } },
  },
  {
    name: 'a workflow whose header says workspace: new, run by a step with no copy around it, opens one for that step',
    workflowName: 'check-branch',
    yaml: CHECK_BRANCH,
    workflows: { 'review-and-fix': REVIEW_AND_FIX },
    base: 'origin',
    expectState: { status: 'succeeded', steps: [{ id: 'check', status: 'succeeded' }, { id: 'check.review', status: 'succeeded', pass: 2, outputs: { verdict: 'pass' } }, { id: 'check.fix', status: 'skipped' }] },
    expectCopies: { 'teamai/<run>/check/p1': { 'fixed.txt': 'F' } },
  },
];
