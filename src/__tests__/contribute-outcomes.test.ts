import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { getDataHome } from '../types.js';
import { runsDir } from '../workflow/store.js';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

let tmp: string;
let roleOf: string | undefined;
const savedEnv = { ...process.env };

function config() {
  return {
    // Not a team-repo clone, so publishing fails and the learning stays queued where the test reads it.
    repo: { localPath: path.join(tmp, 'not-a-clone'), remote: 'r', kind: 'git' as const },
    username: 'alice',
    scope: 'user' as const,
    ...(roleOf ? { primaryRole: roleOf } : {}),
    additionalRoles: [],
  };
}

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(async () => ({ localConfig: config() })),
  detectProjectConfig: vi.fn(async () => null),
  loadLocalConfigForScope: vi.fn(async () => null),
  loadTeamConfig: vi.fn(async () => null),
}));

const { contribute } = await import('../contribute.js');
const { readSessionOutcomes } = await import('../dashboard-collector.js');
const { readContributeState } = await import('../contribute-check.js');
const { writeInstallConfig } = await import('./helpers/install-config.js');

function queued(): Array<{ relPath: string; content: string }> {
  const root = path.join(tmp, 'pending-learnings');
  if (!fs.existsSync(root)) return [];
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ relPath: name.split(path.sep).join('/'), content: fs.readFileSync(path.join(root, name), 'utf8') }));
}

async function contributeNote(body: string, options: { sessionId?: string; title?: string } = {}): Promise<{ relPath: string; content: string }> {
  const note = path.join(tmp, 'note.md');
  fs.writeFileSync(note, body);
  await contribute({ scope: 'user', title: options.title ?? 'Pod startup timeouts', file: note, ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
  const [only, ...rest] = queued();
  expect(rest).toEqual([]);
  if (!only) throw new Error('contribute queued no learning');
  return only;
}

describe('a learning contributed from a session', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-outcomes-'));
    roleOf = undefined;
    process.env.HOME = path.join(tmp, 'home');
    for (const name of AGENT_SESSION_ENV) delete process.env[name];
    fs.mkdirSync(path.join(tmp, 'not-a-clone'), { recursive: true });
    fs.mkdirSync(process.env.HOME, { recursive: true });
    writeInstallConfig(config());
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('names the session it came from in its frontmatter, with the platform its session variable names', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = '7c1e-session';

    const { content } = await contributeNote('---\ntitle: Pod startup timeouts\ntags: [k8s]\n---\nRaise the probe delay.\n');

    const { data, body } = parseFrontmatter(content);
    expect(data).toEqual({ title: 'Pod startup timeouts', tags: ['k8s'], session: { platform: 'claude-code', sessionId: '7c1e-session' } });
    expect(body).toBe('Raise the probe delay.\n');
  });

  it('takes the platform from the captures of the session --session-id names, and adds frontmatter to a note that has none', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'the-calling-session';
    const captured = path.join(getDataHome(config()), 'sessions', 'captures', 'codex', 'earlier-session');
    fs.mkdirSync(captured, { recursive: true });
    const captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f10';
    fs.writeFileSync(path.join(captured, `${captureId}.json`), JSON.stringify({
      captureId, platform: 'codex', sessionId: 'earlier-session', capturedAt: '2026-10-20T10:00:00.000Z',
      agent: { v: 1, tool: { name: 'codex' }, teamai: '1.0.0', driver: 'session' },
    }));

    const { content } = await contributeNote('Raise the probe delay.\n', { sessionId: 'earlier-session' });

    expect(parseFrontmatter(content)).toEqual({ data: { session: { platform: 'codex', sessionId: 'earlier-session' } }, body: 'Raise the probe delay.\n' });
  });

  it('is recorded on this machine as an outcome of its session, by its path under learnings/ without .md, namespace included', async () => {
    fs.mkdirSync(path.join(tmp, 'not-a-clone', 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'not-a-clone', 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: ops',
      '    description: ops',
      '    resources: { knowledge: [], skills: [], agents: [], learnings: [k8s] }',
      '',
    ].join('\n'));
    roleOf = 'ops';
    process.env.CLAUDE_CODE_SESSION_ID = '7c1e-session';
    process.env.TEAMAI_MODE = 'attended';

    const { relPath } = await contributeNote('Raise the probe delay.\n');

    const [event, ...rest] = await readSessionOutcomes();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      type: 'session_outcome', sessionId: '7c1e-session', tool: 'claude', runMode: 'attended',
      outcomes: [{ kind: 'learning', id: expect.stringMatching(/^k8s\/pod-startup-timeouts-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/) }],
    });
    expect(`${event?.outcomes[0]?.kind === 'learning' ? event.outcomes[0].id : ''}.md`).toBe(relPath);
  });
});

describe('a learning contributed inside a workflow attempt', () => {
  const run = 'r0123456789abcdef';
  const attempt = 'a0000000a';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-attempt-'));
    roleOf = undefined;
    process.env.HOME = path.join(tmp, 'home');
    for (const name of AGENT_SESSION_ENV) delete process.env[name];
    fs.mkdirSync(path.join(tmp, 'not-a-clone'), { recursive: true });
    fs.mkdirSync(process.env.HOME, { recursive: true });
    writeInstallConfig(config());
    fs.mkdirSync(runsDir(config()), { recursive: true });
    fs.writeFileSync(path.join(runsDir(config()), `${run}.json`), '{}');
    process.env.TEAMAI_WORKFLOW_ATTEMPT = `${run}/${attempt}`;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is appended to the outcome file of the attempt, for the engine to put on the pass', async () => {
    const { relPath } = await contributeNote('Back off before retrying.\n', { title: 'Retry backoff' });

    const lines = fs.readFileSync(path.join(runsDir(config()), run, 'outcomes', `${attempt}.jsonl`), 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ kind: 'learning', id: relPath.replace(/\.md$/, '') }]);
  });

  it('also counts for the member session --session-id names, which the attempt that writes it did not launch', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'the-step-session';
    process.env.TEAMAI_MODE = 'unattended';

    await contributeNote('Back off before retrying.\n', { title: 'Retry backoff', sessionId: 'member-session' });

    const [event] = await readSessionOutcomes();
    expect(event?.sessionId).toBe('member-session');
    expect(event).not.toHaveProperty('launchedBy');
    expect(event).not.toHaveProperty('runMode');
  });

  it('still counts as contributed when its outcome file cannot be written', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'the-step-session';
    fs.mkdirSync(path.join(runsDir(config()), run));
    fs.writeFileSync(path.join(runsDir(config()), run, 'outcomes'), 'not a directory');

    await contributeNote('Back off before retrying.\n', { title: 'Retry backoff' });

    expect(await readContributeState('the-step-session')).toMatchObject({ contributed: true });
  });
});
