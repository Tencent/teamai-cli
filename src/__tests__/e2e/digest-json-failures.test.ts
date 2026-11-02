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
    git(root, 'init', '-q', '--bare', bare);
    commitBranch(root, bare, 'main', {
      'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`,
      'scorers/review-quality.md': SCORER,
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
    for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'workspace', '--force'], ['pull']]) {
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
    expect(result.stdout).not.toContain('rbe0c0000');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });
});
