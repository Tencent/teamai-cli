/**
 * Real CLI: an arm's `team` decides the team assets its trials get: the revision this checkout pulled, none, another
 * revision of the team repo, or the pulled revision without some of its paths.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const TEAM_SKILLS = new Set(['fixer', 'helper', 'newer']);
const SKILL = (name: string): string => `---\nname: ${name}\ndescription: Helps with ${name}.\n---\nUse ${name}.\n`;
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const RunSchema = z.object({
  steps: z.array(z.object({ id: z.string(), agent: z.object({ team: z.object({ revision: z.string() }).passthrough().optional() }).passthrough().optional() }).passthrough()),
});
const RecordSchema = z.object({
  arms: z.array(z.object({ name: z.string(), team: z.unknown() }).passthrough()),
  skillChanges: z.unknown(),
  trials: z.array(z.object({ arm: z.string(), order: z.number(), result: z.string() }).passthrough()),
}).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function suite(arms: string): string {
  return `schemaVersion: v1alpha1\nname: fix\nrepo: ${PRODUCT_URL}\ndefaults:\n  tool: claude\n${arms}repetitions: 1\ntimeout: 10m\n`;
}

/**
 * A team whose first revision has skills fixer and helper, and whose next, pulled, adds skill newer, the files in `more`,
 * and the suite whose arms `armsOf` writes knowing the first revision.
 */
async function twoRevisions(
  armsOf: (first: string) => string, more: Record<string, string> = {}, { firstMore = {}, tools = ['claude'] }: { firstMore?: Record<string, string>; tools?: Array<'claude' | 'codex'> } = {},
): Promise<{ fixture: BenchmarkFixture; first: string; pulled: string }> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, tools,
    team: { 'skills/fixer/SKILL.md': SKILL('fixer'), 'skills/helper/SKILL.md': SKILL('helper'), ...firstMore },
  });
  fixtures.push(fixture);
  const first = git(fixture.teamClone, ['rev-parse', 'HEAD']);
  fixture.pushTeam({ 'skills/newer/SKILL.md': SKILL('newer'), 'benchmarks/fix/suite.yaml': suite(armsOf(first)), ...more });
  const pulled = await fixture.teamai(['pull']);
  expect(pulled.code, said(pulled)).toBe(0);
  return { fixture, first, pulled: git(fixture.teamClone, ['rev-parse', 'HEAD']) };
}

/** The team skills each arm's trial saw in its clone, by arm, from the launches in trial order; teamai's own skills left out. */
function skillsByArm(fixture: BenchmarkFixture, runId: string): Record<string, string[]> {
  const { trials } = RecordSchema.parse(fixture.benchmarkRecord(runId));
  const arms = [...trials].sort((left, right) => left.order - right.order).map(({ arm }) => arm);
  return Object.fromEntries(fixture.toolLaunches().map((launch, index) => [
    arms[index],
    launch.paths.flatMap((file) => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1] ?? []).filter((skill) => TEAM_SKILLS.has(skill)).sort(),
  ]));
}

async function endedRun(fixture: BenchmarkFixture): Promise<string> {
  const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
  expect(ran.code, said(ran)).toBe(0);
  const runId = z.object({ run: z.string() }).safeParse(envelope(ran).data?.done).data?.run;
  if (runId === undefined) throw new Error(`no run: ${said(ran)}`);
  return runId;
}

