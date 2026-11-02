/**
 * Real CLI (#1181): an arm on a team branch that removes a skill lists that skill, with how many of its trials and of the
 * defaults arm's loaded it, as the pass of each trial records it in `used`. A trial with no `used` counts as unknown.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const SUITE = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: with-skill
  - name: without-skill
    team: bench/without-fixer
repetitions: 1
timeout: 10m
`;
const SKILL = (name: string): string => `---\nname: ${name}\ndescription: Helps with ${name}.\n---\nUse ${name}.\n`;
const DoneSchema = z.object({ run: z.string(), outputs: z.object({ text: z.string() }) });
const RecordSchema = z.object({
  baselineTeamRevision: z.string(),
  skillChanges: z.unknown(),
  trials: z.array(z.object({ arm: z.string(), used: z.record(z.string(), z.string()).optional() }).passthrough()),
}).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A workflow of two prompts, the second of which the fake claude leaves no session for. */
const LOOK_THEN_FIX = `schemaVersion: v1alpha1
name: look-then-fix
description: Look at the task, then fix it.
inputs: { task: string }
steps:
  - id: look
    prompt: "Look at this: {{ inputs.task }}"
  - id: fix
    needs: [look]
    prompt: Fix it. [no session]
`;

/**
 * A team with skills fixer and helper and workflow look-then-fix on main, and branch bench/without-fixer without fixer,
 * pulled by the member, who runs `suite`.
 */
async function twoBranches(loadsSkill?: string, suite = SUITE): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, tools: ['claude'], suite,
    team: { 'skills/fixer/SKILL.md': SKILL('fixer'), 'skills/helper/SKILL.md': SKILL('helper'), 'workflows/look-then-fix.yaml': LOOK_THEN_FIX },
    ...(loadsSkill ? { loadsSkill } : {}),
  });
  fixtures.push(fixture);
  const branch = path.join(fixture.root, 'branch');
  git(fixture.root, 'clone', '-q', fixture.teamOrigin, branch);
  fs.rmSync(path.join(branch, 'skills', 'fixer'), { recursive: true });
  git(branch, 'add', '-A');
  git(branch, '-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'without fixer');
  git(branch, 'push', '-q', 'origin', 'HEAD:bench/without-fixer');
  const pulled = await fixture.teamai(['pull']);
  expect(pulled.code, said(pulled)).toBe(0);
  return fixture;
}

describe('benchmark skill loads', () => {
  it('lists the skill a team branch removes, with the loads the local driver recorded on each arm', async () => {
    const fixture = await twoBranches('fixer');

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));
    expect(record.skillChanges).toEqual([{ arm: 'without-skill', defaults: 'with-skill', skills: [{ name: 'fixer', change: 'removed' }] }]);
    expect(record.trials.map(({ arm, used }) => ({ arm, used }))).toEqual([
      { arm: 'with-skill', used: { fixer: 'loaded' } },
      { arm: 'without-skill', used: {} },
    ]);
    expect(done.outputs.text).toContain('| Arm | Skill | Change | Loaded in this arm | Loaded in the defaults arm |');
    expect(done.outputs.text).toContain('| without-skill | fixer | removed | 0/1 | 1/1 |');
  }, 240_000);

  it('reads both counts as unknown when no pass recorded which skills it loaded', async () => {
    const fixture = await twoBranches();

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));
    expect(record.trials.map(({ used }) => used)).toEqual([undefined, undefined]);
    expect(record.baselineTeamRevision).toBe(git(fixture.teamClone, 'rev-parse', 'HEAD'));
    expect(done.outputs.text).toContain('| without-skill | fixer | removed | unknown (1) | unknown (1) |');
  }, 240_000);

  it('reads a skill as unknown, never as not loaded, on workflow arms whose prompts were only partly observed', async () => {
    const fixture = await twoBranches('fixer', SUITE.replace('  tool: claude\n', '  tool: claude\n  workflow: look-then-fix\n'));

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run)).trials.map(({ arm, used }) => ({ arm, used }))).toEqual([
      { arm: 'with-skill', used: { fixer: 'loaded' } },
      { arm: 'without-skill', used: { fixer: 'unknown' } },
    ]);
    expect(done.outputs.text).toContain('| without-skill | fixer | removed | unknown (1) | 1/1 |');
  }, 240_000);
});
