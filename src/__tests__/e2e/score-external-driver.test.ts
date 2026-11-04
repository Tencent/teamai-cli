/**
 * Real CLI against a local bare team repo: an external JSON driver runs a scored workflow to its end with workflow next
 * and report, reads the teamai-score run its settled pass started from those answers, and drives that run too, answering
 * its judge step for a fake judge. The member then asks for the pass again with score --run --driver none, and the
 * driver runs that teamai-score run. The review's report names the team skills it used, and the label carries those
 * that are shaped like a skill name.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const OTHER_URL = 'https://github.com/acme/other.git';
const PHRASE = 'Only-the-judge-wrote-this-quokka';

const EnvelopeSchema = z.object({ data: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });

function runCLI(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

function envelope(stdout: string): z.infer<typeof EnvelopeSchema> {
  const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' }).toString();
}

/** Every file under `dir` whose text contains `phrase`. */
function filesContaining(dir: string, phrase: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((file) => path.join(dir, file))
    .filter((file) => fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes(phrase));
}

const SCORER = `---
labels:
  - { value: thorough, score: 1, description: Reads the diff and names real defects }
  - { value: shallow, score: 0, description: Misses real defects }
passingScore: 0.5
samplingRate: 100
---
Judge the review against the diff.
`;

const WORKFLOW = `schemaVersion: v1alpha1
name: review
description: A reviewed change.
steps:
  - id: plan
    command: node -e "process.exit(0)"
  - id: review
    needs: [plan]
    prompt: Review the change.
    scorers: [review-quality]
`;

/**
 * A team repository `team` holding WORKFLOW and the scorer, and a member's checkout `app` joined to it in `scope`, under `root`.
 */
