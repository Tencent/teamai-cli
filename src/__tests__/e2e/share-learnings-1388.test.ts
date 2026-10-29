/**
 * Real CLI: a member's coding session shares what it taught with teamai's default teamai-share-learnings in a single-repo install,
 * driving the run with the skill driver as the session's agent does. The step runner runs `teamai contribute` for real,
 * resolved from PATH to the CLI under test, and the agent takes judge work with the `teamai score` line its step names.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readSessionOutcomes } from '../../dashboard-collector.js';
import { encodeCwdClaude } from '../../session-flow/fs.js';
import type { LocalConfig } from '../../types.js';
import { readRun } from '../../workflow/store.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const SESSION = '7c1e0000-0000-4000-8000-000000001388';
const TITLES = ['Retry the pod readiness probe', 'pnpm needs --frozen-lockfile in CI'];
const SHARE_INPUTS = { session: SESSION, source: 'claude-code', publish: false, scorers: [], judge: 'driver' };

const EnvelopeSchema = z.object({ data: z.record(z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const DescribeSchema = z.object({ describe: z.object({ ask: z.object({ question: z.object({ options: z.array(z.object({ start: z.string() })).nonempty() }) }) }) });
const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choose'), about: z.enum(['host', 'gate']), options: z.array(z.object({ run: z.string(), id: z.string().optional(), choice: z.string().optional() })) }),
  z.object({ kind: z.literal('dispatch'), step: z.string(), brief: z.string(), ack: z.string(), report: z.string() }),
  z.object({ kind: z.literal('done'), outcome: z.string() }),
]);
const EventSchema = z.object({ kind: z.string(), step: z.string().optional() }).passthrough();
const TurnSchema = z.object({
  run: z.string(), actions: z.array(ActionSchema), events: z.array(EventSchema),
  // oxlint-disable-next-line unicorn/no-thenable
  then: z.object({ run: z.string() }).optional(),
});

type Envelope = z.infer<typeof EnvelopeSchema>;
type StepWork = (step: string, brief: string) => Record<string, unknown>;

interface Install {
  root: string;
  home: string;
  repo: string;
  origin: string;
  env: NodeJS.ProcessEnv;
}

const roots: string[] = [];
afterEach(async () => {
  await waitForDetachedChildren();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(install: Install, ...args: string[]): string {
  return execFileSync('git', args, { cwd: install.repo, env: install.env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function envelopeOf(stdout: string): Envelope {
  const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (line === undefined) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

/** Runs the CLI under test in the checkout, as the member's terminal, or with `session` set, as that agent session. */
function teamai(install: Install, args: string[], session?: string): { code: number | null; stdout: string; stderr: string } {
  const env = session === undefined ? install.env : { ...install.env, CLAUDE_CODE_SESSION_ID: session };
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: install.repo, env, encoding: 'utf8', timeout: 120_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The words of a literal the CLI printed, `teamai …`, whose single-quoted words hold no space. */
function wordsOf(literal: string): string[] {
  const [command, ...words] = literal.split(' ');
  expect(command, literal).toBe('teamai');
  return words.map((word) => (word.length > 1 && word.startsWith('\'') && word.endsWith('\'') ? word.slice(1, -1) : word));
}

/** Runs a literal the CLI printed, as the agent of SESSION runs it: its envelope, which must carry data. */
function agentRuns(install: Install, literal: string): Record<string, unknown> {
  const result = teamai(install, wordsOf(literal), SESSION);
  const answer = envelopeOf(result.stdout);
  if (answer.data === undefined) throw new Error(`${literal}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);
  return answer.data;
}

function turnOf(data: Record<string, unknown>): z.infer<typeof TurnSchema> {
  return TurnSchema.parse(data.turn);
}

/**
 * A single-repo install of a new checkout whose origin is a local bare repository, with `team` (paths under `.teamai/`)
 * committed to main, after `teamai pull`.
 */
function selfModeInstall(team: Record<string, string> = {}): Install {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-share-learnings-')));
  roots.push(root);
  const install: Install = {
    root,
    home: path.join(root, 'home'),
    repo: path.join(root, 'product'),
    origin: path.join(root, 'origin.git'),
    env: { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), FORCE_COLOR: '0' },
  };
  for (const dir of [install.home, install.repo]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(install.home, '.gitconfig'), '[user]\n\tname = Tester\n\temail = tester@example.com\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
  git(install, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(install.repo, 'README.md'), 'fixture\n');
  git(install, 'add', '.');
  git(install, 'commit', '-qm', 'fixture');
  git(install, 'init', '-q', '--bare', '-b', 'main', install.origin);
  git(install, 'remote', 'add', 'origin', 'http://127.0.0.1:9/acme/product.git');
  const initialized = teamai(install, ['init', '--self', '--agent', 'claude', '--force']);
  expect(initialized.code, initialized.stderr).toBe(0);
  git(install, 'remote', 'set-url', 'origin', install.origin);
  for (const [file, text] of Object.entries(team)) {
    fs.mkdirSync(path.dirname(path.join(install.repo, '.teamai', file)), { recursive: true });
    fs.writeFileSync(path.join(install.repo, '.teamai', file), text);
  }
  if (Object.keys(team).length > 0) {
    git(install, 'add', '.teamai');
    git(install, 'commit', '-qm', 'team');
  }
  const pulled = teamai(install, ['pull']);
  expect(pulled.code, pulled.stderr).toBe(0);
  return install;
}

/**
 * Shares SESSION with teamai-share-learnings started with `inputs`, as its agent: it picks the recommended start, children that
 * work in a directory TeamAI names, and yes at the optional approval; it works each prompt step with `work`, and reports
 * what that returns. How the run ended, and every event its turns showed.
 */
function shareSession(install: Install, inputs: Record<string, unknown>, work: StepWork): { run: string; outcome: string; events: Array<z.infer<typeof EventSchema>> } {
  const [recommended] = DescribeSchema.parse(agentRuns(install, 'teamai workflow start --describe teamai-share-learnings --driver skill')).describe.ask.question.options;
  let turn = turnOf(agentRuns(install, recommended.start.replace('{inputs}', JSON.stringify(inputs))));
  const events: Array<z.infer<typeof EventSchema>> = [];
  for (let call = 0; call < 30; call += 1) {
    events.push(...turn.events);
    const [action] = turn.actions;
    if (action?.kind === 'done') return { run: turn.run, outcome: action.outcome, events };
    if (action?.kind === 'choose') {
      const picked = action.options.find((option) => (action.about === 'host' ? option.id === 'h1' : option.choice === 'yes'));
      if (picked === undefined) throw new Error(`no option to pick in ${JSON.stringify(action)}`);
      turn = turnOf(agentRuns(install, picked.run));
      continue;
    }
    if (action?.kind === 'dispatch') {
      turn = turnOf(agentRuns(install, action.ack));
      const brief = fs.readFileSync(action.brief, 'utf8');
      const result = /Write `([^`]+result\.json)`/.exec(brief)?.[1];
      if (result === undefined) throw new Error(`the brief of ${action.step} names no result file:\n${brief}`);
      fs.writeFileSync(result, JSON.stringify({ kind: 'output', output: work(action.step, brief) }));
      expect(agentRuns(install, action.report)).toMatchObject({ runner: { status: 'reported' } });
    }
    if (turn.then === undefined) throw new Error(`the run ended with no done action: ${JSON.stringify(turn)}`);
    turn = turnOf(agentRuns(install, turn.then.run));
  }
  throw new Error('the run did not end in 30 turns');
}

/** The learning step as the person shares two: each written to a file outside the repository, to the shared root. */
function sharing(install: Install): StepWork {
  return (step) => {
    expect(step).toBe('learning');
    return {
      learnings: TITLES.map((title, index) => {
        const file = path.join(install.root, `learning-${index}.md`);
        fs.writeFileSync(file, `---\ntitle: ${title}\n---\n${index === 0 ? 'Raise the readiness probe delay before retrying the rollout.' : 'Install with --frozen-lockfile so CI fails on a stale lockfile.'}\n`);
        return { title, file, namespace: '' };
      }),
    };
  };
}

/** Step `id` of `run`, which succeeded, as the run file in the data home of the install's project keeps it. */
async function succeededStep(install: Install, run: string, id: string) {
  const projects = path.join(install.home, '.teamai', 'projects');
  const [project, ...others] = fs.readdirSync(projects);
  if (project === undefined || others.length > 0) throw new Error(`expected one project data home in ${projects}`);
  const config: LocalConfig = {
    repo: { localPath: path.join(install.repo, '.teamai'), remote: install.origin, kind: 'self' },
    username: 'Tester', scope: 'project', additionalRoles: [], projectRoot: install.repo, dataHome: path.join(projects, project),
  };
  const state = await readRun(config, run);
  if (typeof state === 'string') throw new Error(`run ${run} is ${state}`);
  const step = state.steps.find((candidate) => candidate.id === id);
  if (step?.status !== 'succeeded') throw new Error(`step ${id} of run ${run} is ${step?.status ?? 'missing'}`);
  return step;
}

describe('sharing an agent session with teamai\'s default teamai-share-learnings (#1388)', () => {
  it('shares each learning with teamai contribute in a single-repo checkout after teamai pull, and leaves the checkout as it found it', () => {
    const install = selfModeInstall();
    expect(git(install, 'status', '--porcelain', '--untracked-files=all')).toBe('');

    const shared = shareSession(install, SHARE_INPUTS, sharing(install));

    // The two contribute passes run side by side, so they settle in either order.
    const contributed = shared.events.filter((event) => event.kind === 'settled' && event.step?.startsWith('contribute['))
      .sort((a, b) => String(a.step).localeCompare(String(b.step)));
    expect(contributed).toEqual([
      expect.objectContaining({ step: 'contribute[0]', outcome: 'success', exitCode: 0 }),
      expect.objectContaining({ step: 'contribute[1]', outcome: 'success', exitCode: 0 }),
    ]);
    expect(shared.outcome).toBe('succeeded');
    const files = git(install, '--git-dir', install.origin, 'ls-tree', '-r', '--name-only', 'teamai-learnings').split('\n').filter((file) => file.startsWith('learnings/')).sort();
    expect(files).toEqual([
      expect.stringMatching(/^learnings\/pnpm-needs-frozen-lockfile-in-ci-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}\.md$/),
      expect.stringMatching(/^learnings\/retry-the-pod-readiness-probe-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}\.md$/),
    ]);
    expect(git(install, '--git-dir', install.origin, 'show', `teamai-learnings:${files[1]}`)).toContain('Raise the readiness probe delay before retrying the rollout.');
    expect(git(install, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('records each shared learning on its contribute pass and as an outcome of the shared session, which is the member\'s own', async () => {
    const install = selfModeInstall();

    const shared = shareSession(install, SHARE_INPUTS, sharing(install));

    expect(shared.outcome).toBe('succeeded');
    const learnings = [...(await succeededStep(install, shared.run, 'contribute[0]')).outcomes ?? [], ...(await succeededStep(install, shared.run, 'contribute[1]')).outcomes ?? []];
    expect(learnings).toEqual([
      { kind: 'learning', id: expect.stringMatching(/^retry-the-pod-readiness-probe-/) },
      { kind: 'learning', id: expect.stringMatching(/^pnpm-needs-frozen-lockfile-in-ci-/) },
    ]);
    const ofSession = (await readSessionOutcomes(path.join(install.home, '.teamai', 'dashboard', 'events.jsonl'))).filter((event) => event.sessionId === SESSION);
    // Each contribute pass records its outcome as it settles, in either order.
    expect(ofSession).toHaveLength(2);
    expect(ofSession).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'claude', outcomes: [learnings[0]] }),
      expect.objectContaining({ tool: 'claude', outcomes: [learnings[1]] }),
    ]));
    for (const event of ofSession) expect(event).not.toHaveProperty('launchedBy');
  });

  it('ends a judging item with an empty label when teamai score refuses the lease, and the run still succeeds', async () => {
    const install = selfModeInstall({
      'scorers/review-quality.md': '---\nlabels:\n  - { value: thorough, score: 1, description: Did the work }\n  - { value: shallow, score: 0, description: Did not }\npassingScore: 0.5\nsamplingRate: 0\nmodel: fast\n---\nJudge whether the session did what the member asked.\n',
      'models/aliases.yaml': 'aliases:\n  fast:\n    codex: gpt-6-mini\n',
    });
    const transcript = path.join(install.home, '.claude', 'projects', encodeCwdClaude(install.repo), `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [
      { type: 'user', uuid: 'u1', parentUuid: null, cwd: install.repo, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries.' } },
      { type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd: install.repo, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } },
    ].map((record) => `${JSON.stringify(record)}\n`).join(''));
    const refusals: Envelope[] = [];

    const shared = shareSession(install, { ...SHARE_INPUTS, scorers: ['review-quality'] }, (step, brief) => {
      if (step === 'learning') return { learnings: [] };
      const take = /^teamai score .+$/m.exec(brief)?.[0];
      if (take === undefined) throw new Error(`the brief of ${step} names no teamai score line:\n${brief}`);
      const taken = teamai(install, wordsOf(take.replace('<your tool>', 'claude')), SESSION);
      const refusal = envelopeOf(taken.stdout);
      refusals.push(refusal);
      const empty = /If teamai answers (.+), return an empty label\./.exec(brief)?.[1]?.split(/, | or /) ?? [];
      expect(empty).toContain(refusal.error?.code);
      return { label: '' };
    });

    expect(refusals).toEqual([{ error: {
      code: 'judge_model_unavailable',
      message: 'Scorer "review-quality" asks for model alias "fast", which has no model for claude in models/aliases.yaml. Add one, or remove model from the scorer.',
    } }]);
    expect(shared.events.filter((event) => event.kind === 'settled' && event.step === 'share-session.score-driver[0]')).toEqual([{ kind: 'settled', step: 'share-session.score-driver[0]', outcome: 'success' }]);
    expect(shared.outcome).toBe('succeeded');
    expect((await succeededStep(install, shared.run, 'share-session.score-driver')).results).toEqual([
      expect.objectContaining({ item: 'review-quality', outcome: 'success', outputs: { label: '' } }),
    ]);
  });
});
