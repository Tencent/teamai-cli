/**
 * Real CLI: `teamai digest --json` in a member's checkout of a local bare team repo whose teamai-reports branch holds
 * the labels teammates published, the run records of the workflow passes they judge, and a benchmark run's labels.
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
const START = '3f2c9a7'.padEnd(40, '0');
const PASS_START = '9a1d4e7'.padEnd(40, '0');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const SCORER = `---
labels:
  - { value: good, score: 1, description: Found the bug the change brought in }
  - { value: missed-bug, score: 0, description: Approved a change with a bug }
passingScore: 1
samplingRate: 0
---
Judge whether the review caught the bug in the change.
`;

const EnvelopeSchema = z.object({ data: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });

function runCLI(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' }).toString();
}

const agent = (tool: string, project?: { commit: string; dirty: boolean }) => ({ v: 1, tool: { name: tool }, teamai: '1.0.0', driver: 'local', ...(project ? { project } : {}) });
const model = (tool: string) => ({ kind: 'model', tool, model: { reported: `${tool}-model` }, isolation: 'verified', access: 'read' });
const sessionLabel = (sessionId: string, fields: Record<string, unknown>) => ({
  scorer: 'review-quality', rubric: { sourceHash: 'rubric-1' }, label: 'missed-bug', score: 0, passed: false, judge: model('claude'),
  source: 'session', subject: { platform: 'claude-code', sessionId }, runMode: 'attended', scoredAt: ago(2), ...fields,
});
const passLabel = (runId: string, scoredAt: string) => ({
  scorer: 'review-quality', rubric: { sourceHash: 'rubric-1' }, label: 'missed-bug', score: 0, passed: false, judge: model('claude'),
  source: 'workflow', subject: { runId, step: 'review', pass: 1 }, runMode: 'unattended', scoredAt,
});

/** Commits `files` to `branch` of the bare repo `bare`, as an orphan branch when it has none. */
function commitBranch(root: string, bare: string, branch: string, files: Record<string, string>): void {
  const work = fs.mkdtempSync(path.join(root, `${branch}-`));
  git(work, 'init', '-q', '-b', branch);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', branch);
  git(work, 'push', '-q', bare, `HEAD:refs/heads/${branch}`);
}

