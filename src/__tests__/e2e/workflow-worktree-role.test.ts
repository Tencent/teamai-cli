/**
 * Real CLI: a prompt step with `workspace: new` and `role: review` runs in a worktree copy that gets the review role's
 * knowledge and the member's channels, through the copy's own pull. A pull in the copy keeps the role, the step's branch
 * holds only its edit, the member's checkout, config and recall are as they were, and the run records the role.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, TEAM_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const ROLES = `version: 1
roles:
  - id: frontend
    resources: { knowledge: [frontend], skills: [frontend], hooks: [frontend], docs: [fe-docs] }
  - id: review
    resources: { knowledge: [review], skills: [review], hooks: [rv-hook], docs: [rv-docs] }
`;
const MEMBERS = 'version: 1\nmembers:\n  member: [frontend]\ndefault: []\n';
const TEAM = {
  'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: git\nsharing:\n  docs: { localDir: team-docs }\n  gitExclude: { enabled: false }\n`,
  'manifest/roles.yaml': ROLES,
  'skills/frontend/fe-only/SKILL.md': '---\nname: fe-only\ndescription: Frontend only.\n---\nBuild the UI.\n',
  'skills/review/rv-only/SKILL.md': '---\nname: rv-only\ndescription: Review only.\n---\nReview the change.\n',
  'hooks/frontend/hooks.yaml': 'hooks:\n  - id: fe-guard\n    event: Stop\n    command: echo fe-guard\n    description: Frontend guard\n',
  'hooks/rv-hook/hooks.yaml': 'hooks:\n  - id: rv-guard\n    event: Stop\n    command: echo rv-guard\n    description: Review guard\n',
  'rules/frontend/frontend.md': 'FRONTEND-RULE-SENTINEL: use the design system.\n',
  'rules/review/review.md': 'REVIEW-RULE-SENTINEL: read every changed line.\n',
  'docs/fe-docs/components.md': '# Components\n\nThe design system.\n',
  'docs/rv-docs/checklist.md': '# Review checklist\n\nRead every changed line.\n',
  'workflows/review.yaml': `schemaVersion: v1alpha1
name: review
description: Review the answer in a copy of its own, as a reviewer.
steps:
  - id: review
    role: review
    workspace: new
    tool: claude
    model: { name: claude-review-1 }
    prompt: Review the answer.
`,
};

const EXTERNAL = { kind: 'external', machine: 'ci', workspace: '/ci' };
const CAN = { workspace: ['read-only', 'new', 'continue'], tools: ['claude'], role: true };
const LeaseSchema = z.object({
  step: z.string(), attempt: z.string(), revision: z.number(), cwd: z.string(), role: z.string().optional(), prompt: z.string().optional(),
  workspace: z.object({ branch: z.string() }).passthrough(),
}).passthrough();
const LeasedSchema = z.object({ data: z.object({ lease: LeaseSchema }) });
const RecordSchema = z.object({ selection: z.record(z.string(), z.unknown()).optional() }).passthrough();
const StateSchema = z.object({ lastPullByWorkspace: z.record(z.string(), RecordSchema).optional() }).passthrough();
const RunSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string(), agent: z.unknown().optional(), used: z.unknown().optional() }).passthrough()) });
type Lease = z.infer<typeof LeaseSchema>;

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** The member's own data home: the partition whose config names their checkout. */
function memberDataHome(fixture: BenchmarkFixture): string {
  const projects = path.join(fixture.home, '.teamai', 'projects');
  const found = fs.readdirSync(projects).map((name) => path.join(projects, name)).find((dir) => fs.existsSync(path.join(dir, 'config.yaml')) && fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8').includes(`projectRoot: ${fixture.work}`));
  if (!found) throw new Error(`no data home for ${fixture.work}`);
  return found;
}

function checkoutRecords(dataHome: string): Record<string, z.infer<typeof RecordSchema>> {
  return StateSchema.parse(JSON.parse(fs.readFileSync(path.join(dataHome, 'state.json'), 'utf8'))).lastPullByWorkspace ?? {};
}

/** Every file under `dir`, relative to it, outside `.git`. */
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !path.relative(dir, entry.parentPath).split(path.sep).includes('.git'))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
}

