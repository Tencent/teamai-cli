/**
 * Real CLI: a member's agent runs teamai's default teamai-share-learnings-from-sessions on the skill driver. Two earlier
 * sessions of two tools finished on this machine, a Claude Code one and a Hermes one kept in SQLite; the person shares
 * the Hermes one and skips the other, and only the Hermes one reaches teamai-share-learnings, with publish false.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { findSqlite3 } from '@teamai/tool-core/sessions/sqlite';
import type { LocalConfig } from '../../types.js';
import { readRun } from '../../workflow/store.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const WORKFLOW = 'teamai-share-learnings-from-sessions';
// The agent's own session, which starts the run: it is not one of the finished ones.
const AGENT_SESSION = '7c1e0000-0000-4000-8000-00000000b000';
const CLAUDE_SESSION = '7c1e0000-0000-4000-8000-00000000b001';
const HERMES_SESSION = '20261104_091523_b1b2c3d4';
const HOUR = 60 * 60 * 1000;

const EnvelopeSchema = z.object({ data: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const DescribeSchema = z.object({ describe: z.object({ ask: z.object({ question: z.object({ options: z.array(z.object({ start: z.string() })).nonempty() }) }) }) });
const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choose'), about: z.enum(['host', 'gate']), question: z.string().optional(), options: z.array(z.object({ run: z.string(), id: z.string().optional(), choice: z.string().optional() })) }),
  z.object({ kind: z.literal('dispatch'), step: z.string(), brief: z.string(), ack: z.string(), report: z.string() }),
  z.object({ kind: z.literal('done'), outcome: z.string() }),
]);
const TurnSchema = z.object({
  run: z.string(), actions: z.array(ActionSchema),
  // oxlint-disable-next-line unicorn/no-thenable -- a workflow turn names its next step `then`; it is data, not a promise method
  then: z.object({ run: z.string() }).optional(),
});
const ListSchema = z.object({ list: z.array(z.object({ session: z.string(), source: z.string(), ended: z.string(), prompt: z.string() })) });

interface Install {
  root: string;
  home: string;
  repo: string;
  origin: string;
  dataHome: string;
  env: NodeJS.ProcessEnv;
}

const roots: string[] = [];
afterEach(async () => {
  await waitForDetachedChildren();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(install: Pick<Install, 'repo' | 'env'>, ...args: string[]): string {
  return execFileSync('git', args, { cwd: install.repo, env: install.env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** Runs the CLI under test in the checkout, as the agent of AGENT_SESSION does. */
