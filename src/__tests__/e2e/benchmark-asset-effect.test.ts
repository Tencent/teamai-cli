/**
 * Real CLI on the local driver: a task's `covers` splits the difference of an arm that runs without exactly one covered
 * path by the tasks that cover it, with each skill trial's routing value in #1469's terms, and plan refuses the covers
 * it cannot compare. Issue #1605's criteria 1 to 7.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, fixTask, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string(), table: z.object({ assets: z.array(z.object({ path: z.string(), without: z.string().nullable().optional(), has: z.string().nullable().optional() }).passthrough()) }).passthrough() }).passthrough() }).passthrough();
const RecordSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), covers: z.array(z.string()).optional() })),
  trials: z.array(z.object({ task: z.string(), arm: z.string(), result: z.string(), routing: z.record(z.string(), z.string()).optional() }).passthrough()),
});
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const SKILL = (name: string): string => `---\nname: ${name}\ndescription: Helps with ${name}.\n---\nUse ${name}.\n`;
const SUITE = (arms: string): string => `schemaVersion: v1alpha1\nname: fix\nrepo: ${PRODUCT_URL}\ndefaults:\n  tool: claude\n${arms}repetitions: 1\ntimeout: 10m\n`;
const COVERS_TASK = (covers?: string[]): string => {
  const task = fixTask('{{startingCommit}}');

  return covers === undefined ? task : task.replace(/startingCommit: .*\n/, (line) => `${line}covers: [${covers.join(', ')}]\n`);
};

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** A team with skill auth-tokens and rule rules/auth.md, a suite with a pulled arm, an arm without the skill and one without both. */
async function coveredFixture(): Promise<{ fixture: BenchmarkFixture; run: string; text: string }> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, tools: ['claude'], loadsSkill: 'auth-tokens',
    suite: SUITE('arms:\n  - name: pulled\n  - name: no-tokens\n    team: { without: [skills/auth-tokens] }\n  - name: no-both\n    team: { without: [skills/auth-tokens, rules/auth.md] }\n'),
    tasks: { fix: COVERS_TASK(['skills/auth-tokens', 'rules/auth.md']), copy: COVERS_TASK() },
    team: { 'skills/auth-tokens/SKILL.md': SKILL('auth-tokens'), 'rules/auth.md': 'Never weaken a check.\n' },
  });
  fixtures.push(fixture);
  const pulled = await fixture.teamai(['pull']);
  expect(pulled.code, said(pulled)).toBe(0);
  const started = await fixture.teamai(['benchmark', 'run', 'fix']);
  const done = DoneSchema.safeParse(envelope(started).data?.done);
  if (!done.success) throw new Error(`the run did not end: ${said(started)}`);

  return { fixture, run: done.data.run, text: done.data.outputs.text };
}

