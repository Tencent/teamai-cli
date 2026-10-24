/**
 * Real CLI against a local bare team repo: an external JSON driver runs a scored workflow to its end with workflow next
 * and report, then takes the judge work with score --next and settles it with score --lease --submit for a fake judge.
 * The member then asks for the pass again with score --run --queue. The review's report names the team skills it used,
 * and the label carries those that are shaped like a skill name.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const PHRASE = 'Only-the-judge-wrote-this-quokka';

const EnvelopeSchema = z.object({ data: z.record(z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const JudgeLeaseSchema = z.object({ ref: z.string(), evidence: z.string(), prompt: z.string(), submit: z.string() }).passthrough();

function runCLI(args: string[], cwd: string, env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function envelope(stdout: string): z.infer<typeof EnvelopeSchema> {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
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

describe('teamai score with an external driver', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-e2e-'));
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('settles the run first, then leases, refuses a bad label, publishes the label without the judge\'s words, and queues the pass again on demand', async () => {
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
    for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], ['pull']]) {
      const result = await runCLI(command, app, env);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    }

    const runId = String(envelope((await runCLI(['workflow', 'start', 'review'], app, env)).stdout).data?.run);
    const driver = { kind: 'ext', machine: 'e2e', workspace: app };
    let done: unknown;
    for (let turn = 0; turn < 10 && done === undefined; turn += 1) {
      const next = envelope((await runCLI(['workflow', 'next', runId, '--json', JSON.stringify({ driver })], app, env)).stdout);
      expect(next.data, JSON.stringify(next)).toBeDefined();
      expect(JSON.stringify(next)).not.toContain('judge');
      done = next.data?.done;
      const lease = z.object({ attempt: z.string(), revision: z.number(), step: z.string() }).optional().parse(next.data?.lease);
      if (!lease) continue;
      const used = lease.step === 'review' ? { used: { skills: ['review-notes', path.join(home, '.claude', 'skills', 'deploy-notes', 'SKILL.md')] } } : {};
      const reported = envelope((await runCLI(['workflow', 'report', runId, '--json', JSON.stringify({ attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, outputs: { reviewed: true }, ...used })], app, env)).stdout);
      expect(reported.data, JSON.stringify(reported)).toMatchObject({ accepted: true });
    }
    expect(done).toMatchObject({ outcome: 'succeeded' });

    const judge = { driver: { ...driver, can: { judge: { isolation: 'verified', tools: ['claude'] } } }, running: [] };
    const next = await runCLI(['score', '--next', '--json', JSON.stringify(judge)], app, env);
    const lease = JudgeLeaseSchema.parse(envelope(next.stdout).data?.lease);
    expect(lease, next.stdout + next.stderr).toMatchObject({ subject: { runId, step: 'review', pass: 1 }, submit: `teamai score --lease ${lease.ref} --submit --stdin` });
    expect(fs.readFileSync(lease.prompt, 'utf8')).toContain('Judge the review against the diff.');

    const reportedJudge = await runCLI(['workflow', 'report', lease.ref, '--json', '{}'], app, env);
    expect(reportedJudge.code).toBe(1);
    expect(envelope(reportedJudge.stdout).error?.code).toBe('judge_lease');

    const answer = (label: string) => JSON.stringify({ driver, outcome: 'success', answer: { label, reasoning: `${PHRASE}: the reviewer named the off-by-one.` }, judge: { tool: 'claude' } });
    const bad = await runCLI(['score', '--lease', lease.ref, '--submit', '--stdin'], app, env, answer('great'));
    expect(bad.code).toBe(1);
    expect(envelope(bad.stdout).error?.code).toBe('label_invalid');

    const good = await runCLI(['score', '--lease', lease.ref, '--submit', '--stdin'], app, env, answer('thorough'));
    expect(good.code, good.stdout + good.stderr).toBe(0);
    expect(envelope(good.stdout).data).toMatchObject({ label: { scorer: 'review-quality', label: 'thorough', score: 1, passed: true }, published: true });
    const dataHome = path.resolve(lease.evidence, '..', '..', '..');
    const labels = fs.readFileSync(path.join(dataHome, 'scores', 'labels.jsonl'), 'utf8').trim().split('\n');
    expect(labels).toHaveLength(1);
    expect(JSON.parse(labels[0] ?? '{}')).toMatchObject({ scorer: 'review-quality', label: 'thorough', source: 'workflow', subject: { runId, step: 'review', pass: 1 }, used: { skills: ['review-notes'] } });
    expect(envelope((await runCLI(['score', '--next', '--json', JSON.stringify(judge)], app, env)).stdout).data).toEqual({ idle: { open: 0, leased: 0 } });

    // The label is on teamai-reports; the judge's words are only in the local reasoning file.
    const published = git(team, 'ls-tree', '-r', '--name-only', 'teamai-reports').split('\n').filter((file) => file.startsWith('scores/'));
    expect(published).toEqual([expect.stringMatching(/^scores\/[^/]+\/\d{4}-\d{2}\.jsonl$/)]);
    expect(JSON.parse(git(team, 'show', `teamai-reports:${published[0]}`).trim())).toMatchObject({ label: 'thorough', subject: { runId } });
    expect(() => git(team, 'grep', '-q', PHRASE, 'teamai-reports')).toThrow();
    expect(() => git(team, 'grep', '-q', home, 'teamai-reports')).toThrow();
    expect(filesContaining(path.join(dataHome, 'workflows'), PHRASE)).toEqual([]);
    expect(filesContaining(path.join(dataHome, 'scores'), PHRASE)).toEqual([expect.stringMatching(/scores\/reasoning\/[0-9a-f]{64}\.md$/)]);

    // On demand: the member queues the labelled pass again, and a driver whose judge only answers takes it.
    const queued = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'review-quality', '--queue'], app, env);
    expect(queued.code, queued.stdout + queued.stderr).toBe(0);
    expect(envelope(queued.stdout).data).toEqual({ queued: [{ scorer: 'review-quality', subject: { runId, step: 'review', pass: 1 } }] });
    const answering = { driver: { ...driver, can: { judge: { isolation: 'verified', access: 'answer', tools: ['claude'] } } }, running: [] };
    const again = JudgeLeaseSchema.parse(envelope((await runCLI(['score', '--next', '--json', JSON.stringify(answering)], app, env)).stdout).data?.lease);
    expect(again).toMatchObject({ subject: { runId, step: 'review', pass: 1 }, judge: { access: 'answer' } });
    const rescored = await runCLI(['score', '--lease', again.ref, '--submit', '--stdin'], app, env, answer('shallow'));
    expect(envelope(rescored.stdout).data, rescored.stdout + rescored.stderr).toMatchObject({ label: { label: 'shallow' } });
    const latest = fs.readFileSync(path.join(dataHome, 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').at(-1) ?? '{}';
    expect(JSON.parse(latest)).toMatchObject({ label: 'shallow', judge: { kind: 'model', tool: 'claude', access: 'answer' } });
    const unknown = await runCLI(['score', '--run', runId, '--step', 'nope', '--scorer', 'review-quality'], app, env);
    expect(unknown.code).toBe(1);
    expect(envelope(unknown.stdout).error).toMatchObject({ code: 'step_not_found', message: expect.stringContaining('plan, review') });
  });
});
