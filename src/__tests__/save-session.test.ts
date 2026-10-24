import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

const spin = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  info: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => spin),
}));

const { saveSession } = await import('../save-session.js');
const { log } = await import('../utils/logger.js');

let home: string;

function writeEvents(events: { sessionId: string; timestamp: string }[]): void {
  const dir = path.join(home, '.teamai', 'dashboard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    events.map((e) => JSON.stringify({ type: 'prompt_submit', tool: 'test', cwd: home, ...e })).join('\n') + '\n',
  );
}

/** The session `session save --dry-run` reports it would record. */
function recordedSession(): string | undefined {
  const line = vi.mocked(log.info).mock.calls.map(([msg]) => String(msg)).find((msg) => msg.startsWith('[dry-run]'));
  return /Would record session (\S+)/.exec(line ?? '')?.[1];
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-save-session-'));
  vi.stubEnv('HOME', home);
  vi.clearAllMocks();
  writeEvents([
    { sessionId: 'claudeid-session', timestamp: '2026-09-28T10:00:00.000Z' },
    { sessionId: 'pid-4242-/tmp', timestamp: '2026-09-28T10:04:00.000Z' },
  ]);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('session save default session', () => {
  it('records the agent session named by its variable', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'claudeid-session');
    await saveSession({ dryRun: true });
    expect(recordedSession()).toBe('claudeid');
  });

  it('records the most recent session when no agent variable is set', async () => {
    await saveSession({ dryRun: true });
    expect(recordedSession()).toBe('pid-4242');
  });

  // Pi's extension records its own session start, after the outer session's events (#884).
  it('records the Pi session from a Pi shell started by Claude Code', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'claudeid-session');
    vi.stubEnv('PI_SESSION_ID', 'pisession-1');
    writeEvents([
      { sessionId: 'claudeid-session', timestamp: '2026-09-28T10:00:00.000Z' },
      { sessionId: 'pisession-1', timestamp: '2026-09-28T10:05:00.000Z' },
    ]);
    await saveSession({ dryRun: true });
    expect(recordedSession()).toBe('pisessio');
  });
});

describe('session save failures', () => {
  it('exits 1 when the named session has no events', async () => {
    await saveSession({ sessionId: 'unknown-session', dryRun: true });

    expect(log.error).toHaveBeenCalledWith('No events found for session unknown-session.');
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when the team is a read-only http source', async () => {
    fs.writeFileSync(path.join(home, 'teamai.yaml'), 'team: acme\nrepo: https://example.com/team.git\nprovider: git\n');
    fs.writeFileSync(
      path.join(home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${home}\n  remote: https://example.com/team.git\n  kind: http\nusername: alice\nscope: user\nupdatePolicy: skip\nenabledAgents: [claude]\nadditionalRoles: []\n`,
    );

    await saveSession({ push: true, force: true });

    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/read-only HTTP source/));
    expect(spin.start).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('session save --push to the reports branch', () => {
  /** A team repo clone whose origin is a bare repo with no reports branch yet. */
  async function teamClone(): Promise<{ origin: string; clone: string }> {
    const seed = path.join(home, 'seed');
    fs.mkdirSync(seed);
    const seedGit = simpleGit(seed);
    await seedGit.init(['--initial-branch=main']);
    await seedGit.addConfig('user.email', 't@t.com');
    await seedGit.addConfig('user.name', 't');
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
    await seedGit.add(['.']);
    await seedGit.commit('init knowledge');
    const origin = path.join(home, 'origin.git');
    await simpleGit().clone(seed, origin, ['--bare']);
    const clone = path.join(home, 'team-repo');
    await simpleGit().clone(origin, clone);
    await simpleGit(clone).addConfig('user.email', 't@t.com');
    await simpleGit(clone).addConfig('user.name', 't');
    fs.writeFileSync(path.join(clone, 'teamai.yaml'), `team: acme\nrepo: ${origin}\nprovider: git\n`);
    fs.writeFileSync(
      path.join(home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${clone}\n  remote: ${origin}\n  kind: git\nusername: alice\nscope: user\nupdatePolicy: skip\nenabledAgents: [claude]\nadditionalRoles: []\n`,
    );
    return { origin, clone };
  }

  it('reports a failed reports commit as a failed push, not as nothing to push', async () => {
    const { origin, clone } = await teamClone();
    // git holds this lock while it moves the branch, so a commit to the branch fails.
    fs.writeFileSync(path.join(clone, '.git', 'refs', 'heads', 'teamai-reports.lock'), '');

    await saveSession({ push: true, force: true });

    expect(spin.info).not.toHaveBeenCalled();
    expect(spin.succeed).not.toHaveBeenCalled();
    expect(spin.fail).toHaveBeenCalledWith(expect.stringMatching(/^Team push failed: .*teamai-reports\.lock/s));
    expect(log.info).toHaveBeenCalledWith('The local log was still saved. Retry later with: teamai session save --push');
    expect(process.exitCode).toBe(1);
    const heads = await simpleGit(origin).raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    expect(heads.split('\n')).not.toContain('teamai-reports');
  });

  it('reports a push blocked by another reports write as not pushed', async () => {
    await teamClone();
    // Another live teamai process holds the reports lock beside the worktree.
    fs.writeFileSync(
      path.join(home, '.reports-lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'other-write' }),
    );

    await saveSession({ push: true, force: true });

    expect(spin.info).not.toHaveBeenCalled();
    expect(spin.succeed).not.toHaveBeenCalled();
    expect(spin.fail).toHaveBeenCalledWith(
      'Team push failed: another teamai write holds the team reports branch, so the session summary was not pushed.',
    );
    expect(log.info).toHaveBeenCalledWith('The local log was still saved. Retry later with: teamai session save --push');
    expect(process.exitCode).toBe(1);
  });

  it('pushes on retry the summary a refused push left committed', async () => {
    const { origin } = await teamClone();
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await saveSession({ sessionId: 'claudeid-session', push: true, force: true });
    expect(log.info).toHaveBeenCalledWith('The local log was still saved. Retry later with: teamai session save --push');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    process.exitCode = undefined;
    vi.clearAllMocks();

    await saveSession({ sessionId: 'claudeid-session', push: true, force: true });

    expect(spin.succeed).toHaveBeenCalledWith('Pushed: sessions/alice/2026-09.md');
    expect(process.exitCode).toBeUndefined();
    expect(await simpleGit(origin).show(['teamai-reports:sessions/alice/2026-09.md'])).toContain('<!-- teamai:session claudeid-session -->');
  });

  it('exits cleanly when the summary is already on the team reports branch', async () => {
    const { origin } = await teamClone();
    await saveSession({ push: true, force: true });
    expect(spin.succeed).toHaveBeenCalledWith(expect.stringMatching(/^Pushed: /));
    vi.clearAllMocks();

    await saveSession({ push: true, force: true });

    expect(spin.info).toHaveBeenCalledWith('Session already present in the team log — nothing to push.');
    expect(spin.fail).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const heads = await simpleGit(origin).raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    expect(heads.split('\n')).toContain('teamai-reports');
  });
});