describe('asset effect tables on the local driver', () => {
  it('prints one table per covered path an arm leaves out exactly, splits by the tasks that cover it, and carries each trial\'s routing value', async () => {
    const { fixture, run, text } = await coveredFixture();
    const record = RecordSchema.parse(fixture.benchmarkRecord(run));

    // One table per covered path, against the arm that differs only by leaving nothing out; the two-path arm gets none.
    expect(text).toContain('Asset effect · skills/auth-tokens · no-tokens -> pulled · claude');
    expect(text).toContain('Asset effect · rules/auth.md · pulled · claude');
    expect(text).toContain('rules/auth.md');
    expect(text).not.toContain('no-both -> pulled');
    expect(text).toContain('fix   yes');
    expect(text).toContain('copy   no');
    // A rule has no loads to observe, and the record carries no routing values for it.
    expect(text).toContain('not observed');
    expect(record.trials.every(({ routing }) => routing === undefined || Object.keys(routing).join(',') === 'auth-tokens')).toBe(true);
    // Criterion 3: the loaded trial of a task that does not cover the skill is extra, the unloaded one of a covering task is missed.
    expect(record.trials).toEqual(expect.arrayContaining([
      expect.objectContaining({ task: 'fix', arm: 'pulled', result: 'passed', routing: { 'auth-tokens': 'fit' } }),
      expect.objectContaining({ task: 'copy', arm: 'pulled', result: 'passed', routing: { 'auth-tokens': 'extra' } }),
      expect.objectContaining({ task: 'fix', arm: 'no-tokens', result: 'passed' }),
      expect.objectContaining({ task: 'copy', arm: 'no-tokens', result: 'passed' }),
    ]));
    // The arm that runs without the skill by design reports no routing for it: the asset is absent, not misrouted.
    expect(record.trials.filter(({ arm }) => arm === 'no-tokens').every(({ routing }) => routing === undefined)).toBe(true);
    // Criterion 2: the two splits add up, in trials, to the pair's paired trials: one paired trial per task.
    expect(text).toContain('tasks that cover it');
    expect(text).toContain('other tasks');
    expect(record.tasks.map(({ id, covers }) => ({ id, covers }))).toEqual([
      { id: 'copy', covers: undefined },
      { id: 'fix', covers: ['rules/auth.md', 'skills/auth-tokens'] },
    ]);
  }, 300_000);

  it('reads a tool that reports no skill loads as unknown, never idle or missed, and still counts its trials', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], loadsSkill: 'auth-tokens',
      suite: SUITE('arms:\n  - name: pulled\n  - name: no-tokens\n    team: { without: [skills/auth-tokens] }\n'),
      tasks: { fix: fixTask('{{startingCommit}}', 'Make the check pass. [no session]').replace(/startingCommit: .*\n/, (line) => `${line}covers: [skills/auth-tokens]\n`) },
      team: { 'skills/auth-tokens/SKILL.md': SKILL('auth-tokens') },
    });
    fixtures.push(fixture);
    expect((await fixture.teamai(['pull'])).code).toBe(0);
    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.safeParse(envelope(started).data?.done);
    if (!done.success) throw new Error(`the run did not end: ${said(started)}`);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.data.run));
    const text = done.data.outputs.text;

    expect(record.trials.filter(({ arm }) => arm === 'pulled').every(({ result, routing }) => result === 'passed' && routing?.['auth-tokens'] === 'unknown')).toBe(true);

    // The without-arm carries no routing at all: its trials never even watched the skill it runs without.
    expect(record.trials.filter(({ arm }) => arm === 'no-tokens').every(({ routing }) => routing === undefined)).toBe(true);

    expect(text).toContain('0/1 unknown');
    expect(text).toContain('tasks that cover it');
    expect(text).toContain('passed when loaded -');
  }, 300_000);

  it('records no routing for a covered skill on an arm that runs without the namespace holding it', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], loadsSkill: 'auth-tokens',
      suite: SUITE('arms:\n  - name: pulled\n  - name: no-dev\n    team: { without: [skills/dev] }\n'),
      tasks: { fix: COVERS_TASK(['skills/dev/auth-tokens']) },
      team: { 'skills/dev/auth-tokens/SKILL.md': SKILL('auth-tokens') },
    });
    fixtures.push(fixture);
    expect((await fixture.teamai(['pull'])).code).toBe(0);
    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.safeParse(envelope(started).data?.done);
    if (!done.success) throw new Error(`the run did not end: ${said(started)}`);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.data.run));

    expect(record.trials.find(({ arm }) => arm === 'pulled')?.routing).toEqual({ 'auth-tokens': 'fit' });
    expect(record.trials.find(({ arm }) => arm === 'no-dev')?.routing).toBeUndefined();
  }, 300_000);

  it('records no routing for a covered skill on an arm that runs with no team assets', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], loadsSkill: 'auth-tokens',
      suite: SUITE('arms:\n  - name: pulled\n  - name: bare\n    team: none\n'),
      tasks: { fix: COVERS_TASK(['skills/auth-tokens']) },
      team: { 'skills/auth-tokens/SKILL.md': SKILL('auth-tokens') },
    });
    fixtures.push(fixture);
    expect((await fixture.teamai(['pull'])).code).toBe(0);
    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.safeParse(envelope(started).data?.done);
    if (!done.success) throw new Error(`the run did not end: ${said(started)}`);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.data.run));

    expect(record.trials.find(({ arm }) => arm === 'pulled')?.routing).toEqual({ 'auth-tokens': 'fit' });
    expect(record.trials.find(({ arm }) => arm === 'bare')?.routing).toBeUndefined();
  }, 300_000);

  it('refuses a covered path the pulled team revision does not have, and starts no run', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'],
      tasks: { fix: COVERS_TASK(['rules/missing.md']) },
    });
    fixtures.push(fixture);
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.teamClone, encoding: 'utf8' }).trim();
    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: {
      code: 'arm_team_unresolved',
      message: `A task covers rules/missing.md, which team revision ${revision.slice(0, 7)} does not have. Fix the team's tasks, push them, run teamai pull, and start again.`,
    } });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it('prints a separated difference from a run where the skill matters, with numbers the interval backs (#1684 review)', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes-only-with-the-skill', sandbox: true, tools: ['claude'], loadsSkill: 'auth-tokens',
      suite: SUITE('arms:\n  - name: pulled\n  - name: no-tokens\n    team: { without: [skills/auth-tokens] }\n').replace('repetitions: 1', 'repetitions: 2'),
      tasks: { fix: COVERS_TASK(['skills/auth-tokens']) },
      team: { 'skills/auth-tokens/SKILL.md': SKILL('auth-tokens') },
    });
    fixtures.push(fixture);
    expect((await fixture.teamai(['pull'])).code).toBe(0);
    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.safeParse(envelope(started).data?.done);

    if (!done.success) throw new Error(`the run did not end: ${said(started)}`);

    const text = done.data.outputs.text;

    expect(text).toContain('fix   yes   0% (0/2)   100% (2/2)   2/2 fit');
    expect(text).toContain('tasks that cover it   +100 pp   0/2 -> 2/2   95% +7 to +100 pp');
    expect(text).toContain('passed when loaded 2/2 · passed when not loaded -');
  }, 300_000);

  it('accepts two tasks that cover the same path, which is one cover, not an ambiguity (#1684 review)', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], loadsSkill: 'auth-tokens',
      suite: SUITE('arms:\n  - name: pulled\n  - name: no-tokens\n    team: { without: [skills/auth-tokens] }\n'),
      tasks: { fix: COVERS_TASK(['skills/auth-tokens']), copy: COVERS_TASK(['skills/auth-tokens']) },
      team: { 'skills/auth-tokens/SKILL.md': SKILL('auth-tokens') },
    });
    fixtures.push(fixture);
    expect((await fixture.teamai(['pull'])).code).toBe(0);
    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.safeParse(envelope(started).data?.done);

    if (!done.success) throw new Error(`the run did not end: ${said(started)}`);

    const record = RecordSchema.parse(fixture.benchmarkRecord(done.data.run));

    expect(record.trials).toHaveLength(4);
    expect(done.data.outputs.text).toContain('Asset effect · skills/auth-tokens · no-tokens -> pulled · claude');
  }, 300_000);

  it('refuses two covered skill paths of the same skill name, whose loads a trial could not tell apart', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'],
      tasks: { fix: COVERS_TASK(['skills/release', 'skills/ops/release']) },
      team: { 'skills/release/SKILL.md': SKILL('release'), 'skills/ops/release/SKILL.md': SKILL('release') },
    });
    fixtures.push(fixture);
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);
    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: {
      code: 'task_covers_ambiguous',
      message: 'Tasks cover skills/ops/release and skills/release, two skills of the same name release, which a trial\'s load record cannot tell apart. Cover one of them, fix the team\'s tasks, push them, run teamai pull, and start again.',
    } });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);
});
