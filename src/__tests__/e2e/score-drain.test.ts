/**
 * Real CLI against a local bare team repo: `teamai score --drain` in an unattended job drives one
 * teamai-finished-sessions run, which archives and judges the job's finished sessions with a fake Claude judge, then
 * publishes the labels. A failed judgment is final, and `daily_limit` in ~/.teamai/config.yaml binds under the team's.
 * With `skill_routing` on, each delivered team skill of a session gets a routing question, all of them in one launch.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCwdClaude } from '../../session-flow/fs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const HOUR = 60 * 60 * 1000;
const SESSIONS = ['7c1e0000-0000-4000-8000-000000000031', '7c1e0000-0000-4000-8000-000000000032', '7c1e0000-0000-4000-8000-000000000033'];

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

interface Job {
  team: string;
  dataHome: string;
  root: string;
  app: string;
  env: NodeJS.ProcessEnv;
  drain: () => Promise<{ code: number | null; lines: string[] }>;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' }).toString();
}

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

/**
 * An unattended job on a member's machine whose team has `files`, with `config` appended to its config.yaml, a Claude
 * judge that gives each scorer its first label, or with `fails` exits 1, and counts its launches in `<root>/calls`, and
 * `sessions` captured unattended and idle seven hours, each delivered the team skills `skills`.
 */