describe('benchmark arm team', () => {
  it('gives each arm of a team matrix its own team assets, and records the revision each trial ran on', async () => {
    const { fixture, pulled } = await twoRevisions(() => 'matrix:\n  team: [pulled, none, { without: [skills/fixer] }]\n');

    const runId = await endedRun(fixture);

    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(record.arms.map(({ name, team }) => ({ name, team }))).toEqual([
      { name: 'pulled', team: { kind: 'pulled', revision: pulled } },
      { name: 'none', team: { kind: 'none' } },
      { name: 'without-skills-fixer', team: { kind: 'without', paths: ['skills/fixer'], revision: pulled } },
    ]);
    expect(skillsByArm(fixture, runId)).toEqual({ 'pulled': ['fixer', 'helper', 'newer'], 'none': [], 'without-skills-fixer': ['helper', 'newer'] });
    expect(record.skillChanges).toEqual([{ arm: 'without-skills-fixer', defaults: 'pulled', skills: [{ name: 'fixer', change: 'removed' }] }]);
    const { steps } = RunSchema.parse(fixture.runFile(runId));
    const ranOn = (arm: string): string | undefined => steps.find((step) => step.id === `trials.r1.fix.${arm}.prompt`)?.agent?.team?.revision;
    expect([ranOn('pulled'), ranOn('none'), ranOn('without-skills-fixer')]).toEqual([pulled, undefined, pulled]);
    expect(record.trials.map(({ result }) => result)).toEqual(['passed', 'passed', 'passed']);
    const bare = record.trials.find(({ arm }) => arm === 'none')?.order ?? 0;
    expect(fixture.toolLaunches()[bare - 1]?.paths.filter((file) => file.startsWith('.claude/'))).toEqual([]);
  }, 240_000);

  it("gives an arm that names another revision of the team repo that revision's assets", async () => {
    const { fixture, first, pulled } = await twoRevisions((before) => `arms:\n  - name: now\n  - name: before\n    team: ${before}\n`);

    const runId = await endedRun(fixture);

    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(record.arms.map(({ team }) => team)).toEqual([
      { kind: 'pulled', revision: pulled },
      { kind: 'ref', ref: first, revision: first },
    ]);
    expect(record.skillChanges).toEqual([{ arm: 'before', defaults: 'now', skills: [{ name: 'newer', change: 'removed' }] }]);
    expect(skillsByArm(fixture, runId)).toEqual({ now: ['fixer', 'helper', 'newer'], before: ['fixer', 'helper'] });
  }, 240_000);

  it("runs an arm on a team branch with the tool, models and scorers frozen at the pulled revision, whatever the branch's own say", async () => {
    const aliases = (version: string): string => `aliases:\n  strong:\n    claude: claude-${version}\n    codex: gpt-${version}\n`;
    const quality = (rubric: string): string => `---\nlabels:\n  - { value: tidy, score: 1, description: Small and clear }\n  - { value: messy, score: 0, description: Not }\npassingScore: 1\nsamplingRate: 0\n---\n${rubric}\n`;
    const { fixture, first } = await twoRevisions(
      () => '  model: strong\narms:\n  - name: now\n  - name: codex\n    tool: codex\n  - name: before\n    team: bench/before\nscorers: [quality]\n',
      { 'models/aliases.yaml': aliases('new'), 'scorers/quality.md': quality('Judge how tidy the change is.') },
      { firstMore: { 'models/aliases.yaml': aliases('old'), 'scorers/quality.md': quality('Judge anything.') }, tools: ['claude', 'codex'] },
    );
    git(fixture.teamClone, ['push', '-q', fixture.teamOrigin, `${first}:refs/heads/bench/before`]);
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);

    const runId = await endedRun(fixture);

    const record = z.object({ scorers: z.array(z.object({ name: z.string(), rubric: z.object({ sourceHash: z.string() }) })) }).passthrough().parse(fixture.benchmarkRecord(runId));
    const pulledRubric = createHash('sha256').update(quality('Judge how tidy the change is.')).digest('hex');
    expect(record.scorers).toEqual([{ name: 'quality', rubric: { sourceHash: pulledRubric } }]);
    const { steps } = z.object({
      steps: z.array(z.object({ id: z.string(), agent: z.object({ tool: z.object({ name: z.string() }), model: z.object({ requested: z.string() }).partial().optional(), team: z.object({ revision: z.string() }).passthrough().optional() }).passthrough().optional() }).passthrough()),
    }).parse(fixture.runFile(runId));
    const ranAs = (arm: string): unknown => {
      const agent = steps.find((step) => step.id === `trials.r1.fix.${arm}.prompt`)?.agent;
      return { tool: agent?.tool.name, model: agent?.model?.requested, team: agent?.team?.revision === first ? 'first' : 'pulled' };
    };
    expect(['now', 'codex', 'before'].map(ranAs)).toEqual([
      { tool: 'claude', model: 'claude-new', team: 'pulled' },
      { tool: 'codex', model: 'gpt-new', team: 'pulled' },
      { tool: 'claude', model: 'claude-new', team: 'first' },
    ]);
  }, 240_000);

  it('runs an arm without a whole namespace directory the member receives, and its clone gets none of its skills', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'],
      suite: suite('arms:\n  - name: now\n  - name: no-dev\n    team: { without: [skills/dev] }\n'),
      team: { 'skills/fixer/SKILL.md': SKILL('fixer'), 'skills/dev/deploy/SKILL.md': SKILL('deploy'), 'skills/dev/ship/SKILL.md': SKILL('ship') },
    });
    fixtures.push(fixture);

    const runId = await endedRun(fixture);

    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(record.skillChanges).toEqual([{ arm: 'no-dev', defaults: 'now', skills: [{ name: 'deploy', change: 'removed' }, { name: 'ship', change: 'removed' }] }]);
    const orders = Object.fromEntries(record.trials.map(({ arm, order }) => [arm, order]));
    const skills = (arm: string): string[] => (fixture.toolLaunches()[(orders[arm] ?? 0) - 1]?.paths ?? [])
      .flatMap((file) => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1] ?? []).filter((skill) => !skill.startsWith('teamai')).sort();
    expect({ now: skills('now'), noDev: skills('no-dev') }).toEqual({ now: ['deploy', 'fixer', 'ship'], noDev: ['fixer'] });
  }, 240_000);

  // With no role or project, the member receives every namespace beside the shared root.
  it('runs an arm without a rule, an agent, a namespaced skill and a file of a shared skill, and its clone gets every other team asset', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'],
      suite: suite('arms:\n  - name: now\n  - name: ablated\n    team: { without: [skills/dev/deploy, rules/commits.md, agents/reviewer.md, skills/fixer/notes.md] }\n'),
      team: {
        'skills/fixer/SKILL.md': SKILL('fixer'), 'skills/fixer/notes.md': 'Fixer notes.\n', 'skills/dev/deploy/SKILL.md': SKILL('deploy'),
        'rules/commits.md': '---\ndescription: How we commit.\n---\nWrite small commits.\n',
        'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews a change.\n---\nReview the change.\n',
        'claudemd/team.md': 'Answer in English.\n',
      },
    });
    fixtures.push(fixture);
    const pulled = git(fixture.teamClone, ['rev-parse', 'HEAD']);

    const runId = await endedRun(fixture);

    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(record.arms.map(({ team }) => team)).toEqual([
      { kind: 'pulled', revision: pulled },
      { kind: 'without', paths: ['agents/reviewer.md', 'rules/commits.md', 'skills/dev/deploy', 'skills/fixer/notes.md'], revision: pulled },
    ]);
    expect(record.skillChanges).toEqual([{ arm: 'ablated', defaults: 'now', skills: [{ name: 'deploy', change: 'removed' }, { name: 'fixer', change: 'changed' }] }]);
    const orders = Object.fromEntries(record.trials.map(({ arm, order }) => [arm, order]));
    const [now, ablated] = ['now', 'ablated'].map((arm) => fixture.toolLaunches()[(orders[arm] ?? 0) - 1]);
    const delivered = (launch: typeof now): string[] => (launch?.paths ?? []).filter((file) => file.startsWith('.claude/') && !file.startsWith('.claude/skills/teamai')).sort();
    expect(delivered(now).filter((file) => !delivered(ablated).includes(file))).toEqual(['.claude/agents/reviewer.md', '.claude/rules/commits.md', '.claude/skills/deploy/SKILL.md', '.claude/skills/fixer/notes.md']);
    expect(delivered(ablated).filter((file) => !delivered(now).includes(file))).toEqual([]);
    expect(delivered(ablated)).toContain('.claude/skills/fixer/SKILL.md');
    expect(ablated?.teamContext).toContain('Answer in English.');
    const { steps } = RunSchema.parse(fixture.runFile(runId));
    expect(steps.find((step) => step.id === 'trials.r1.fix.ablated.prompt')?.agent?.team?.revision).toBe(pulled);
  }, 240_000);

  it.each([
    ['a ref the team repo does not have', () => 'arms:\n  - name: now\n  - name: gone\n    team: no-such-branch\n', 'arm_team_unresolved',
      'Arm "gone" runs on team ref "no-such-branch", which is no branch, tag or commit of this checkout\'s team repo that holds teamai.yaml. Its branches: main. Fetch it, or fix the arm\'s team, push it, run teamai pull, and start again.'],
    ['a path the pulled revision does not have', () => 'arms:\n  - name: now\n  - name: ablated\n    team: { without: [skills/nope] }\n', 'arm_team_unresolved',
      'Arm "ablated" runs without skills/nope, which team revision {pulled} does not have. Fix the arm\'s team, push it, run teamai pull, and start again.'],
  ])('refuses to start an arm whose team names %s, with the team remote out of reach, and leaves no run', async (_case, armsOf, code, message) => {
    const { fixture, pulled } = await twoRevisions(armsOf);
    // With no team remote to reach, the refusal cannot come from a fetch.
    fs.renameSync(fixture.teamOrigin, `${fixture.teamOrigin}.away`);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    fs.renameSync(`${fixture.teamOrigin}.away`, fixture.teamOrigin);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: { code, message: message.replace('{pulled}', pulled.slice(0, 7)) } });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it('refuses to start an arm without a delivered skill the member then excludes, which its clones would not get anyway, and leaves no run', async () => {
    // Pull has delivered skill helper before the member excludes it.
    const { fixture } = await twoRevisions(() => 'arms:\n  - name: now\n  - name: ablated\n    team: { without: [skills/helper] }\n');
    expect(fs.existsSync(path.join(fixture.work, '.claude', 'skills', 'helper', 'SKILL.md'))).toBe(true);
    for (const args of [['skill', 'exclude', 'add', 'helper'], ['pull']]) {
      const ran = await fixture.teamai(args);
      expect(ran.code, said(ran)).toBe(0);
    }

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: {
      code: 'arm_team_unresolved',
      message: 'Arm "ablated" runs without skills/helper, skill helper, which the member excludes, so pull leaves it out already and leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.',
    } });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it('refuses to start a benchmark in single-repo mode, where the project commit decides the team assets, and leaves no run', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], selfMode: true,
      suite: suite('arms:\n  - name: now\n  - name: ablated\n    team: { without: [skills/fixer] }\n'),
      team: { 'skills/fixer/SKILL.md': SKILL('fixer') },
    });
    fixtures.push(fixture);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({
      error: { code: 'team_ref_blocked', message: "Benchmarks do not run in single-repo mode: the project's own commit decides which team assets a checkout has, so no arm can run on a team revision of its own. Start the benchmark from a checkout whose team has a team repo of its own." },
    });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);

  it('refuses to start an arm without team assets on a machine whose user-scope install delivers to its tool', async () => {
    const { fixture } = await twoRevisions(() => 'arms:\n  - name: now\n  - name: bare\n    team: none\n');
    const projects = path.join(fixture.home, '.teamai', 'projects');
    const workspace = fs.readdirSync(projects).map((name) => path.join(projects, name, 'config.yaml')).find((file) => fs.existsSync(file));
    if (workspace === undefined) throw new Error('no workspace config');
    // Another team's user-scope install: one of this team would refuse every arm first, as the team could not be pinned.
    fs.writeFileSync(path.join(fixture.home, '.teamai', 'config.yaml'), fs.readFileSync(workspace, 'utf8').replace(/^scope: .*$/m, 'scope: user').replace(/^(projectRoot|dataHome): .*\n/gm, '')
      .replace(/^(\s+remote: ).*$/m, '$1https://example.com/acme/other-team.git'));

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ErrorSchema.parse(envelope(started))).toEqual({ error: {
      code: 'arm_team_unclean',
      message: 'Arm "bare" runs without team assets, and this machine\'s user-scope teamai install delivers team assets to claude in your home, where its trials would read them. Start the benchmark on a machine where teamai is installed only in workspace scope.',
    } });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);
});