/** Claude's local settings in `dir`, where teamai puts a project's team hooks, or '' without them. */
function claudeHooks(dir: string): string {
  const file = path.join(dir, '.claude', 'settings.local.json');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/**
 * What a step in the copy gets of each piece of knowledge and hook the two roles differ on: the files in the copy, and
 * the team hooks of the copy and of the main checkout, whose Claude settings every worktree of the project shares.
 */
function harness(paths: readonly string[], hooks: string): Record<string, boolean> {
  return {
    'rv-only': paths.includes('.claude/skills/rv-only/SKILL.md'),
    'rv-docs': paths.includes('team-docs/rv-docs/checklist.md'),
    'fe-guard': hooks.includes('echo fe-guard'),
    'fe-only': paths.some((file) => file.includes('fe-only')),
    'fe-docs': paths.some((file) => file.includes('fe-docs')),
    'rv-hook': hooks.includes('echo rv-guard'),
  };
}

const REVIEW_HARNESS = { 'rv-only': true, 'rv-docs': true, 'fe-guard': true, 'fe-only': false, 'fe-docs': false, 'rv-hook': false };

/** The team files the member's recall returns, in their checkout, for a query both roles' docs match. */
function recalled(fixture: BenchmarkFixture): string[] {
  const answer = spawnSync(path.join(fixture.bin, 'teamai'), ['recall', 'design system review checklist', '--depth', 'lookup'], { cwd: fixture.work, env: fixture.env, encoding: 'utf8' });
  if (answer.status !== 0) throw new Error(`recall failed: ${answer.stdout}${answer.stderr}`);
  return [...answer.stdout.matchAll(/^File: .*\/team-repo\/(.+)$/gm)].map(([, file]) => file ?? '');
}

async function next(fixture: BenchmarkFixture, run: string): Promise<Lease> {
  const answer = envelope(await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ driver: { ...EXTERNAL, can: CAN }, running: [] })]));
  const leased = LeasedSchema.safeParse(answer);
  if (!leased.success) throw new Error(`no lease: ${JSON.stringify(answer)}`);
  return leased.data.data.lease;
}

async function reviewTeam(options: { members: boolean }): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: false, tools: ['claude'], loadsSkill: 'rv-only',
    team: { ...TEAM, ...(options.members ? { 'manifest/members.yaml': MEMBERS } : {}) },
    ...(options.members ? {} : { role: 'frontend' }),
  });
  fixtures.push(fixture);
  return fixture;
}

