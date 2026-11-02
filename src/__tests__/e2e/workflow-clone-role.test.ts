/**
 * Real CLI, driven by hand as an external driver would: a clone step with `role: review` gets the review role's
 * knowledge and the member's channels, delivered by the clone's own install, and the run records the role. Every pull
 * and hook run in the clone keeps the role; nothing of it reaches the member's checkout or config.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, TEAM_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const ROLES = `version: 1
roles:
  - id: frontend
    resources: { knowledge: [frontend], skills: [frontend], hooks: [frontend] }
  - id: review
    resources: { knowledge: [review], skills: [review], hooks: [rv-hook] }
`;
const TEAM = {
  'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: git\nsharing:\n  docs: { localDir: team-docs }\n  gitExclude: { enabled: false }\n`,
  'manifest/roles.yaml': ROLES,
  'manifest/members.yaml': 'version: 1\nmembers:\n  member: [frontend]\ndefault: []\n',
  'skills/frontend/fe-only/SKILL.md': '---\nname: fe-only\ndescription: Frontend only.\n---\nBuild the UI.\n',
  'skills/review/rv-only/SKILL.md': '---\nname: rv-only\ndescription: Review only.\n---\nReview the change.\n',
  'hooks/frontend/hooks.yaml': 'hooks:\n  - id: fe-guard\n    event: Stop\n    command: echo fe-guard\n    description: Frontend guard\n',
  'hooks/rv-hook/hooks.yaml': 'hooks:\n  - id: rv-guard\n    event: Stop\n    command: echo rv-guard\n    description: Review guard\n',
  'rules/frontend/frontend.md': 'FRONTEND-RULE-SENTINEL: use the design system.\n',
  'rules/review/review.md': 'REVIEW-RULE-SENTINEL: read every changed line.\n',
  'docs/guide.md': '# Guide\n\nHow the team works.\n',
};

const EXTERNAL = { kind: 'external', machine: 'ci', workspace: '/ci' };
const CAN = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, tools: ['claude'], unattended: true, role: true };
const LeaseSchema = z.object({
  step: z.string(), attempt: z.string(), revision: z.number(), cwd: z.string(), role: z.string().optional(),
  prompt: z.string().optional(), command: z.string().optional(), envScope: z.object({ withhold: z.array(z.string()) }).passthrough().optional(),
}).passthrough();
const LeasedSchema = z.object({ data: z.object({ lease: LeaseSchema }) });
const SelectionSchema = z.object({ selection: z.record(z.string(), z.unknown()).optional() }).passthrough();
const StateSchema = z.object({ lastPullByWorkspace: z.record(z.string(), SelectionSchema).optional() }).passthrough();
const RunSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string(), agent: z.unknown().optional() }).passthrough()) });
type Lease = z.infer<typeof LeaseSchema>;

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** The workflow that reviews the answer in a clone of `commit` with the team at `revision`, run as the review role. */
function reviewWorkflow(commit: string, revision: string): string {
  return `schemaVersion: v1alpha1
name: review
description: Review the answer in a clean clone, as a reviewer.
steps:
  - id: review
    role: review
    workspace:
      clone:
        commit: ${commit}
        team: { revision: ${revision}, selection: { additionalRoles: [], projects: [], excludedSkills: [], enabledAgents: [claude, codex] }, treatment: pulled }
    workflow:
      steps:
        - id: look
          workspace: continue
          tool: claude
          prompt: Review the answer.
        - id: check
          needs: [look]
          workspace: continue
          command: node -e "process.exit(0)"
`;
}

/** The member's own data home: the partition whose config names their checkout. */
function memberDataHome(fixture: BenchmarkFixture): string {
  const projects = path.join(fixture.home, '.teamai', 'projects');
  const found = fs.readdirSync(projects).map((name) => path.join(projects, name)).find((dir) => fs.existsSync(path.join(dir, 'config.yaml')) && fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8').includes(`projectRoot: ${fixture.work}`));
  if (!found) throw new Error(`no data home for ${fixture.work}`);
  return found;
}

/** The selection each checkout record of the clone's own install was delivered for. */
function cloneSelections(lease: Lease): unknown[] {
  const projects = path.join(path.dirname(lease.cwd), 'h', '.teamai', 'projects');
  return fs.readdirSync(projects).flatMap((name) => {
    const file = path.join(projects, name, 'state.json');
    if (!fs.existsSync(file)) return [];
    const state = StateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return Object.values(state.lastPullByWorkspace ?? {}).map((record) => record.selection);
  });
}

/** Every file under `dir`, relative to it, outside `.git`. */
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !path.relative(dir, entry.parentPath).split(path.sep).includes('.git'))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
}

/** What the clone's agent files say, all of them, for a search. */
function agentText(dir: string): string {
  return filesUnder(dir).filter((file) => file.startsWith('.claude/') || file.startsWith('.codex/') || file === 'AGENTS.md' || file === 'CLAUDE.md')
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
}

async function next(fixture: BenchmarkFixture, run: string): Promise<Lease> {
  const answer = envelope(await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ driver: { ...EXTERNAL, can: CAN }, running: [] })]));
  const leased = LeasedSchema.safeParse(answer);
  if (!leased.success) throw new Error(`no lease: ${JSON.stringify(answer)}`);
  return leased.data.data.lease;
}