async function joinedApp(root: string, scope: 'user' | 'project'): Promise<{ team: string; app: string; home: string; env: NodeJS.ProcessEnv }> {
  const knowledge = path.join(root, 'knowledge');
  const team = path.join(root, 'team.git');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`);
  fs.writeFileSync(path.join(knowledge, 'workflows', 'review.yaml'), WORKFLOW);
  fs.writeFileSync(path.join(knowledge, 'scorers', 'review-quality.md'), SCORER);
  git(root, 'init', '-q', '-b', 'main', knowledge);
  git(knowledge, 'add', '-A');
  git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team');
  git(root, 'clone', '-q', '--bare', knowledge, team);
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  git(app, 'init', '-q', '-b', 'main');

  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = tester\n\temail = tester@example.com\n[url "file://${team}"]\n\tinsteadOf = ${TEAM_URL}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', scope, '--force'], ['pull']]) {
    const result = await runCLI(command, app, env);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  }
  return { team, app, home, env };
}

/** A team repository `other` under `root`, with no workflow, that a checkout joins at OTHER_URL once `home`'s git config points there. */
function otherTeam(root: string, home: string): void {
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'teamai.yaml'), `team: other\nrepo: ${OTHER_URL}\nprovider: github\n`);
  git(root, 'init', '-q', '-b', 'main', other);
  git(other, 'add', '-A');
  git(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'other');
  git(root, 'clone', '-q', '--bare', other, `${other}.git`);
  fs.appendFileSync(path.join(home, '.gitconfig'), `[url "file://${other}.git"]\n\tinsteadOf = ${OTHER_URL}\n`);
}

const StartedSchema = z.array(z.object({ run: z.string(), step: z.string(), pass: z.number(), scorers: z.array(z.string()) }));

/**
 * Starts WORKFLOW in `app` and drives it to its end as `driver`, from `app`. The run id, and the teamai-score runs its
 * answers say its settled passes started.
 */
async function drivenToDone(input: { app: string; home: string; env: NodeJS.ProcessEnv; driver: { kind: string; machine: string; workspace: string } }): Promise<{ runId: string; started: z.infer<typeof StartedSchema> }> {
  const { app, home, env, driver } = input;
  const runId = String(envelope((await runCLI(['workflow', 'start', 'review'], app, env)).stdout).data?.run);
  const started = new Map<string, z.infer<typeof StartedSchema>[number]>();
  const keep = (data: Record<string, unknown> | undefined): void => {
    for (const run of StartedSchema.optional().parse(data?.started) ?? []) started.set(run.run, run);
  };
  let done: unknown;
  for (let turn = 0; turn < 10 && done === undefined; turn += 1) {
    const next = envelope((await runCLI(['workflow', 'next', runId, '--json', JSON.stringify({ driver })], app, env)).stdout);
    expect(next.data, JSON.stringify(next)).toBeDefined();
    keep(next.data);
    done = next.data?.done;
    const lease = z.object({ attempt: z.string(), revision: z.number(), step: z.string() }).optional().parse(next.data?.lease);
    if (!lease) continue;
    const used = lease.step === 'review'
      ? { used: { skills: ['review-notes', path.join(home, '.claude', 'skills', 'deploy-notes', 'SKILL.md')] }, tool: 'claude', model: 'claude-review-1', agent: { effort: { requested: 'high' } } }
      : {};
    const reported = envelope((await runCLI(['workflow', 'report', runId, '--json', JSON.stringify({ attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, outputs: { reviewed: true }, ...used })], app, env)).stdout);
    expect(reported.data, JSON.stringify(reported)).toMatchObject({ accepted: true });
    keep(reported.data);
  }
  expect(done).toMatchObject({ outcome: 'succeeded' });
  return { runId, started: [...started.values()] };
}

/**
 * Drives teamai-score run `runId` to its end as `driver`, from `cwd`: each command lease runs in the place its prepare
 * made, with `env` and the lease's own `env` only, a `teamai` on PATH, and the judge step is answered with `answer` as a confined run of Claude would.
 * The run's done, and the scores directory its evidence step wrote under.
 */
async function drivenScore(input: { cwd: string; env: NodeJS.ProcessEnv; driver: { kind: string; machine: string; workspace: string }; runId: string; answer: { label: string; reasoning: string } }): Promise<{ done: unknown; scores: string }> {
  const { cwd, env, runId, answer } = input;
  const driver = { ...input.driver, can: { confined: [{ level: 'verified', access: 'read', tools: ['claude'] }], workspace: ['team'] } };
  const bin = fs.mkdtempSync(path.join(path.dirname(cwd), 'bin-'));
  fs.writeFileSync(path.join(bin, 'teamai'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  const shell = { ...env, PATH: [bin, env.PATH ?? ''].join(path.delimiter) };
  const LeaseSchema = z.object({ attempt: z.string(), revision: z.number(), step: z.string(), command: z.string().optional(), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(), confined: z.object({ dir: z.string() }).optional() });
  let done: unknown;
  let scores = '';
  let last = '';
  for (let turn = 0; turn < 20 && done === undefined; turn += 1) {
    const next = envelope((await runCLI(['workflow', 'next', runId, '--prepare', '--json', JSON.stringify({ driver })], cwd, env)).stdout);
    expect(next.data, JSON.stringify(next)).toBeDefined();
    last = JSON.stringify(next);
    done = next.data?.done;
    const lease = LeaseSchema.optional().parse(next.data?.lease);
    if (!lease) continue;
    const report = { attempt: lease.attempt, revision: lease.revision, driver };
    if (lease.command !== undefined) {
      const ran = spawnSync('sh', ['-c', lease.command], { cwd: lease.cwd ?? cwd, env: { ...shell, ...lease.env }, encoding: 'utf8' });
      expect(ran.status, `${lease.step}: ${ran.stdout}\n${ran.stderr}`).toBe(0);
      const outputs: unknown = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}');
      // The evidence directory is under the run's, `<data home>/workflows/runs/`.
      if (lease.step.endsWith('evidence')) scores = path.join(z.object({ dir: z.string() }).parse(outputs).dir.split(`${path.sep}workflows${path.sep}`)[0] ?? '', 'scores');
      const reported = envelope((await runCLI(['workflow', 'report', runId, '--json', JSON.stringify({ ...report, outcome: 'success', outputs })], cwd, env)).stdout);
      expect(reported.data, `${lease.step}: ${ran.stderr}\n${JSON.stringify(reported)}`).toMatchObject({ accepted: true });
      continue;
    }
    expect(lease.confined, JSON.stringify(lease)).toBeDefined();
    const confined = { tool: 'claude', isolation: 'verified', access: 'read' };
    const reported = envelope((await runCLI(['workflow', 'report', runId, '--json', JSON.stringify({ ...report, outcome: 'success', outputs: { answer }, confined })], cwd, env)).stdout);
    expect(reported.data, JSON.stringify(reported)).toMatchObject({ accepted: true });
  }
  expect(done, last).toBeDefined();
  return { done, scores };
}

/** The labels `done`, a teamai-score run's, gave its one group. */
function labelsOf(done: unknown): unknown {
  const parsed = z.object({ outputs: z.object({ labels: z.array(z.object({ outputs: z.object({ labels: z.unknown() }) })) }) }).safeParse(done);
  if (!parsed.success) throw new Error(`no labels in done: ${JSON.stringify(done)}`);
  return parsed.data.outputs.labels[0]?.outputs.labels;
}

describe('teamai score with an external driver', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-e2e-'));
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('drives the teamai-score run its run started, refuses a bad answer, publishes the label without the judge\'s words, and queues the pass again on demand', async () => {
    const { team, app, home, env } = await joinedApp(fs.mkdtempSync(path.join(root, 'user-')), 'user');
    const driver = { kind: 'ext', machine: 'e2e', workspace: app };
    const { runId, started } = await drivenToDone({ app, home, env, driver });
    expect(started).toEqual([{ run: expect.any(String), step: 'review', pass: 1, scorers: ['review-quality'] }]);
    const firstRun = z.string().parse(started[0]?.run);

    // A label the scorer does not have fails the pass with judge_answer_invalid and writes no label.
    const bad = await drivenScore({ cwd: app, env, driver, runId: firstRun, answer: { label: 'great', reasoning: `${PHRASE}: the reviewer named the off-by-one.` } });
    expect(labelsOf(bad.done)).toEqual([expect.objectContaining({ scorer: 'review-quality', label: '', code: 'judge_answer_invalid' })]);
    expect(fs.existsSync(path.join(bad.scores, 'labels.jsonl')) ? fs.readFileSync(path.join(bad.scores, 'labels.jsonl'), 'utf8').trim() : '').toBe('');

    // On demand: the member starts teamai-score for the pass again and leaves it to this driver, which runs its command
    // steps with only the env each lease carries, and its judge step confined to the evidence directory.
    const queued = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'review-quality', '--driver', 'none'], app, env);
    expect(queued.code, queued.stdout + queued.stderr).toBe(0);
    const again = z.string().parse(envelope(queued.stdout).data?.run);
    const good = await drivenScore({ cwd: app, env, driver, runId: again, answer: { label: 'thorough', reasoning: `${PHRASE}: the reviewer named the off-by-one.` } });
    expect(good.done).toMatchObject({ outcome: 'succeeded' });
    expect(labelsOf(good.done)).toEqual([{ scorer: 'review-quality', label: 'thorough', code: '' }]);
    const labels = fs.readFileSync(path.join(good.scores, 'labels.jsonl'), 'utf8').trim().split('\n');
    expect(labels).toHaveLength(1);
    expect(JSON.parse(labels[0] ?? '{}')).toMatchObject({
      scorer: 'review-quality', label: 'thorough', source: 'workflow', subject: { runId, step: 'review', pass: 1 }, used: { skills: ['review-notes'] },
      agent: { tool: { name: 'claude' }, model: { reported: 'claude-review-1' }, effort: { requested: 'high' }, driver: 'ext' },
      judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' },
    });

    // The label is on teamai-reports; the judge's words are only in the local reasoning file.
    const published = git(team, 'ls-tree', '-r', '--name-only', 'teamai-reports').split('\n').filter((file) => file.startsWith('scores/'));
    expect(published).toEqual([expect.stringMatching(/^scores\/[^/]+\/\d{4}-\d{2}\.jsonl$/)]);
    expect(JSON.parse(git(team, 'show', `teamai-reports:${published[0]}`).trim())).toMatchObject({ label: 'thorough', subject: { runId } });
    expect(() => git(team, 'grep', '-q', PHRASE, 'teamai-reports')).toThrow();
    expect(() => git(team, 'grep', '-q', home, 'teamai-reports')).toThrow();
    expect(filesContaining(path.join(good.scores, 'reasoning'), PHRASE)).toEqual([expect.stringMatching(/scores\/reasoning\/[0-9a-f]{64}\.md$/)]);

    const unknown = await runCLI(['score', '--run', runId, '--step', 'nope', '--scorer', 'review-quality'], app, env);
    expect(unknown.code).toBe(1);
    expect(envelope(unknown.stdout).error).toMatchObject({ code: 'step_not_found', message: expect.stringContaining('plan, review') });
  }, 300_000);

  it('drives the teamai-score run of a run from another project, as that run\'s scope holds it', async () => {
    const scoped = fs.mkdtempSync(path.join(root, 'project-'));
    const { app, home, env } = await joinedApp(scoped, 'project');
    const driver = { kind: 'ext', machine: 'e2e', workspace: app };
    const { runId, started } = await drivenToDone({ app, home, env, driver });
    // Project B: another checkout, joined to another team in a project scope of its own.
    otherTeam(scoped, home);
    const b = path.join(scoped, 'b');
    fs.mkdirSync(b);
    git(b, 'init', '-q', '-b', 'main');
    const joined = await runCLI(['init', OTHER_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], b, env);
    expect(joined.code, `${joined.stdout}\n${joined.stderr}`).toBe(0);

    const scored = await drivenScore({ cwd: b, env, driver, runId: z.string().parse(started[0]?.run), answer: { label: 'thorough', reasoning: 'Named the off-by-one.' } });
    expect(labelsOf(scored.done)).toEqual([{ scorer: 'review-quality', label: 'thorough', code: '' }]);
    // The label is written in the data home that holds the scored run.
    expect(fs.existsSync(path.join(scored.scores, '..', 'workflows', 'runs', `${runId}.json`))).toBe(true);
    expect(fs.readFileSync(path.join(scored.scores, 'labels.jsonl'), 'utf8')).toContain(runId);
  }, 300_000);

  it('drives the teamai-score run of a user-scope run from the project it started in, whose own team lacks the workflow', async () => {
    const scoped = fs.mkdtempSync(path.join(root, 'shadowed-'));
    const { app, home, env } = await joinedApp(scoped, 'user');
    // The project joins another team, which has no review workflow, so `workflow start review` runs the user scope's.
    otherTeam(scoped, home);
    const joined = await runCLI(['init', OTHER_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], app, env);
    expect(joined.code, `${joined.stdout}\n${joined.stderr}`).toBe(0);
    const driver = { kind: 'ext', machine: 'e2e', workspace: app };
    const { runId, started } = await drivenToDone({ app, home, env, driver });

    const scored = await drivenScore({ cwd: app, env, driver, runId: z.string().parse(started[0]?.run), answer: { label: 'thorough', reasoning: 'Named the off-by-one.' } });
    expect(labelsOf(scored.done)).toEqual([{ scorer: 'review-quality', label: 'thorough', code: '' }]);
    // The label is written in the data home that holds the scored run.
    expect(fs.existsSync(path.join(scored.scores, '..', 'workflows', 'runs', `${runId}.json`))).toBe(true);
    expect(fs.readFileSync(path.join(scored.scores, 'labels.jsonl'), 'utf8')).toContain(runId);
  }, 300_000);
});