describe('teamai digest --json', () => {
  let root: string;
  let app: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-digest-json-e2e-')));
    const bare = path.join(root, 'team.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    commitBranch(root, bare, 'main', {
      'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`,
      'scorers/review-quality.md': SCORER,
      'benchmarks/regressions/suite.yaml': `schemaVersion: v1alpha1\nname: regressions\ndescription: Failures the team fixed.\nrepo: https://github.com/acme/app.git\ndefaults:\n  tool: claude\narms:\n  - name: claude\nrepetitions: 1\ntimeout: 10m\n`,
      'benchmarks/regressions/tasks/review-missed-null-check.yaml': `schemaVersion: v1alpha1\ntitle: Catch the missed null check\nprompt: Review the change.\nstartingCommit: ${PASS_START}\nsuccessCriteria: The review names the null check the change drops.\nsource: { runId: r1a2b3c4d, step: review, pass: 1 }\n`,
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: infra\n    name: Infra\n    resources:\n      learnings: [k8s]\n',
    });
    const learning = (title: string, session?: string) => `---\ntitle: ${title}\n${session ? `session: { platform: claude-code, sessionId: ${session} }\n` : ''}---\n${title}.\n`;
    commitBranch(root, bare, 'teamai-learnings', {
      'learnings/pod-startup-timeouts-2026-10-24-k3x9q2.md': learning('Pod startup timeouts', '7c1e0000'),
      'learnings/k8s/helm-values-2026-10-22-a8c1d0.md': learning('Helm values', '7c1e0000'),
      'learnings/ops/pager-rota-2026-10-21-b7d2e1.md': learning('Pager rota', '7c1e0000'),
      'learnings/unrelated-2026-10-20-c6e3f0.md': learning('Unrelated', 'ffff0000'),
      'learnings/no-session-2026-10-19-d5f4a9.md': learning('No session'),
    });
    const labels = [
      sessionLabel('7c1e0000', { agent: agent('claude', { commit: START, dirty: false }) }),
      sessionLabel('7c1e0000', { judge: { kind: 'human' }, scoredAt: ago(2.1) }),
      sessionLabel('9d2f0000', { scoredAt: ago(3), agent: agent('claude', { commit: START, dirty: true }) }),
      sessionLabel('a0b10000', { label: 'good', score: 1, passed: true }),
      sessionLabel('a0b10000', { judge: { kind: 'human' }, scoredAt: ago(2.2) }),
      passLabel('r1a2b3c4d', ago(1)),
      passLabel('rbe0c0000', ago(1)),
    ];
    commitBranch(root, bare, 'teamai-reports', {
      'scores/bob/2026-11.jsonl': labels.map((label) => `${JSON.stringify(label)}\n`).join(''),
      'workflows/runs/r1a2b3c4d.json': JSON.stringify({ steps: [{ step: 'review', pass: 1, agent: agent('codex', { commit: PASS_START, dirty: false }) }] }),
      'workflows/runs/rbe0c0000.json': JSON.stringify({ isolated: true, steps: [{ step: 'review', pass: 1, agent: agent('codex', { commit: PASS_START, dirty: false }) }] }),
    });

    const home = path.join(root, 'alice');
    app = path.join(home, 'app');
    fs.mkdirSync(app, { recursive: true });
    git(app, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = alice\n\temail = alice@example.com\n[url "file://${bare}"]\n\tinsteadOf = ${TEAM_URL}\n`);
    env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
    for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'workspace', '--project', 'infra', '--force'], ['pull']]) {
      const result = await runCLI(command, app, env);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
  }, 120_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists each failing label with its subject and start, leaves out passing and benchmark labels, and gives each model judge its agreement', async () => {
    const result = await runCLI(['digest', '--json'], app, env);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const { data } = EnvelopeSchema.parse(JSON.parse(result.stdout));
    expect(data).toMatchObject({
      window: { days: 30 },
      scorers: [{
        scorer: 'review-quality',
        cohorts: expect.arrayContaining([
          expect.objectContaining({ source: 'session', judge: { kind: 'model', tool: 'claude', model: { id: 'claude-model', isReported: true } }, agreement: { handLabelled: 2, paired: 2, agree: 1, judgePassedHumanFailed: 1, judgeFailedHumanPassed: 0 } }),
        ]),
      }],
    });
    const failures = z.array(z.object({ failure: z.object({ source: z.string(), subject: z.unknown(), author: z.string(), runMode: z.string().optional() }).passthrough(), start: z.unknown() }).passthrough())
      .parse(z.object({ failures: z.unknown() }).parse(data).failures);
    expect(failures.map(({ failure, start }) => [failure.subject, failure.judge, start])).toEqual([
      [{ runId: 'r1a2b3c4d', step: 'review', pass: 1 }, { kind: 'model', tool: 'claude', model: { id: 'claude-model', isReported: true } }, { commit: PASS_START }],
      [{ platform: 'claude-code', sessionId: '7c1e0000' }, { kind: 'model', tool: 'claude', model: { id: 'claude-model', isReported: true } }, { commit: START }],
      [{ platform: 'claude-code', sessionId: '7c1e0000' }, { kind: 'human' }, { refused: 'not_recorded' }],
      [{ platform: 'claude-code', sessionId: 'a0b10000' }, { kind: 'human' }, { refused: 'not_recorded' }],
      [{ platform: 'claude-code', sessionId: '9d2f0000' }, { kind: 'model', tool: 'claude', model: { id: 'claude-model', isReported: true } }, { refused: 'tracked_changes' }],
    ]);
    expect(failures[0]?.failure).toMatchObject({ author: 'bob', runMode: 'unattended', agent: { tool: { name: 'codex' } } });
    expect(failures.map(({ task }) => task)).toEqual(['benchmarks/regressions/tasks/review-missed-null-check.yaml', undefined, undefined, undefined, undefined]);
    expect(result.stdout).not.toContain('rbe0c0000');
  });

  it('lists with each failing session the learnings that name it, namespaced ones it receives included, and none with a workflow pass', async () => {
    const result = await runCLI(['digest', '--json'], app, env);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const failures = z.object({ data: z.object({ failures: z.array(z.object({ failure: z.object({ subject: z.record(z.string(), z.unknown()) }).passthrough(), learnings: z.array(z.object({ id: z.string(), path: z.string() })).optional() })) }) })
      .parse(JSON.parse(result.stdout)).data.failures;
    const [pass, judged, byHand, , dirty] = failures;
    expect(pass && 'learnings' in pass).toBe(false);
    expect(dirty?.learnings).toEqual([]);
    expect(judged?.learnings?.map(({ id }) => id)).toEqual(['pod-startup-timeouts-2026-10-24-k3x9q2', 'k8s/helm-values-2026-10-22-a8c1d0']);
    expect(byHand?.learnings).toEqual(judged?.learnings);
    for (const { id, path: file } of judged?.learnings ?? []) {
      expect(path.isAbsolute(file)).toBe(true);
      expect(file.endsWith(path.join('learnings', `${id}.md`))).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain('sessionId: 7c1e0000');
    }
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('says on stderr too why it cannot plan an improvement, as a failed workflow step shows only stderr', async () => {
    const result = await runCLI(['digest', '--json', '--scorer', 'review-qualty', '--suite', 'benchmarks/regressions'], app, env);

    expect(result.code).toBe(1);
    const message = 'The team has no scorer review-qualty. Run teamai pull, or give one teamai list scorers shows.';
    expect(JSON.parse(result.stdout)).toEqual({ error: { code: 'scorer_not_found', message } });
    expect(result.stderr).toContain(message);
  });
});