describe('a prompt step with workspace: new and role: review', () => {
  it('delivers the review role\'s knowledge with the member\'s hooks into its copy, and leaves the member as it was', async () => {
    const fixture = await reviewTeam({ members: true });
    const memberHome = memberDataHome(fixture);
    const memberConfig = fs.readFileSync(path.join(memberHome, 'config.yaml'), 'utf8');
    const memberRecords = checkoutRecords(memberHome);
    const memberRecall = recalled(fixture);
    const memberStatus = fixture.status();
    const memberFiles = filesUnder(fixture.work);
    const run = z.string().parse(envelope(await fixture.teamai(['workflow', 'start', 'review'])).data?.run);

    const lease = await next(fixture, run);
    const prepared = filesUnder(lease.cwd);
    const hooks = (): string => `${claudeHooks(lease.cwd)}${claudeHooks(fixture.work)}`;
    const preparedHooks = hooks();
    const pulled = spawnSync(path.join(fixture.bin, 'teamai'), ['pull'], { cwd: lease.cwd, env: fixture.env, encoding: 'utf8' });
    const afterPull = filesUnder(lease.cwd);
    const afterPullHooks = hooks();
    const copyRecords = Object.entries(checkoutRecords(memberHome)).filter(([key]) => !(key in memberRecords)).map(([, record]) => record.selection);
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');
    const reported = await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({
      driver: EXTERNAL, attempt: lease.attempt, revision: lease.revision, tool: 'claude', outcome: 'success',
      // A driver's word on the role is not what the run records.
      agent: { team: { revision: git(fixture.teamClone, ['rev-parse', 'HEAD']), localChanges: false, selection: { scope: 'project', additionalRoles: [], stepRole: 'frontend' } } },
    })]);
    const committed = git(fixture.work, ['show', '--name-only', '--format=', lease.workspace.branch]);

    // 1. The review role's knowledge, the member's hooks.
    expect(lease).toMatchObject({ step: 'review', role: 'review' });
    expect(harness(prepared, preparedHooks)).toEqual(REVIEW_HARNESS);
    // 2. A pull in the copy keeps them, and records the role for the copy.
    expect(pulled.status, `${pulled.stdout}${pulled.stderr}`).toBe(0);
    expect(harness(afterPull, afterPullHooks)).toEqual(REVIEW_HARNESS);
    expect(copyRecords).toEqual([expect.objectContaining({ primaryRole: 'frontend', stepRole: 'review' })]);
    // 3. The step's branch holds its edit, and nothing that was delivered.
    expect(envelope(reported).data?.accepted, said(reported)).toBe(true);
    expect(committed).toBe('answer.js');
    // 4. The member's config, checkout record and recall are as they were: recall serves the member's docs, not the role's.
    expect(fs.readFileSync(path.join(memberHome, 'config.yaml'), 'utf8')).toBe(memberConfig);
    expect(Object.fromEntries(Object.entries(checkoutRecords(memberHome)).filter(([key]) => key in memberRecords))).toEqual(memberRecords);
    expect(memberRecall).toEqual(['docs/fe-docs/components.md']);
    expect(recalled(fixture)).toEqual(memberRecall);
    expect(fixture.status()).toBe(memberStatus);
    expect(filesUnder(fixture.work).filter((file) => !file.startsWith('.teamai/'))).toEqual(memberFiles.filter((file) => !file.startsWith('.teamai/')));
    // The run records the role of the copy teamai prepared, not the one the driver reported.
    const step = RunSchema.parse(fixture.runFile(run)).steps.find((one) => one.id === 'review');
    expect(step).toMatchObject({ status: 'succeeded', agent: { team: { selection: { primaryRole: 'frontend', stepRole: 'review' } } } });
  }, 240_000);

  it.each([
    { members: true, how: 'manifest/members.yaml' },
    { members: false, how: 'teamai init --role' },
  ])('runs on the local driver with the role\'s harness, the member\'s role from $how, and records it', async ({ members }) => {
    const fixture = await reviewTeam({ members });

    const ran = await fixture.teamai(['workflow', 'start', 'review', '--driver', 'local']);

    expect(ran.code, said(ran)).toBe(0);
    expect(envelope(ran).data?.done).toMatchObject({ outcome: 'succeeded' });
    const [launch] = fixture.toolLaunches();
    expect(launch).toMatchObject({ tool: 'claude', model: 'claude-review-1' });
    expect(harness(launch?.paths ?? [], `${launch?.claudeSettings ?? ''}${claudeHooks(fixture.work)}`)).toEqual(REVIEW_HARNESS);
    // 5. The record names the role, beside the member's, with a fingerprint and the role's skill the session loaded.
    const run = z.string().parse(z.object({ run: z.string() }).passthrough().parse(envelope(ran).data?.done).run);
    const step = RunSchema.parse(fixture.runFile(run)).steps.find((one) => one.id === 'review');
    expect(step).toMatchObject({
      status: 'succeeded',
      agent: { team: { selection: { primaryRole: 'frontend', stepRole: 'review' } }, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
      used: { skills: expect.arrayContaining(['rv-only']) },
    });
  }, 240_000);
});