async function job({ files = {}, config = '', fails = false, sessions = 1, skills }: { files?: Record<string, string>; config?: string; fails?: boolean; sessions?: number; skills?: Record<string, { namespace?: string }> }): Promise<Job> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-drain-e2e-')));
  roots.push(root);
  const knowledge = path.join(root, 'knowledge');
  const team = path.join(root, 'team.git');
  for (const [file, text] of Object.entries({ 'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`, 'scorers/review-quality.md': SCORER, ...files })) {
    fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
    fs.writeFileSync(path.join(knowledge, file), text);
  }
  git(root, 'init', '-q', '-b', 'main', knowledge);
  git(knowledge, 'add', '-A');
  git(knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team');
  git(root, 'clone', '-q', '--bare', knowledge, team);
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  git(app, 'init', '-q', '-b', 'main');

  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = tester\n\temail = tester@example.com\n[url "${pathToFileURL(team).href}"]\n\tinsteadOf = ${TEAM_URL}\n`);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, 'x');
${fails ? 'process.exit(1);' : ''}
const schema = JSON.parse(process.argv[process.argv.indexOf('--json-schema') + 1]).properties.answer;
const first = (one) => ({ label: one.properties.label.enum[0], reasoning: 'It ran the tests.' });
const answer = schema.properties.label ? first(schema) : Object.fromEntries(Object.entries(schema.properties).map(([name, one]) => [name, first(one)]));
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: { answer } }));
});\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${path.join(bin, 'claude')}" %*\r\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TEAMAI_MODE: 'unattended' };
  for (const name of ['CI', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEBUDDY_SESSION_ID', 'COPILOT_AGENT_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'CLAUDE_SESSION_ID', 'OPENCODE_SESSION_ID', 'TEAMAI_AGENT_SESSION_ID', 'PI_SESSION_ID', 'MUSE_SESSION_ID', 'TEAMAI_LAUNCHED_BY', 'TEAMAI_WORKFLOW_ATTEMPT']) delete env[name];
  for (const command of [['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], ['pull']]) {
    const result = await runCLI(command, app, env);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  }
  const dataHome = path.join(home, '.teamai');
  fs.appendFileSync(path.join(dataHome, 'config.yaml'), config);

  const project = path.join(home, '.claude', 'projects', encodeCwdClaude(app));
  fs.mkdirSync(project, { recursive: true });
  for (const sessionId of SESSIONS.slice(0, sessions)) {
    const file = path.join(project, `${sessionId}.jsonl`);
    const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
    fs.writeFileSync(file,
      line({ type: 'user', uuid: 'u1', parentUuid: null, cwd: app, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries.' } })
      + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: app, sessionId, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
    const ended = new Date(Date.now() - 7 * HOUR);
    fs.utimesSync(file, ended, ended);
    const captures = path.join(dataHome, 'sessions', 'captures', 'claude-code', sessionId);
    fs.mkdirSync(captures, { recursive: true });
    const captureId = `0b6f2a52-5d7e-4c7e-9a43-${sessionId.slice(-12)}`;
    fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId, runMode: 'unattended',
      capturedAt: ended.toISOString(), agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file, ...(skills ? { teamSkillInfo: skills } : {}) }));
  }

  return {
    team,
    dataHome,
    root,
    app,
    env,
    drain: async () => {
      const drained = await runCLI(['score', '--drain'], app, env);
      return { code: drained.code, lines: `${drained.stdout}${drained.stderr}`.split('\n').filter(Boolean) };
    },
  };
}

/** The files under `dir` on teamai-reports of the team's bare repository. */
function onReports(team: string, dir: string): string[] {
  try {
    return git(team, 'ls-tree', '-r', '--name-only', 'teamai-reports', dir).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function labels(dataHome: string): unknown[] {
  const file = path.join(dataHome, 'scores', 'labels.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((text) => JSON.parse(text) as unknown) : [];
}

describe('teamai score --drain, through the real CLI', () => {
  it('in an unattended job, archives and judges each finished session, publishes its label, and a second drain does neither again', async () => {
    const { team, dataHome, drain } = await job({});

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toEqual(expect.arrayContaining([
      '✔ Judged 1 sampled session here (review-quality)',
      '✔ Archived 1 captured session to teamai-reports (scrubbed)',
      '✔ Published 1 label to teamai-reports',
    ]));
    expect(labels(dataHome)).toEqual([expect.objectContaining({ scorer: 'review-quality', label: 'thorough', subject: { platform: 'claude-code', sessionId: SESSIONS[0] }, runMode: 'unattended' })]);
    expect(onReports(team, 'sessions').filter((file) => file.endsWith('.jsonl'))).toHaveLength(1);
    expect(onReports(team, 'scores')).toHaveLength(1);

    const again = await drain();

    expect(again.code, again.lines.join('\n')).toBe(0);
    expect(again.lines.filter((printed) => /Judged|Archived/.test(printed))).toEqual([]);
  }, 180_000);

  it('prints a failed judgment and exits 1, and a second drain exits 0 without judging it again', async () => {
    const { drain } = await job({ fails: true });

    const failed = await drain();

    expect(failed.code, failed.lines.join('\n')).toBe(1);
    expect(failed.lines).toContain(`✖ review-quality on claude-code session ${SESSIONS[0]}: judge_failed. A failed judgment is final and is not retried. `
      + `To ask for a new one: teamai score --session ${SESSIONS[0]} --source claude-code --scorer review-quality`);

    const again = await drain();

    expect(again.code, again.lines.join('\n')).toBe(0);
    expect(again.lines.filter((printed) => printed.includes('Judged'))).toEqual([]);
  }, 180_000);

  it('judges 2 of 3 finished sessions where ~/.teamai/config.yaml says daily_limit: 2 under the team\'s daily_limit: 10', async () => {
    const { dataHome, drain } = await job({ files: { 'scorers/scoring.yaml': 'daily_limit: 10\n' }, config: 'scoring:\n  daily_limit: 2\n', sessions: 3 });

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(drained.lines).toContain('✔ Judged 2 sampled sessions here (review-quality)');
    expect(labels(dataHome)).toHaveLength(2);
  }, 180_000);
});

describe('routing questions, through the real CLI', () => {
  const skills = { release: { namespace: 'ops' }, 'review-notes': {} };
  const launches = (root: string): number => (fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').length : 0);
  const routed = (dataHome: string): unknown[] => labels(dataHome).filter((label) => String((label as { scorer: string }).scorer).startsWith('teamai:routing:'));

  it('with skill_routing on, a drain asks one question per delivered team skill of a finished session, all in one launch', async () => {
    const { root, dataHome, drain } = await job({ files: { 'scorers/scoring.yaml': 'skill_routing: true\n' }, skills });

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(routed(dataHome)).toEqual(expect.arrayContaining([
      expect.objectContaining({ scorer: 'teamai:routing:ops:release', label: 'fit', subject: { platform: 'claude-code', sessionId: SESSIONS[0] } }),
      expect.objectContaining({ scorer: 'teamai:routing:review-notes', label: 'fit', subject: { platform: 'claude-code', sessionId: SESSIONS[0] } }),
    ]));
    expect(routed(dataHome)).toHaveLength(2);
    expect(launches(root)).toBe(2);
  }, 180_000);

  it('with skill_routing off, a drain asks no routing question', async () => {
    const { dataHome, drain } = await job({ skills });

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(labels(dataHome)).toEqual([expect.objectContaining({ scorer: 'review-quality' })]);
  }, 180_000);

  it.each([true, undefined])('keeps ten routing questions together with batch=%s', async (batch) => {
    const tenSkills = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`skill-${index}`, {}]));
    const { root, dataHome, drain } = await job({
      files: { 'scorers/scoring.yaml': `sessions: true\nskill_routing: true\n${batch ? 'batch: true\n' : ''}` },
      skills: tenSkills,
    });

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(routed(dataHome)).toHaveLength(10);
    expect(labels(dataHome)).toHaveLength(11);
    expect(routed(dataHome)).toEqual(expect.arrayContaining(Object.keys(tenSkills).map((skill) =>
      expect.objectContaining({ scorer: `teamai:routing:${skill}`, subject: { platform: 'claude-code', sessionId: SESSIONS[0] } }))));
    expect(launches(root)).toBe(batch ? 1 : 2);
  }, 180_000);

  it.each([undefined, {}])('asks no routing question when captured skill information is %j', async (capturedSkills) => {
    const { root, dataHome, drain } = await job({ files: { 'scorers/scoring.yaml': 'skill_routing: true\n' }, skills: capturedSkills });

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(routed(dataHome)).toEqual([]);
    expect(labels(dataHome)).toEqual([expect.objectContaining({ scorer: 'review-quality' })]);
    expect(launches(root)).toBe(1);
  }, 180_000);

  it('lets an active scorers namespace turn routing off under an enabled root', async () => {
    const { root, dataHome, drain } = await job({
      files: {
        'scorers/scoring.yaml': 'sessions: true\nskill_routing: true\n',
        'scorers/ops/scoring.yaml': 'skill_routing: false\n',
      },
      skills,
    });

    const drained = await drain();

    expect(drained.code, drained.lines.join('\n')).toBe(0);
    expect(routed(dataHome)).toEqual([]);
    expect(labels(dataHome), drained.lines.join('\n')).toEqual([expect.objectContaining({ scorer: 'review-quality' })]);
    expect(launches(root)).toBe(1);
  }, 180_000);

  it('teamai score --session --scorer teamai:routing:<namespace>:<skill> labels it through a teamai-score run, with skill_routing off', async () => {
    const { app, env, root, dataHome } = await job({ skills });

    const scored = await runCLI(['score', '--session', SESSIONS[0], '--source', 'claude-code', '--scorer', 'teamai:routing:ops:release', '--scorer', 'teamai:routing:review-notes'], app, { ...env, TEAMAI_MODE: 'attended' });

    expect(scored.code, `${scored.stdout}\n${scored.stderr}`).toBe(0);
    expect(routed(dataHome)).toEqual(expect.arrayContaining([
      expect.objectContaining({ scorer: 'teamai:routing:ops:release', label: 'fit', subject: { platform: 'claude-code', sessionId: SESSIONS[0] } }),
      expect.objectContaining({ scorer: 'teamai:routing:review-notes', label: 'fit', subject: { platform: 'claude-code', sessionId: SESSIONS[0] } }),
    ]));
    expect(routed(dataHome)).toHaveLength(2);
    expect(launches(root)).toBe(1);
  }, 180_000);
});
