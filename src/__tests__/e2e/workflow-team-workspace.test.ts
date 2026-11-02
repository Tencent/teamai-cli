/**
 * Real CLI: a step with `workspace: { team: { branch } }` runs in a fresh clone of the team repo, on that branch as
 * origin has it with the default branch merged in, and `deliver: pr` proposes what it committed there to the team
 * repo's default branch. The team origin is a GitHub URL git rewrites to a bare repository, and `gh` is a fake that
 * keeps the pull requests.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';
import { fakeGhHost, type FakeGh } from '../helpers/fake-gh.js';

const BRANCH = 'teamai/notes/alpha';
/** The workflow, whose one step runs the script at `edit` in the team workspace. */
const workflow = (edit: string): string => `schemaVersion: v1alpha1
name: edit-team
description: Add a line to the team's notes rule, on one branch per topic.
inputs: { topic: string }
steps:
  - id: edit
    workspace: { team: { branch: "teamai/notes/{{ inputs.topic }}" } }
    deliver: pr
    command: node ${JSON.stringify(edit)}
`;

/** A workflow whose step commits to the branch its input names whole. */
const anyBranch = (edit: string): string => `schemaVersion: v1alpha1
name: edit-any
description: Add a line to the team's notes rule on the branch the input names.
inputs: { branch: string }
steps:
  - id: edit
    workspace: { team: { branch: "{{ inputs.branch }}" } }
    deliver: pr
    command: node ${JSON.stringify(edit)}
`;

const RunSchema = z.object({
  steps: z.array(z.object({ id: z.string(), status: z.string(), failure: z.object({ code: z.string(), message: z.string() }).optional() })),
  deliveries: z.array(z.object({ url: z.string(), branch: z.string(), base: z.string(), step: z.string(), pass: z.number() })).optional(),
});

type RunOptions = { name?: string; inputs?: Record<string, string> };

/** Runs edit-team on topic alpha with the local driver, or workflow `name` on `inputs`; `script`, at `edit`, is what its step does in the team clone. */
async function runEdit(fixture: BenchmarkFixture, edit: string, script: string, { name = 'edit-team', inputs = { topic: 'alpha' } }: RunOptions): Promise<{ run: string; outcome: unknown; state: z.infer<typeof RunSchema>; said: string }> {
  fs.writeFileSync(edit, script);
  const ran = await fixture.teamai(['workflow', 'start', name, '--driver', 'local', '--inputs', JSON.stringify(inputs)]);
  const done = z.object({ run: z.string(), outcome: z.string() }).safeParse(envelope(ran).data?.done);
  if (!done.success) throw new Error(`no run: ${said(ran)}`);
  return { run: done.data.run, outcome: done.data.outcome, state: RunSchema.parse(fixture.runFile(done.data.run)), said: said(ran) };
}