async function report(fixture: BenchmarkFixture, run: string, body: Record<string, unknown>): Promise<void> {
  const reported = await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({ driver: EXTERNAL, ...body })]);
  if (envelope(reported).data?.accepted !== true) throw new Error(`report refused: ${said(reported)}`);
}

/** The member's environment for a process in the lease's clone, as a driver gives it: the attempt marker, nothing withheld. */
function inClone(fixture: BenchmarkFixture, run: string, lease: Lease): NodeJS.ProcessEnv {
  const withheld = lease.envScope?.withhold ?? [];
  return { ...Object.fromEntries(Object.entries(fixture.env).filter(([key]) => !withheld.includes(key))), TEAMAI_WORKFLOW_ATTEMPT: `${run}/${lease.attempt}` };
}

describe('a clone step with role: review', () => {
  it('delivers the review role\'s knowledge with the member\'s hooks, records the role, and leaves the member as it was', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude', 'codex'], team: TEAM });
    fixtures.push(fixture);
    const revision = git(fixture.teamClone, ['rev-parse', 'HEAD']);
    fixture.pushTeam({ 'workflows/review.yaml': reviewWorkflow(fixture.startingCommit, revision) });
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);
    const memberHome = memberDataHome(fixture);
    const memberConfig = fs.readFileSync(path.join(memberHome, 'config.yaml'), 'utf8');
    const memberState = fs.readFileSync(path.join(memberHome, 'state.json'), 'utf8');
    const started = envelope(await fixture.teamai(['workflow', 'start', 'review', '--timeout', '10m']));
    const run = z.string().parse(started.data?.run);

    const look = await next(fixture, run);
    const delivered = filesUnder(look.cwd);
    const agents = agentText(look.cwd);
    const nested = path.join(look.cwd, 'src');
    fs.mkdirSync(nested);
    const env = inClone(fixture, run, look);
    const hook = spawnSync(path.join(fixture.bin, 'teamai'), ['hook-dispatch', 'session-start', '--tool', 'codex'], {
      cwd: nested, env, encoding: 'utf8', input: JSON.stringify({ cwd: nested, session_id: 'in-clone', hook_event_name: 'SessionStart', source: 'startup' }),
    });
    // The hook's pull runs detached and holds the sync lock until it is done; the member's pull comes after it.
    await waitForDetachedChildren();
    const pulledInClone = spawnSync(path.join(fixture.bin, 'teamai'), ['pull'], { cwd: nested, env, encoding: 'utf8' });
    const pulledAgain = spawnSync(path.join(fixture.bin, 'teamai'), ['pull', '--force'], { cwd: nested, env, encoding: 'utf8' });
    const afterPulls = filesUnder(look.cwd);
    fs.rmdirSync(nested);
    await promisify(execFile)(path.join(fixture.bin, 'claude'), ['-p', look.prompt ?? ''], { cwd: look.cwd, env });
    await report(fixture, run, { attempt: look.attempt, revision: look.revision, tool: 'claude', outcome: 'success' });
    const check = await next(fixture, run);
    const committed = git(check.cwd, ['show', '--name-only', '--format=', 'HEAD']);
    await report(fixture, run, { attempt: check.attempt, revision: check.revision, outcome: 'success', exitCode: 0 });

    // 1. The review role's knowledge, the member's channels.
    expect(look).toMatchObject({ step: 'review.look', role: 'review' });
    expect(delivered).toContain('.claude/skills/rv-only/SKILL.md');
    expect(delivered.filter((file) => file.includes('fe-only'))).toEqual([]);
    expect(agents).toContain('echo fe-guard');
    expect(agents).not.toContain('echo rv-guard');
    // 5. A Codex session hook and a pull run inside the clone, under the member's HOME, resolve the clone's install.
    expect(hook.status, hook.stderr).toBe(0);
    expect(hook.stdout).toContain('REVIEW-RULE-SENTINEL');
    expect(hook.stdout).not.toContain('FRONTEND-RULE-SENTINEL');
    expect(pulledInClone.status, `${pulledInClone.stdout}${pulledInClone.stderr}`).toBe(0);
    // 6. A second, full pull keeps the role.
    expect(pulledAgain.status, `${pulledAgain.stdout}${pulledAgain.stderr}`).toBe(0);
    expect(afterPulls).toContain('.claude/skills/rv-only/SKILL.md');
    expect(afterPulls.filter((file) => file.includes('fe-only'))).toEqual([]);
    expect(cloneSelections(look)).toEqual([expect.objectContaining({ primaryRole: 'frontend', stepRole: 'review' })]);
    // 3. The step's commit holds its edit alone, docs and agent files delivered into the clone left out.
    expect(delivered).toContain('team-docs/guide.md');
    expect(committed).toBe('answer.js');
    // 2. The run records the role the step ran with, beside the member's.
    const steps = RunSchema.parse(fixture.runFile(run)).steps;
    expect(steps.find((step) => step.id === 'review.look')).toMatchObject({ status: 'succeeded', agent: { team: { selection: { primaryRole: 'frontend', stepRole: 'review' } } } });
    // 4. The member's config and checkout record are as they were.
    expect(fs.readFileSync(path.join(memberHome, 'config.yaml'), 'utf8')).toBe(memberConfig);
    expect(fs.readFileSync(path.join(memberHome, 'state.json'), 'utf8')).toBe(memberState);
  }, 240_000);
});
