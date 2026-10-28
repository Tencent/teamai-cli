/**
 * Real CLI against a local bare team repo with two members. Alice labels her own session by hand from inside it and the
 * model scores it again; bob labels and judges the copy she pushed without --scrub, by the name `session list` prints,
 * and a session the team archived on its default branch before teamai-reports.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { encodeCwdClaude } from '../../session-flow/fs.js';
import { defaultSyncMeta, getRepoIdentity, SyncManager } from '../../session-flow/sync.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const APP_URL = 'https://github.com/acme/app.git';
const SESSION = 'a11ce000-0000-4000-8000-000000000001';
const TOKEN = `glpat-${'x1'.repeat(12)}`;
const PROMPT = 'Fix the retry loop in sync.ts';

const SCORER = `---
labels:
  - { value: good, score: 1, description: Fixed the bug the member asked about and added a test }
  - { value: missed-bug, score: 0, description: Left the bug the member asked about }
passingScore: 1
samplingRate: 0
---
Judge whether the session fixed the bug the member asked about.
`;

const EnvelopeSchema = z.object({ data: z.record(z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const LabelSchema = z.object({ subject: z.object({ platform: z.string(), sessionId: z.string() }), judge: z.object({ kind: z.string() }), label: z.string() }).passthrough();

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

function envelope(stdout: string): z.infer<typeof EnvelopeSchema> {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' }).toString();
}

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

describe('teamai score --label and --team-session', () => {
  let root: string;
  let team: string;
  let judged: string;

  /** Where `who` lives, and the environment their teamai runs with: the fake judge first on PATH. */
  function member(who: 'alice' | 'bob'): { app: string; env: NodeJS.ProcessEnv; home: string } {
    const home = path.join(root, who);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` };
    return { app: path.join(home, 'app'), env, home };
  }

  /** A Claude Code session `who` ran in their app, with `prompt` first. */
  function plantSession(who: 'alice' | 'bob', sessionId: string, prompt: string): void {
    const { home, app } = member(who);
    const project = path.join(home, '.claude', 'projects', encodeCwdClaude(app));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${sessionId}.jsonl`),
      line({ type: 'user', uuid: 'u1', parentUuid: null, cwd: app, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: prompt } })
      + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: app, sessionId, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
  }

  /** The labels origin's teamai-reports holds under `scores/<who>/`. */
  function published(who: string): Array<z.infer<typeof LabelSchema>> {
    const files = git(team, 'ls-tree', '-r', '--name-only', 'teamai-reports').split('\n').filter((file) => file.startsWith(`scores/${who}/`));
    return files.flatMap((file) => git(team, 'show', `teamai-reports:${file}`).trim().split('\n').map((text) => LabelSchema.parse(JSON.parse(text))));
  }

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-hand-label-e2e-')));
    const knowledge = path.join(root, 'knowledge');
    team = path.join(root, 'team.git');
    judged = path.join(root, 'judged-transcript.md');
    fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`);
    fs.writeFileSync(path.join(knowledge, 'scorers', 'review-quality.md'), SCORER);
    git(root, 'init', '-q', '-b', 'main', knowledge);
    git(knowledge, 'add', '-A');
    git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team');
    git(root, 'clone', '-q', '--bare', knowledge, team);

    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
fs.writeFileSync(${JSON.stringify(judged)}, fs.readFileSync(require('node:path').join('transcripts', 'session.md'), 'utf8'));
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'It added a test.' } }));
});\n`, { mode: 0o755 });

    for (const who of ['alice', 'bob'] as const) {
      const { app, env, home } = member(who);
      fs.mkdirSync(app, { recursive: true });
      git(app, 'init', '-q', '-b', 'main');
      git(app, 'remote', 'add', 'origin', APP_URL);
      fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = ${who}\n\temail = ${who}@example.com\n[url "file://${team}"]\n\tinsteadOf = ${TEAM_URL}\n`);
      for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], ['pull']]) {
        const result = await runCLI(command, app, env);
        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      }
    }
    plantSession('alice', SESSION, `${PROMPT}. The deploy token is ${TOKEN}`);
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('labels the current session by hand, publishes it, and keeps it beside the model label of the same session', async () => {
    const { app, env } = member('alice');
    const inside = { ...env, CLAUDE_CODE_SESSION_ID: SESSION };

    const unnamed = await runCLI(['score', '--label', 'missed-bug'], app, inside);
    expect(unnamed.code).toBe(1);
    expect(envelope(unnamed.stdout).error).toEqual({ code: 'invalid_arguments', message: 'Pass --scorer <name> with --label: the scorer the value is a label of.' });
    const unknown = await runCLI(['score', '--scorer', 'review-quality', '--label', 'flaky'], app, inside);
    expect(unknown.code).toBe(1);
    expect(envelope(unknown.stdout).error).toEqual({ code: 'label_invalid', message: '"flaky" is not a label of scorer review-quality. Use one of: good, missed-bug.' });
    expect(fs.existsSync(path.join(member('alice').home, '.teamai', 'scores'))).toBe(false);

    const byHand = await runCLI(['score', '--scorer', 'review-quality', '--label', 'missed-bug', '--push'], app, inside);
    expect(byHand.code, byHand.stdout + byHand.stderr).toBe(0);
    expect(envelope(byHand.stdout).data).toMatchObject({
      label: { scorer: 'review-quality', subject: { platform: 'claude-code', sessionId: SESSION }, label: 'missed-bug', score: 0, passed: false, judge: { kind: 'human' } },
      published: true,
    });
    expect(byHand.stderr).toContain('review-quality: missed-bug (score 0, did not pass), by hand. No judge ran.');
    expect(fs.existsSync(judged)).toBe(false);
    expect(fs.existsSync(path.join(member('alice').home, '.teamai', 'scores', 'reasoning'))).toBe(false);

    const byModel = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality', '--push'], app, env);
    expect(byModel.code, byModel.stdout + byModel.stderr).toBe(0);
    expect(published('alice').map(({ subject, judge, label }) => [subject.sessionId, judge.kind, label]).sort()).toEqual([
      [SESSION, 'human', 'missed-bug'],
      [SESSION, 'model', 'good'],
    ]);
  });

  it('labels and judges a session a teammate pushed without --scrub, by its name, redacted for the judge', async () => {
    const alice = member('alice');
    const pushedByAlice = await runCLI(['session', 'push', '--source', 'claude-code', '--cwd', alice.app, '-y'], alice.app, alice.env);
    expect(pushedByAlice.code, pushedByAlice.stdout + pushedByAlice.stderr).toBe(0);
    // Alice passes the name on, so bob's score reads teamai-reports before any other command of his does.
    const listed = await runCLI(['session', 'list'], alice.app, alice.env);
    const { app, env } = member('bob');
    const name = /\b(claude-code_\S+)\s+alice\b/.exec(listed.stdout)?.[1];
    expect(name, listed.stdout + listed.stderr).toBeDefined();
    if (!name) return;

    const byHand = await runCLI(['score', '--team-session', name, '--scorer', 'review-quality', '--label', 'missed-bug', '--push'], app, env);
    expect(byHand.code, byHand.stdout + byHand.stderr).toBe(0);
    expect(envelope(byHand.stdout).data).toMatchObject({ label: { subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'human' } }, published: true });
    expect(byHand.stderr).toContain('Pushed by alice');
    expect(byHand.stderr).toContain(`First prompt: ${PROMPT}. The deploy token is <REDACTED`);
    const [bobs] = published('bob');
    expect(bobs).toMatchObject({ subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'human' }, label: 'missed-bug' });
    expect(bobs).not.toHaveProperty('agent');

    const byModel = await runCLI(['score', '--team-session', name, '--scorer', 'review-quality'], app, env);
    expect(byModel.code, byModel.stdout + byModel.stderr).toBe(0);
    expect(envelope(byModel.stdout).data).toMatchObject({ label: { subject: { platform: 'claude-code', sessionId: SESSION }, label: 'good' } });
    expect(git(team, 'grep', '-c', TOKEN, 'teamai-reports', '--', 'sessions')).toContain(':1');
    const transcript = fs.readFileSync(judged, 'utf8');
    expect(transcript).toContain('Added the retries.');
    expect(transcript).not.toContain(TOKEN);

    const both = await runCLI(['score', '--team-session', name, '--session', SESSION, '--scorer', 'review-quality'], app, env);
    expect(envelope(both.stdout).error).toEqual({ code: 'invalid_arguments', message: '--team-session names a pushed session, and --session and --source one on this machine. Pass one of them.' });
    const missing = await runCLI(['score', '--team-session', 'claude-code_no-such-session_20261020', '--scorer', 'review-quality', '--label', 'good'], app, env);
    expect(missing.code).toBe(1);
    expect(envelope(missing.stdout).error).toMatchObject({ code: 'session_not_found', message: expect.stringContaining('Run teamai session list to see the pushed sessions') });

    plantSession('bob', 'b0b00000-0000-4000-8000-00000000000b', `${PROMPT}. The deploy token is ${TOKEN}`);
    const pushedByBob = await runCLI(['session', 'push', '--source', 'claude-code', '--cwd', app, '--scrub', '-y'], app, env);
    expect(pushedByBob.code, pushedByBob.stdout + pushedByBob.stderr).toBe(0);
    const ambiguous = await runCLI(['score', '--team-session', name, '--scorer', 'review-quality', '--label', 'good'], app, env);
    expect(envelope(ambiguous.stdout).error).toEqual({ code: 'session_ambiguous', message: `--team-session ${name} names sessions pushed by alice, bob. Pass --author with one of them.` });
    const picked = await runCLI(['score', '--team-session', name, '--author', 'bob', '--scorer', 'review-quality', '--label', 'good'], app, env);
    expect(envelope(picked.stdout).data).toMatchObject({ label: { subject: { sessionId: 'b0b00000-0000-4000-8000-00000000000b' } } });
  });

  it('finds a session archived on the default branch before teamai-reports', async () => {
    const clone = fs.mkdtempSync(path.join(root, 'legacy-clone-'));
    git(root, 'clone', '-q', team, clone);
    const legacyId = 'ca401000-0000-4000-8000-00000000000c';
    const session = {
      sessionId: legacyId, title: 'Plan the release', cwd: '/home/carol/app', platform: 'claude-code', createdAt: '2026-06-01T10:00:00.000Z', updatedAt: '2026-06-01T11:00:00.000Z',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Plan the release' }] }],
    };
    const meta = defaultSyncMeta({ platform: 'claude-code', author: 'carol', cwd: session.cwd, sessionId: legacyId, repoIdentity: getRepoIdentity(member('bob').app), title: session.title }, session.createdAt);
    const saved = await new SyncManager(clone).saveSession(session, meta);
    if (saved.status !== 'written') throw new Error('the legacy archive is busy');
    git(clone, 'add', '-A');
    git(clone, '-c', 'user.name=carol', '-c', 'user.email=c@c', 'commit', '-qm', 'sync: push 1 session(s) from claude-code');
    git(clone, 'push', '-q', 'origin', 'main');
    const { app, env } = member('bob');
    expect((await runCLI(['session', 'pull'], app, env)).code).toBe(0);

    const labelled = await runCLI(['score', '--team-session', path.basename(saved.value, '.jsonl'), '--scorer', 'review-quality', '--label', 'good'], app, env);
    expect(labelled.code, labelled.stdout + labelled.stderr).toBe(0);
    expect(envelope(labelled.stdout).data).toMatchObject({ label: { subject: { platform: 'claude-code', sessionId: legacyId }, judge: { kind: 'human' } } });
    expect(labelled.stderr).toContain('Pushed by carol');
  });
});