describe('a step in the team workspace, run through the real CLI', () => {
  let fixture: BenchmarkFixture;
  let gh: FakeGh;
  let edit: string;

  const git = (args: string[]): string => execFileSync('git', ['--git-dir', fixture.teamOrigin, ...args], { encoding: 'utf8' }).trim();
  /** The tip of `branch` on the team origin, or '' when origin has no such branch. */
  const branchHead = (branch = BRANCH): string => spawnSync('git', ['--git-dir', fixture.teamOrigin, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { encoding: 'utf8' }).stdout.trim();
  const onBranch = (branch: string, file: string): string => git(['show', `${branch}:${file}`]);
  const filesOnBranch = (branch: string): string[] => git(['ls-tree', '-r', '--name-only', branch]).split('\n');
  /** The open pull requests from `branch`; each test reads its own branch's, whatever another test opened or closed. */
  const pullsFrom = (branch: string) => gh.pulls().filter((pull) => pull.head === branch);

  const run = (script: string, options: RunOptions = {}) => runEdit(fixture, edit, script, options);

  beforeAll(async () => {
    fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false });
    gh = fakeGhHost(path.join(fixture.root, 'gh'));
    fs.symlinkSync(gh.bin, path.join(fixture.bin, 'gh'));
    edit = path.join(fixture.root, 'edit.js');
    fixture.pushTeam({ 'workflows/edit-team.yaml': workflow(edit), 'workflows/edit-any.yaml': anyBranch(edit), 'rules/old.md': '# Old\n', 'rules/notes.md': '# Notes\n' });
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);
  }, 120_000);

  afterAll(() => fixture?.remove());

  it('commits what the step changed to the branch on the team origin, and opens one pull request from it into main', async () => {
    // A skill with no description draws a review warning, which pull still places.
    const first = await run("const fs = require('fs'); fs.appendFileSync('rules/notes.md', 'first\\n'); fs.mkdirSync('skills/draft', { recursive: true }); fs.writeFileSync('skills/draft/SKILL.md', '---\\nname: draft\\n---\\n# Draft\\n');");

    expect(first.outcome, first.said).toBe('succeeded');
    expect(onBranch(BRANCH, 'rules/notes.md')).toBe('# Notes\nfirst');
    expect(onBranch(BRANCH, 'skills/draft/SKILL.md')).toBe('---\nname: draft\n---\n# Draft');
    expect(pullsFrom(BRANCH)).toHaveLength(1);
    expect(first.state.deliveries).toEqual([{ url: pullsFrom(BRANCH)[0]?.url, branch: BRANCH, base: 'main', step: 'edit', pass: 1 }]);
  }, 120_000);

  it('goes on from the branch as origin has it, with main merged in, deletes what the step deletes, and keeps the one pull request', async () => {
    const beta = 'teamai/notes/beta';
    const first = await run("require('fs').appendFileSync('rules/notes.md', 'first\\n');", { inputs: { topic: 'beta' } });
    expect(first.outcome, first.said).toBe('succeeded');
    const before = branchHead(beta);
    fixture.pushTeam({ 'rules/later.md': '# Later\n' });

    const second = await run("const fs = require('fs'); fs.appendFileSync('rules/notes.md', 'second\\n'); fs.rmSync('rules/old.md');", { inputs: { topic: 'beta' } });

    expect(second.outcome, second.said).toBe('succeeded');
    expect(onBranch(beta, 'rules/notes.md')).toBe('# Notes\nfirst\nsecond');
    expect(filesOnBranch(beta)).toContain('rules/later.md');
    expect(filesOnBranch(beta)).not.toContain('rules/old.md');
    expect(git(['merge-base', '--is-ancestor', before, beta])).toBe('');
    expect(pullsFrom(beta)).toHaveLength(1);
  }, 120_000);

  it('pushes nothing over a commit a teammate pushed to the branch while the step ran, and says so', async () => {
    const eta = 'teamai/notes/eta';
    const first = await run("require('fs').appendFileSync('rules/notes.md', 'first\\n');", { inputs: { topic: 'eta' } });
    expect(first.outcome, first.said).toBe('succeeded');
    const teammate = path.join(fixture.root, 'teammate');
    const failed = await run([
      "const { execFileSync } = require('child_process');",
      `execFileSync('git', ['clone', '-q', '--branch', ${JSON.stringify(eta)}, ${JSON.stringify(fixture.teamOrigin)}, ${JSON.stringify(teammate)}]);`,
      `require('fs').writeFileSync(${JSON.stringify(path.join(teammate, 'rules/theirs.md'))}, '# Theirs\\n');`,
      `for (const args of [['add', '-A'], ['-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-qm', 'theirs'], ['push', '-q', 'origin', ${JSON.stringify(eta)}]]) execFileSync('git', args, { cwd: ${JSON.stringify(teammate)} });`,
      "require('fs').appendFileSync('rules/notes.md', 'mine\\n');",
    ].join('\n'), { inputs: { topic: 'eta' } });

    expect(failed.outcome, failed.said).toBe('failed');
    const theirs = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: teammate, encoding: 'utf8' }).trim();
    expect(branchHead(eta)).toBe(theirs);
    expect(failed.state.steps.find((step) => step.id === 'edit')?.failure).toMatchObject({
      code: 'push_failed',
      message: expect.stringContaining(`${eta} moved on origin while step "edit" ran, so nothing was pushed and origin keeps it.`),
    });
    expect(pullsFrom(eta)).toHaveLength(1);
  }, 120_000);

  it('pushes nothing when the step leaves a team file teamai pull would reject, and names it', async () => {
    const before = branchHead();

    const refused = await run("require('fs').writeFileSync('workflows/broken.yaml', 'schemaVersion: v1alpha1\\nname: broken\\nsteps: []\\n');");

    expect(refused.outcome, refused.said).toBe('failed');
    expect(refused.state.steps.find((step) => step.id === 'edit')?.failure).toMatchObject({
      code: 'push_failed',
      message: expect.stringMatching(/^Step "edit" left team files teamai pull would reject, so nothing was pushed to teamai\/notes\/alpha:\nworkflows\/broken\.yaml:\d+: /),
    });
    expect(branchHead()).toBe(before);
    // The clone the failed step ran in goes once its run ended.
    expect(fs.existsSync(path.join(fixture.dataHome(), 'workflows', 'runs', refused.run, 'team'))).toBe(false);
  }, 120_000);

  it('pushes nothing teamai pull would not place, and names each file with why', async () => {
    const before = branchHead();

    const refused = await run([
      "const fs = require('fs');",
      "fs.writeFileSync('notes.txt', 'loose\\n');",
      "fs.symlinkSync('notes.md', 'rules/link.md');",
      // A repository of its own inside the clone, which git add records as a submodule.
      "const { execFileSync } = require('child_process');",
      "fs.mkdirSync('rules/vendored');",
      "for (const args of [['init', '-q'], ['-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '-q', '--allow-empty', '-m', 'vendored']]) execFileSync('git', args, { cwd: 'rules/vendored' });",
      "fs.mkdirSync('benchmarks/nowhere/tasks', { recursive: true });",
      "fs.writeFileSync('benchmarks/nowhere/tasks/orphan.yaml', 'prompt: nothing runs this\\n');",
      "fs.mkdirSync('benchmarks/broken', { recursive: true });",
      "fs.writeFileSync('benchmarks/broken/suite.yaml', 'schemaVersion: v1alpha1\\nname: broken\\n');",
      // web is no benchmarks namespace a manifest declares, so pull reads no suite under it.
      "fs.mkdirSync('benchmarks/web/regressions/tasks', { recursive: true });",
      "fs.writeFileSync('benchmarks/web/regressions/suite.yaml', 'schemaVersion: v1alpha1\\nname: regressions\\n');",
      "fs.writeFileSync('benchmarks/web/regressions/tasks/hidden.yaml', 'prompt: nothing runs this\\n');",
      "fs.mkdirSync('scorers', { recursive: true });",
      "fs.writeFileSync('scorers/broken.md', '---\\nname: broken\\n---\\nNo labels.\\n');",
    ].join('\n'));

    expect(refused.outcome, refused.said).toBe('failed');
    const failure = refused.state.steps.find((step) => step.id === 'edit')?.failure;
    expect(failure?.code).toBe('push_failed');
    const lines = failure?.message.split('\n') ?? [];
    expect(lines[0]).toBe('Step "edit" left team files teamai pull would reject, so nothing was pushed to teamai/notes/alpha:');
    expect(lines).toEqual(expect.arrayContaining([
      'notes.txt: not in a directory teamai pulls, such as skills/, rules/, scorers/ or benchmarks/',
      'rules/link.md: a symlink, which teamai pull does not place',
      'rules/vendored: a submodule, which teamai pull does not place',
      'benchmarks/nowhere/tasks/orphan.yaml: in no suite teamai pull reads: a suite is benchmarks/<suite>/ or benchmarks/<namespace>/<suite>/ with a suite.yaml',
      'benchmarks/web/regressions/suite.yaml: in no suite teamai pull reads: a suite is benchmarks/<suite>/ or benchmarks/<namespace>/<suite>/ with a suite.yaml',
      'benchmarks/web/regressions/tasks/hidden.yaml: in no suite teamai pull reads: a suite is benchmarks/<suite>/ or benchmarks/<namespace>/<suite>/ with a suite.yaml',
      expect.stringMatching(/^benchmarks\/broken\/suite\.yaml:\d+: /),
      expect.stringMatching(/^scorers\/broken\.md\b/),
    ]));
    expect(branchHead()).toBe(before);
  }, 120_000);

  it('pushes nothing when what the step deletes breaks a team file it left alone, and names that file', async () => {
    fixture.pushTeam({
      'scorers/kept.md': '---\nlabels:\n  - { value: good, score: 1, description: Good. }\n  - { value: bad, score: 0, description: Bad. }\npassingScore: 1\n---\nJudge it.\n',
      'workflows/scored.yaml': 'schemaVersion: v1alpha1\nname: scored\ndescription: Review the change.\nsteps:\n  - id: review\n    scorers: [kept]\n    prompt: Review the change.\n',
    });

    const refused = await run("const fs = require('fs'); fs.rmSync('scorers/kept.md'); fs.rmSync('benchmarks/fix/tasks', { recursive: true });", { inputs: { topic: 'theta' } });

    expect(refused.outcome, refused.said).toBe('failed');
    const lines = refused.state.steps.find((step) => step.id === 'edit')?.failure?.message.split('\n') ?? [];
    expect(lines[0]).toBe('Step "edit" left team files teamai pull would reject, so nothing was pushed to teamai/notes/theta:');
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^workflows\/scored\.yaml\b.*\bkept\b/), expect.stringMatching(/^benchmarks\/fix\/suite\.yaml\b/)]));
    expect(branchHead('teamai/notes/theta')).toBe('');
  }, 120_000);

  it('pushes what the step changed in a team file pull already rejects on main, when it breaks nothing more there', async () => {
    fixture.pushTeam({ 'workflows/legacy.yaml': 'schemaVersion: v1alpha1\nname: legacy\ndescription: Kept as it was.\ncolour: blue\nsteps:\n  - id: run\n    command: "true"\n' });

    const pushed = await run("const fs = require('fs'); fs.writeFileSync('workflows/legacy.yaml', '# Kept for the old CI.\\n' + fs.readFileSync('workflows/legacy.yaml', 'utf8'));", { inputs: { topic: 'iota' } });

    expect(pushed.outcome, pushed.said).toBe('succeeded');
    expect(onBranch('teamai/notes/iota', 'workflows/legacy.yaml')).toMatch(/^# Kept for the old CI\.\n/);
  }, 120_000);

  it('pushes nothing when the step adds one more of an error main already has', async () => {
    fixture.pushTeam({ 'workflows/inputs.yaml': 'schemaVersion: v1alpha1\nname: inputs\ndescription: Kept as it was.\ninputs:\n  old/name: string\nsteps:\n  - id: run\n    command: "true"\n' });

    const refused = await run("const fs = require('fs'); fs.writeFileSync('workflows/inputs.yaml', fs.readFileSync('workflows/inputs.yaml', 'utf8').replace('  old/name: string\\n', '  old/name: string\\n  new/name: string\\n'));", { inputs: { topic: 'kappa' } });

    expect(refused.outcome, refused.said).toBe('failed');
    expect(refused.state.steps.find((step) => step.id === 'edit')?.failure?.message.split('\n')).toEqual(expect.arrayContaining([expect.stringMatching(/^workflows\/inputs\.yaml:\d+: field "inputs"/)]));
    expect(branchHead('teamai/notes/kappa')).toBe('');
  }, 120_000);

  it('runs nothing on the team repo\'s default branch, so no change skips review', async () => {
    const main = git(['rev-parse', 'main']);

    const refused = await run("require('fs').appendFileSync('rules/notes.md', 'unreviewed\\n');", { name: 'edit-any', inputs: { branch: 'main' } });

    expect(refused.outcome, refused.said).toBe('failed');
    expect(refused.state.steps.find((step) => step.id === 'edit')?.failure).toEqual({
      code: 'workspace_base',
      message: 'Step "edit" would commit to main, the team repo\'s default branch, so its work would skip review. Give workspace team branch another name.',
    });
    expect(git(['rev-parse', 'main'])).toBe(main);
  }, 120_000);

  it('pushes nothing and opens no pull request once the branch holds what main holds, as after a squash merge', async () => {
    const gamma = 'teamai/notes/gamma';
    const first = await run("require('fs').writeFileSync('rules/gamma.md', '# Gamma\\n');", { inputs: { topic: 'gamma' } });
    expect(first.outcome, first.said).toBe('succeeded');
    const proposed = branchHead(gamma);
    // The host squash-merges the proposal into main and closes its request, and keeps the branch.
    fixture.pushTeam({ 'rules/gamma.md': '# Gamma\n' });
    gh.configure({ open: [] });

    const again = await run('', { inputs: { topic: 'gamma' } });

    expect(again.outcome, again.said).toBe('succeeded');
    expect(branchHead(gamma)).toBe(proposed);
    expect(again.state.deliveries).toBeUndefined();
    expect(pullsFrom(gamma)).toEqual([]);
  }, 120_000);

  it('opens the pull request only once a teamai pull or push in progress lets go of the team repo', async () => {
    const delta = 'teamai/notes/delta';
    const lock = path.join(fixture.dataHome(), '.sync-lock');
    // A live process holds the lock, as a teamai pull does while it updates the member's team repo.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'pull' }));
    const running = run("require('fs').writeFileSync('rules/delta.md', '# Delta\\n');", { inputs: { topic: 'delta' } });

    try {
      for (const until = Date.now() + 60_000; branchHead(delta) === '';) {
        if (Date.now() > until) throw new Error('the step never pushed its branch');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(pullsFrom(delta)).toEqual([]);
    } finally {
      fs.rmSync(lock, { force: true });
    }

    const delivered = await running;

    expect(delivered.outcome, delivered.said).toBe('succeeded');
    expect(pullsFrom(delta)).toHaveLength(1);
  }, 180_000);

  it('runs nothing on a branch that conflicts with main, and says how to resolve it', async () => {
    const zeta = 'teamai/notes/zeta';
    const first = await run("require('fs').writeFileSync('rules/zeta.md', '# Zeta\\nfrom the branch\\n');", { inputs: { topic: 'zeta' } });
    expect(first.outcome, first.said).toBe('succeeded');
    const before = branchHead(zeta);
    fixture.pushTeam({ 'rules/zeta.md': '# Zeta\nfrom main\n' });

    const conflicted = await run("require('fs').appendFileSync('rules/zeta.md', 'never\\n');", { inputs: { topic: 'zeta' } });

    expect(conflicted.outcome, conflicted.said).toBe('failed');
    expect(conflicted.state.steps.find((step) => step.id === 'edit')?.failure).toMatchObject({
      code: 'merge_conflict',
      message: expect.stringContaining(`${zeta} conflicts with main on the team repo's origin in rules/zeta.md`),
    });
    expect(branchHead(zeta)).toBe(before);
  }, 120_000);

  it('publishes no run whose step worked in the team workspace, since another machine could not reach its clone', async () => {
    const ran = await run("require('fs').writeFileSync('rules/epsilon.md', '# Epsilon\\n');", { inputs: { topic: 'epsilon' } });
    expect(ran.outcome, ran.said).toBe('succeeded');

    const published = await fixture.teamai(['workflow', 'publish', ran.run]);

    expect(published.code, said(published)).not.toBe(0);
    expect(envelope(published).error).toMatchObject({
      code: 'isolated_run',
      message: `Run ${ran.run} has a step in the team workspace, whose clone is on this machine only, so it cannot be published. Start the workflow again on the other machine.`,
    });
  }, 120_000);
});

