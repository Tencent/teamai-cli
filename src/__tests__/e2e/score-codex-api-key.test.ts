/**
 * Real CLI: a member judges a finished session with a team scorer that asks
 * for codex, on a machine signed in only through CODEX_API_KEY. The judge
 * records the names of the variables it was given — never their values.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCwdClaude } from '../../session-flow/fs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const SESSION = '7c1e0000-0000-4000-8000-000000000002';

function runCLI(args: string[], cwd: string, env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(input);
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

const SCORER = `---
labels:
  - { value: thorough, score: 1, description: Did the work it was asked for }
  - { value: shallow, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 0
tool: codex
---
Judge whether the session did what the member asked.
`;

describe('teamai score --session with a codex judge', () => {
  let root: string;
  let knowledge: string;
  let team: string;
  let app: string;
  let env: NodeJS.ProcessEnv;
  let home: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-codex-e2e-'));
    knowledge = path.join(root, 'knowledge');
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

    home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = tester\n\temail = tester@example.com\n[url "${pathToFileURL(team).href}"]\n\tinsteadOf = ${TEAM_URL}\n`);
    const project = path.join(home, '.claude', 'projects', encodeCwdClaude(app));
    fs.mkdirSync(project, { recursive: true });
    const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`),
      line({ type: 'user', uuid: 'u1', parentUuid: null, cwd: app, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries.' } })
      + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: app, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));

    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // A judge that records the NAMES of the variables it was given, never
    // their values, so the record cannot leak the member's key.
    fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(); }
fs.writeFileSync(${JSON.stringify(path.join(root, 'judge-env-names.json'))}, JSON.stringify(Object.keys(process.env).sort()));
fs.writeFileSync(${JSON.stringify(path.join(root, 'judge-argv.json'))}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume(); process.stdin.on('end', () => {
try {
const at = process.argv.indexOf('--output-schema');
const given = at >= 0 ? JSON.parse(fs.readFileSync(process.argv[at + 1], 'utf8')) : undefined;
const schema = given?.properties.answer ?? given;
const answer = { label: 'shallow', reasoning: 'It never ran the tests.' };
// codex writes its answer to the -o file; stdout carries its JSON events.
const out = process.argv.indexOf('-o');
if (out >= 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify(given?.properties.answer ? { answer } : answer));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(given?.properties.answer ? { answer } : answer) } }));
} catch (error) { fs.writeFileSync(${JSON.stringify(path.join(root, 'judge-error.txt'))}, String(error && error.stack || error)); process.exit(1); }
});\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@"${process.execPath}" "${path.join(bin, 'codex')}" %*\r\n`);

    // A member signed in only through CODEX_API_KEY: no auth.json anywhere,
    // no OPENAI_API_KEY.
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });

    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CODEX_HOME: codexHome,
      CODEX_API_KEY: 'member-codex-key-not-a-real-credential',
    };
    for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEBUDDY_SESSION_ID', 'COPILOT_AGENT_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'CLAUDE_SESSION_ID', 'OPENCODE_SESSION_ID', 'TEAMAI_AGENT_SESSION_ID', 'PI_SESSION_ID', 'MUSE_SESSION_ID', 'OPENAI_API_KEY']) delete env[name];

    for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], ['pull']]) {
      const result = await runCLI(command, app, env);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
  });

  afterAll(() => {
    for (const file of ['judge-env-names.json', 'judge-argv.json', 'judge-error.txt']) {
      const at = path.join(root, file);
      if (fs.existsSync(at)) console.error(`\n### ${file}\n${fs.readFileSync(at, 'utf8')}`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('judges with the member CODEX_API_KEY, and gives the judge nothing else', async () => {
    const scored = await runCLI(['score', '--session', SESSION, '--source', 'claude-code', '--scorer', 'review-quality'], app, env);

    expect(scored.code, scored.stdout + scored.stderr).toBe(0);

    const labels = fs.readFileSync(path.join(home, '.teamai', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ scorer: 'review-quality', label: 'shallow' });
    expect(labels[0]).toMatchObject({ judge: { kind: 'model', tool: 'codex' } });

    const names = JSON.parse(fs.readFileSync(path.join(root, 'judge-env-names.json'), 'utf8')) as string[];
    expect(names).toContain('CODEX_API_KEY');
    expect(names).not.toContain('OPENAI_API_KEY');
  });
});