function teamai(install: Pick<Install, 'repo' | 'env'>, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: install.repo, env: { ...install.env, CLAUDE_CODE_SESSION_ID: AGENT_SESSION }, encoding: 'utf8', timeout: 120_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The words of a literal the CLI printed, `teamai …`, whose single-quoted words hold no space. */
function wordsOf(literal: string): string[] {
  const [command, ...words] = literal.split(' ');
  expect(command, literal).toBe('teamai');
  return words.map((word) => (word.length > 1 && word.startsWith('\'') && word.endsWith('\'') ? word.slice(1, -1) : word));
}

/** Runs a literal the CLI printed: its envelope's data. */
function agentRuns(install: Install, literal: string): Record<string, unknown> {
  const result = teamai(install, wordsOf(literal));
  const line = result.stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  const answer = line === undefined ? undefined : EnvelopeSchema.parse(JSON.parse(line));
  if (answer?.data === undefined) throw new Error(`${literal}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);
  return answer.data;
}

/** An install in self mode whose origin is a local bare repository, after teamai pull. */
function selfModeInstall(): Install {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-share-from-sessions-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' };
  for (const name of ['CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'HERMES_DATA_DIR_SUFFIX', 'TEAMAI_WORKFLOW_ATTEMPT', 'TEAMAI_LAUNCHED_BY']) delete env[name];
  const base = { root, home, repo: path.join(root, 'product'), origin: path.join(root, 'origin.git'), env };
  for (const dir of [base.home, base.repo]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Tester\n\temail = tester@example.com\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
  git(base, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(base.repo, 'README.md'), 'fixture\n');
  git(base, 'add', '.');
  git(base, 'commit', '-qm', 'fixture');
  git(base, 'init', '-q', '--bare', '-b', 'main', base.origin);
  git(base, 'remote', 'add', 'origin', 'http://127.0.0.1:9/acme/product.git');
  const initialized = teamai(base, ['init', '--self', '--agent', 'claude', '--force']);
  expect(initialized.code, initialized.stderr).toBe(0);
  git(base, 'remote', 'set-url', 'origin', base.origin);
  const pulled = teamai(base, ['pull']);
  expect(pulled.code, pulled.stderr).toBe(0);
  const projects = path.join(home, '.teamai', 'projects');
  const [project, ...others] = fs.readdirSync(projects);
  if (project === undefined || others.length > 0) throw new Error(`expected one project data home in ${projects}`);
  return { ...base, dataHome: path.join(projects, project) };
}

/** What the session-start hook of `platform` would have captured of `sessionId`, whose store is `file`. */
function captured(install: Install, { platform, sessionId, file, at }: { platform: string; sessionId: string; file: string; at: Date }): void {
  fs.utimesSync(file, at, at);
  const dir = path.join(install.dataHome, 'sessions', 'captures', platform, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const captureId = `0b6f2a52-5d7e-4c7e-9a43-${platform === 'hermes' ? '00000000000b' : '00000000000a'}`;
  fs.writeFileSync(path.join(dir, `${captureId}.json`), JSON.stringify({ captureId, platform, sessionId, capturedAt: at.toISOString(),
    runMode: 'attended', agent: { v: 1, tool: { name: platform }, teamai: '1.0.0', driver: 'session' }, sessionFile: file }));
}

/** A Claude Code session and a Hermes one, both last active `idle` ago (seven hours unless given). */
function finishedSessions(install: Install, idle = 7 * HOUR): void {
  const at = new Date(Date.now() - idle);
  const claude = path.join(install.home, '.claude', 'projects', encodeCwdClaude(install.repo), `${CLAUDE_SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, [
    { type: 'user', uuid: 'u1', parentUuid: null, cwd: install.repo, sessionId: CLAUDE_SESSION, timestamp: '2026-11-04T09:00:00.000Z', message: { role: 'user', content: 'Rename the config loader' } },
    { type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: install.repo, sessionId: CLAUDE_SESSION, timestamp: '2026-11-04T09:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Renamed it.' }] } },
  ].map((record) => `${JSON.stringify(record)}\n`).join(''));
  captured(install, { platform: 'claude-code', sessionId: CLAUDE_SESSION, file: claude, at });

  const db = path.join(install.home, '.hermes', 'state.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const seconds = Math.floor(at.getTime() / 1000);
  execFileSync(String(findSqlite3()), [db, [
    'CREATE TABLE sessions (id TEXT, source TEXT, created_source TEXT, model TEXT, cwd TEXT, title TEXT, started_at REAL, ended_at REAL, last_activity_at REAL, message_count INTEGER);',
    'CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, active INTEGER, compacted INTEGER);',
    `INSERT INTO sessions VALUES ('${HERMES_SESSION}', 'cli', NULL, 'anthropic/claude-sonnet', '${install.repo}', 'Pod readiness', ${seconds - 60}, ${seconds}, ${seconds}, 2);`,
    `INSERT INTO messages VALUES (1, '${HERMES_SESSION}', 'user', 'Why does the pod restart before it is ready', NULL, NULL, NULL, ${seconds - 59}, NULL, NULL, NULL, 1, 0);`,
    `INSERT INTO messages VALUES (2, '${HERMES_SESSION}', 'assistant', 'The readiness probe fires before the cache warms up.', NULL, NULL, NULL, ${seconds - 58}, 'stop', NULL, NULL, 1, 0);`,
  ].join(' ')]);
  captured(install, { platform: 'hermes', sessionId: HERMES_SESSION, file: db, at });
}

/**
 * Runs the workflow as the agent does: the recommended start, children in a directory TeamAI names, share for the
 * session `picked` names and skip for any other, yes at each other gate. Each dispatch is worked with `work`.
 */