describe('a step in the team workspace of a team that assigns roles, one of which overrides a shared workflow', () => {
  let fixture: BenchmarkFixture;
  let edit: string;
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-edit-'));
  const CHECK = 'schemaVersion: v1alpha1\nname: check\ndescription: Check the change.\nsteps:\n  - id: check\n    command: "true"\n';

  beforeAll(async () => {
    edit = path.join(scripts, 'edit.js');
    fixture = await benchmarkFixture({
      tool: 'does-nothing',
      sandbox: false,
      team: {
        'manifest/roles.yaml': 'version: 1\nroles:\n  - id: ops\n    resources:\n      knowledge: []\n      skills: []\n      workflows: [ops]\n',
        // The team assigns roles, so a member it does not list holds none and pulls the shared workflow.
        'manifest/members.yaml': 'version: 1\nmembers:\n  alice: [ops]\n',
        'workflows/ops/check.yaml': CHECK,
        'workflows/check.yaml': CHECK,
        'workflows/edit-team.yaml': workflow(edit),
        'rules/notes.md': '# Notes\n',
      },
    });
    const gh = fakeGhHost(path.join(fixture.root, 'gh'));
    fs.symlinkSync(gh.bin, path.join(fixture.bin, 'gh'));
  }, 120_000);

  afterAll(() => {
    fixture?.remove();
    fs.rmSync(scripts, { recursive: true, force: true });
  });

  it('pushes nothing when the step breaks the shared workflow, which members outside the role still pull', async () => {
    const refused = await runEdit(fixture, edit, "require('fs').writeFileSync('workflows/check.yaml', 'schemaVersion: v1alpha1\\nname: check\\nsteps: []\\n');", {});

    expect(refused.outcome, refused.said).toBe('failed');
    expect(refused.state.steps.find((step) => step.id === 'edit')?.failure?.message.split('\n')).toEqual(expect.arrayContaining([expect.stringMatching(/^workflows\/check\.yaml:\d+: /)]));
  }, 120_000);
});

