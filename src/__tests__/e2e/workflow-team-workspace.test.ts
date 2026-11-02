/**
 * Real CLI: a step with `workspace: { team: { branch } }` runs in a fresh clone of the team repo, on that branch as
 * origin has it with the default branch merged in, and `deliver: pr` proposes what it committed there to the team
 * repo's default branch. The team origin is a GitHub URL git rewrites to a bare repository, and `gh` is a fake that
 * keeps the pull requests.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

describe('a step in the team workspace, run through the real CLI', () => {
  let fixture: BenchmarkFixture;
  let gh: FakeGh;
  let edit: string;

  const git = (args: string[]): string => execFileSync('git', ['--git-dir', fixture.teamOrigin, ...args], { encoding: 'utf8' }).trim();
  const branchHead = (): string => spawnSync('git', ['--git-dir', fixture.teamOrigin, 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`], { encoding: 'utf8' }).stdout.trim();
  const onBranch = (file: string): string => git(['show', `${BRANCH}:${file}`]);
  const filesOnBranch = (): string[] => git(['ls-tree', '-r', '--name-only', BRANCH]).split('\n');

  /** Runs edit-team on topic alpha with the local driver, or `workflow` on `inputs`; `script` is what its step does in the team clone. */
  const run = async (script: string, { workflow = 'edit-team', inputs = { topic: 'alpha' } }: { workflow?: string; inputs?: Record<string, string> } = {}): Promise<{ outcome: unknown; state: z.infer<typeof RunSchema>; said: string }> => {
    fs.writeFileSync(edit, script);
    const ran = await fixture.teamai(['workflow', 'start', workflow, '--driver', 'local', '--inputs', JSON.stringify(inputs)]);
    const done = z.object({ run: z.string(), outcome: z.string() }).safeParse(envelope(ran).data?.done);
    if (!done.success) throw new Error(`no run: ${said(ran)}`);
    return { outcome: done.data.outcome, state: RunSchema.parse(fixture.runFile(done.data.run)), said: said(ran) };
  };

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
    const first = await run("require('fs').appendFileSync('rules/notes.md', 'first\\n');");

    expect(first.outcome, first.said).toBe('succeeded');
    expect(onBranch('rules/notes.md')).toBe('# Notes\nfirst');
    expect(gh.pulls().map((pull) => pull.head)).toEqual([BRANCH]);
    expect(first.state.deliveries).toEqual([{ url: gh.pulls()[0]?.url, branch: BRANCH, base: 'main', step: 'edit', pass: 1 }]);
  }, 120_000);

  it('goes on from the branch as origin has it, with main merged in, deletes what the step deletes, and keeps the one pull request', async () => {
    const before = branchHead();
    fixture.pushTeam({ 'rules/later.md': '# Later\n' });

    const second = await run("const fs = require('fs'); fs.appendFileSync('rules/notes.md', 'second\\n'); fs.rmSync('rules/old.md');");

    expect(second.outcome, second.said).toBe('succeeded');
    expect(onBranch('rules/notes.md')).toBe('# Notes\nfirst\nsecond');
    expect(filesOnBranch()).toContain('rules/later.md');
    expect(filesOnBranch()).not.toContain('rules/old.md');
    expect(git(['merge-base', '--is-ancestor', before, BRANCH])).toBe('');
    expect(gh.pulls().map((pull) => pull.head)).toEqual([BRANCH]);
  }, 120_000);

  it('pushes nothing over a commit a teammate pushed to the branch while the step ran, and says so', async () => {
    const teammate = path.join(fixture.root, 'teammate');
    const failed = await run([
      "const { execFileSync } = require('child_process');",
      `execFileSync('git', ['clone', '-q', '--branch', ${JSON.stringify(BRANCH)}, ${JSON.stringify(fixture.teamOrigin)}, ${JSON.stringify(teammate)}]);`,
      `require('fs').writeFileSync(${JSON.stringify(path.join(teammate, 'rules/theirs.md'))}, '# Theirs\\n');`,
      `for (const args of [['add', '-A'], ['-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-qm', 'theirs'], ['push', '-q', 'origin', ${JSON.stringify(BRANCH)}]]) execFileSync('git', args, { cwd: ${JSON.stringify(teammate)} });`,
      "require('fs').appendFileSync('rules/notes.md', 'mine\\n');",
    ].join('\n'));

    expect(failed.outcome, failed.said).toBe('failed');
    const theirs = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: teammate, encoding: 'utf8' }).trim();
    expect(branchHead()).toBe(theirs);
    expect(failed.state.steps.find((step) => step.id === 'edit')?.failure).toMatchObject({
      code: 'push_failed',
      message: expect.stringContaining(`${BRANCH} moved on origin while step "edit" ran, so nothing was pushed and origin keeps it.`),
    });
    expect(gh.pulls()).toHaveLength(1);
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
  }, 120_000);

  it('runs nothing on the team repo\'s default branch, so no change skips review', async () => {
    const main = git(['rev-parse', 'main']);

    const refused = await run("require('fs').appendFileSync('rules/notes.md', 'unreviewed\\n');", { workflow: 'edit-any', inputs: { branch: 'main' } });

    expect(refused.outcome, refused.said).toBe('failed');
    expect(refused.state.steps.find((step) => step.id === 'edit')?.failure).toEqual({
      code: 'workspace_base',
      message: 'Step "edit" would commit to main, the team repo\'s default branch, so its work would skip review. Give workspace team branch another name.',
    });
    expect(git(['rev-parse', 'main'])).toBe(main);
  }, 120_000);

  it('runs nothing on a branch that conflicts with main, and says how to resolve it', async () => {
    const before = branchHead();
    fixture.pushTeam({ 'rules/notes.md': '# Notes\nfrom main\n' });

    const conflicted = await run("require('fs').appendFileSync('rules/notes.md', 'never\\n');");

    expect(conflicted.outcome, conflicted.said).toBe('failed');
    expect(conflicted.state.steps.find((step) => step.id === 'edit')?.failure).toMatchObject({
      code: 'merge_conflict',
      message: expect.stringContaining(`${BRANCH} conflicts with main on the team repo's origin in rules/notes.md`),
    });
    expect(branchHead()).toBe(before);
  }, 120_000);
});
