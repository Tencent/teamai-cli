/**
 * Real CLI against a local bare team repo: a member who turns session scoring on starts a session, and the session
 * start's pull judges an earlier finished session in the background with a fake Claude judge. The label stays pending
 * until the next pull publishes it, never with the transcript.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCwdClaude } from '../../session-flow/fs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const FINISHED = '7c1e0000-0000-4000-8000-000000000021';
const STARTING = '7c1e0000-0000-4000-8000-000000000022';
const PHRASE = 'Only-the-finished-session-said-this-quokka';
const HOUR = 60 * 60 * 1000;

function runCLI(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' }).toString();
}

async function until(condition: () => boolean, what: string, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const SCORER = `---
labels:
  - { value: thorough, score: 1, description: Did the work it was asked for }
  - { value: shallow, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
sessions: true
---
Judge whether the session did what the member asked.
`;

describe('background session scoring', () => {
  let root: string;
  let team: string;
  let app: string;
  let dataHome: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-sessions-e2e-')));
    const knowledge = path.join(root, 'knowledge');
    team = path.join(root, 'team.git');
    fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`);
    fs.writeFileSync(path.join(knowledge, 'scorers', 'review-quality.md'), SCORER);
    git(root, 'init', '-q', '-b', 'main', knowledge);
    git(knowledge, 'add', '-A');
    git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team');
    git(root, 'clone', '-q', '--bare', knowledge, team);
    app = path.join(root, 'app');
    fs.mkdirSync(app);
    git(app, 'init', '-q', '-b', 'main');

    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = tester\n\temail = tester@example.com\n[url "file://${team}"]\n\tinsteadOf = ${TEAM_URL}\n`);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'thorough', reasoning: 'It ran the tests.' } }));
});\n`, { mode: 0o755 });
    env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEBUDDY_SESSION_ID', 'COPILOT_AGENT_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'CLAUDE_SESSION_ID', 'OPENCODE_SESSION_ID', 'TEAMAI_AGENT_SESSION_ID', 'PI_SESSION_ID', 'MUSE_SESSION_ID', 'TEAMAI_LAUNCHED_BY']) delete env[name];
    for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], ['pull']]) {
      const result = await runCLI(command, app, env);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
    dataHome = path.join(home, '.teamai');
    fs.appendFileSync(path.join(dataHome, 'config.yaml'), 'scoring:\n  sessions: true\n');

    // A session that ended seven hours ago, as its session-start hook captured it.
    const project = path.join(home, '.claude', 'projects', encodeCwdClaude(app));
    fs.mkdirSync(project, { recursive: true });
    const file = path.join(project, `${FINISHED}.jsonl`);
    const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
    fs.writeFileSync(file,
      line({ type: 'user', uuid: 'u1', parentUuid: null, cwd: app, sessionId: FINISHED, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: `Add retries. ${PHRASE}` } })
      + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: app, sessionId: FINISHED, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
    const ended = new Date(Date.now() - 7 * HOUR);
    fs.utimesSync(file, ended, ended);
    const captures = path.join(dataHome, 'sessions', 'captures', 'claude-code', FINISHED);
    fs.mkdirSync(captures, { recursive: true });
    const captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f21';
    fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId: FINISHED,
      capturedAt: ended.toISOString(), agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file }));
  });

  afterAll(async () => {
    if (!root) return;
    // The detached judge may still be releasing its lock.
    await until(() => !fs.existsSync(path.join(dataHome, 'scores', 'score-sessions.lock')), 'the background judge to exit').catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('judges a finished session after a session start\'s pull, keeps the label pending, and the next pull publishes it', async () => {
    const pending = () => (fs.existsSync(path.join(dataHome, 'scores', 'pending')) ? fs.readdirSync(path.join(dataHome, 'scores', 'pending')) : []);
    const published = () => {
      const refs = git(team, 'for-each-ref', '--format=%(refname)', 'refs/heads/teamai-reports');
      return refs.trim() === '' ? [] : git(team, 'ls-tree', '-r', '--name-only', 'teamai-reports').split('\n').filter((name) => name.startsWith('scores/'));
    };

    const start = await runCLI(['hook-dispatch', 'session-start', '--tool', 'claude', '--stdin', '--bg-only'], app, env, JSON.stringify({ cwd: app, session_id: STARTING }));
    expect(start.code, start.stdout + start.stderr).toBe(0);
    await until(() => pending().length === 1 && !fs.existsSync(path.join(dataHome, 'scores', 'score-sessions.lock')), 'the background judge to label the finished session');

    const labels = fs.readFileSync(path.join(dataHome, 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((text) => JSON.parse(text) as unknown);
    expect(labels).toEqual([expect.objectContaining({ source: 'session', subject: { platform: 'claude-code', sessionId: FINISHED }, label: 'thorough', judge: expect.objectContaining({ tool: 'claude' }) })]);
    expect(published()).toEqual([]);

    const pull = await runCLI(['pull'], app, env);
    expect(pull.code, pull.stdout + pull.stderr).toBe(0);
    expect(pending()).toEqual([]);
    const [file, ...more] = published();
    expect(more).toEqual([]);
    expect(git(team, 'show', `teamai-reports:${file}`)).toContain(FINISHED);
    expect(() => git(team, 'grep', '-q', PHRASE, 'teamai-reports')).toThrow();
  });
});