function shareFromSessions(install: Install, picked: string, work: (step: string, brief: string) => Record<string, unknown>, inputs = '{}'): { run: string; outcome: string; asked: string[] } {
  const [recommended] = DescribeSchema.parse(agentRuns(install, `teamai workflow start --describe ${WORKFLOW} --driver skill`)).describe.ask.question.options;
  let turn = TurnSchema.parse(agentRuns(install, recommended.start.replace('{inputs}', inputs)).turn);
  const asked: string[] = [];
  for (let call = 0; call < 40; call += 1) {
    const [action] = turn.actions;
    if (action?.kind === 'done') return { run: turn.run, outcome: action.outcome, asked };
    if (action?.kind === 'choose') {
      const question = action.question ?? '';
      if (action.about === 'gate') asked.push(question);
      const wanted = action.about === 'host' ? undefined : question.includes(' session ') && question.includes('First prompt:') ? (question.includes(picked) ? 'share' : 'skip') : 'yes';
      const option = action.options.find((one) => (wanted === undefined ? one.id === 'h1' : one.choice === wanted));
      if (option === undefined) throw new Error(`no option to pick in ${JSON.stringify(action)}`);
      turn = TurnSchema.parse(agentRuns(install, option.run).turn);
      continue;
    }
    if (action?.kind === 'dispatch') {
      turn = TurnSchema.parse(agentRuns(install, action.ack).turn);
      const brief = fs.readFileSync(action.brief, 'utf8');
      const result = /Write `([^`]+result\.json)`/.exec(brief)?.[1];
      if (result === undefined) throw new Error(`the brief of ${action.step} names no result file:\n${brief}`);
      fs.writeFileSync(result, JSON.stringify({ kind: 'output', output: work(action.step, brief) }));
      expect(agentRuns(install, action.report)).toMatchObject({ runner: { status: 'reported' } });
    }
    if (turn.then === undefined) throw new Error(`the run ended with no done action: ${JSON.stringify(turn)}`);
    turn = TurnSchema.parse(agentRuns(install, turn.then.run).turn);
  }
  throw new Error('the run did not end in 40 turns');
}

describe(`teamai's default ${WORKFLOW}`, () => {
  it.skipIf(findSqlite3() === null)('shares the one finished session the person picks, of another tool, through teamai-share-learnings without publishing it', async () => {
    const install = selfModeInstall();
    finishedSessions(install);
    const listed = ListSchema.parse(JSON.parse(teamai(install, ['session', 'list', '--finished', '--all', '--json']).stdout));
    expect(listed.list.map(({ session, source, prompt }) => ({ session, source, prompt })).sort((a, b) => a.source.localeCompare(b.source))).toEqual([
      { session: CLAUDE_SESSION, source: 'claude-code', prompt: 'Rename the config loader' },
      { session: HERMES_SESSION, source: 'hermes', prompt: 'Why does the pod restart before it is ready' },
    ]);
    const learning = path.join(install.root, 'learning.md');
    const briefs: Array<{ step: string; brief: string }> = [];

    const shared = shareFromSessions(install, HERMES_SESSION, (step, brief) => {
      briefs.push({ step, brief });
      fs.writeFileSync(learning, '---\ntitle: Delay the readiness probe until the cache is warm\n---\nThe probe fired before the cache warmed up, so the pod restarted.\n');
      return { learnings: [{ title: 'Delay the readiness probe until the cache is warm', file: learning, namespace: '' }] };
    });

    expect(shared.outcome).toBe('succeeded');
    expect(shared.asked.filter((question) => question.includes('First prompt:'))).toEqual(expect.arrayContaining([
      expect.stringContaining(`hermes session ${HERMES_SESSION}, last active `),
      expect.stringContaining(`claude-code session ${CLAUDE_SESSION}, last active `),
    ]));
    expect(shared.asked.find((question) => question.includes(HERMES_SESSION))).toContain('First prompt: Why does the pod restart before it is ready');
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.brief).toContain(`for the hermes session ${HERMES_SESSION}`);
    expect(briefs[0]?.brief).not.toContain(CLAUDE_SESSION);

    const config: LocalConfig = {
      repo: { localPath: path.join(install.repo, '.teamai'), remote: install.origin, kind: 'self' },
      username: 'Tester', scope: 'project', additionalRoles: [], projectRoot: install.repo, dataHome: install.dataHome,
    };
    const run = await readRun(config, shared.run);
    if (typeof run === 'string') throw new Error(`run ${shared.run} is ${run}`);
    const statusOf = (id: string) => run.steps.find((step) => step.id === id)?.status;
    expect(statusOf('share[0]')).toBe('succeeded');
    expect(statusOf('share[1]')).toBeUndefined();
    expect(statusOf('share[0].share-session.publish')).toBe('skipped');

    const files = git(install, '--git-dir', install.origin, 'ls-tree', '-r', '--name-only', 'teamai-learnings').split('\n').filter((file) => file.startsWith('learnings/'));
    expect(files).toEqual([expect.stringMatching(/^learnings\/delay-the-readiness-probe-until-the-cache-is-warm-/)]);
    expect(git(install, '--git-dir', install.origin, 'show', `teamai-learnings:${files[0]}`)).toContain(HERMES_SESSION);
    // teamai-reports takes the run's record; no session is archived there.
    expect(git(install, '--git-dir', install.origin, 'ls-tree', '-r', '--name-only', 'teamai-reports').split('\n').filter((file) => file.startsWith('sessions/'))).toEqual([]);

    const after = ListSchema.parse(JSON.parse(teamai(install, ['session', 'list', '--finished', '--all', '--json']).stdout));
    expect(after.list.map(({ session }) => session)).toEqual([CLAUDE_SESSION]);
  });

  it.skipIf(findSqlite3() === null)('offers sessions older than a week when the run is given a longer within', () => {
    const install = selfModeInstall();
    finishedSessions(install, 10 * 24 * HOUR);
    expect(ListSchema.parse(JSON.parse(teamai(install, ['session', 'list', '--finished', '--all', '--json']).stdout)).list).toEqual([]);
    const learning = path.join(install.root, 'learning.md');

    const shared = shareFromSessions(install, HERMES_SESSION, () => {
      fs.writeFileSync(learning, '---\ntitle: Delay the readiness probe until the cache is warm\n---\nThe probe fired before the cache warmed up.\n');
      return { learnings: [{ title: 'Delay the readiness probe until the cache is warm', file: learning, namespace: '' }] };
    }, JSON.stringify({ within: '30d' }));

    expect(shared.outcome).toBe('succeeded');
    expect(shared.asked.filter((question) => question.includes('First prompt:'))).toEqual(expect.arrayContaining([
      expect.stringContaining(`hermes session ${HERMES_SESSION}`),
      expect.stringContaining(`claude-code session ${CLAUDE_SESSION}`),
    ]));
  });
});