describe('a step in the team workspace in single-repo mode, where the team files are .teamai/ of the project repo', () => {
  let fixture: BenchmarkFixture;
  let gh: FakeGh;
  let edit: string;

  const onBranch = (file: string): string => execFileSync('git', ['--git-dir', fixture.productOrigin, 'show', `${BRANCH}:${file}`], { encoding: 'utf8' }).trim();
  const branchHead = (): string => spawnSync('git', ['--git-dir', fixture.productOrigin, 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`], { encoding: 'utf8' }).stdout.trim();
  const run = (script: string) => runEdit(fixture, edit, script, {});

  // The workflow names the script, so it lives outside the fixture the workflow seeds.
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-edit-'));

  beforeAll(async () => {
    edit = path.join(scripts, 'edit.js');
    fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false, selfMode: true, team: { 'workflows/edit-team.yaml': workflow(edit), 'rules/notes.md': '# Notes\n' } });
    gh = fakeGhHost(path.join(fixture.root, 'gh'));
    fs.symlinkSync(gh.bin, path.join(fixture.bin, 'gh'));
  }, 120_000);

  afterAll(() => {
    fixture?.remove();
    fs.rmSync(scripts, { recursive: true, force: true });
  });

  it('runs the step in .teamai/ of a fresh clone, and proposes its commit to the project repo\'s main', async () => {
    const first = await run("require('fs').appendFileSync('rules/notes.md', 'first\\n');");

    expect(first.outcome, first.said).toBe('succeeded');
    expect(onBranch('.teamai/rules/notes.md')).toBe('# Notes\nfirst');
    expect(gh.pulls().map((pull) => pull.head)).toEqual([BRANCH]);
    expect(first.state.deliveries).toEqual([{ url: gh.pulls()[0]?.url, branch: BRANCH, base: 'main', step: 'edit', pass: 1 }]);
  }, 120_000);

  it('pushes nothing the step changed in the project outside .teamai/', async () => {
    const before = branchHead();

    const refused = await run("require('fs').writeFileSync('../answer.js', 'module.exports = 42;\\n');");

    expect(refused.outcome, refused.said).toBe('failed');
    expect(refused.state.steps.find((step) => step.id === 'edit')?.failure?.message.split('\n').slice(0, 2)).toEqual([
      `Step "edit" left team files teamai pull would reject, so nothing was pushed to ${BRANCH}:`,
      'answer.js: outside .teamai/, where the team files are',
    ]);
    expect(branchHead()).toBe(before);
  }, 120_000);
});
