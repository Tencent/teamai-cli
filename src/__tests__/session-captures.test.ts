import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIT_AT_START_PAYLOAD_KEY } from '../dashboard-collector.js';
import { CAPTURE_PAYLOAD_KEY, SessionCaptures } from '../session-flow/captures.js';
import { saveScopeSelection } from '../scope-selection.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { commitFile, fakeClaude, git, initRepo, recordDelivery } from './helpers/delivered-checkout.js';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-captures-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const SESSION = '7c1e0000-0000-4000-8000-0000000000c1';

function checkout(): { config: LocalConfig; project: string; rev: string; skill: string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-captures-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const team = path.join(root, 'team');
  const project = path.join(root, 'project');
  initRepo(team);
  initRepo(project);
  const rev = commitFile(team, 'skills/review/SKILL.md');
  commitFile(project, 'README.md');
  const skill = path.join(project, '.claude', 'skills', 'review', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'review\n');
  const config: LocalConfig = {
    repo: { localPath: team, remote: 'local', kind: 'git' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: project, dataHome: path.join(root, 'data'),
  };
  return { config, project, rev, skill };
}

function stalledVersionWriter(root: string, config: LocalConfig, payload: Record<string, unknown>): { stalled: string; go: string; exited: Promise<unknown> } {
  const stalled = path.join(root, 'stalled');
  const go = path.join(root, 'go');
  const preload = path.join(root, 'stall.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const hold = (file) => {
  if (!String(file).endsWith('.json.tmp')) return;
  fs.writeFileSync(${JSON.stringify(stalled)}, '');
  while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
};
const writeSync = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => { hold(file); return writeSync(file, ...rest); };
const write = fs.promises.writeFile;
fs.promises.writeFile = async (file, ...rest) => { hold(file); return write(file, ...rest); };
`);
  const script = path.join(root, 'writer.mts');
  fs.writeFileSync(script, `import { SessionCaptures } from ${JSON.stringify(path.resolve('src/session-flow/captures.ts'))};
await SessionCaptures.addToolVersion(${JSON.stringify(config)}, 'claude', ${JSON.stringify(payload)});
`);
  const child = spawn(process.execPath, [path.resolve('node_modules/vite-node/vite-node.mjs'), script], {
    env: { ...process.env, NODE_OPTIONS: `--require ${preload}` }, stdio: 'inherit',
  });
  return { stalled, go, exited: once(child, 'exit') };
}

async function until(file: string): Promise<void> {
  while (!fs.existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 10));
}

const start = (project: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ session_id: SESSION, cwd: project, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5', ...extra });

describe('session captures (#1178)', () => {
  it('records the team skills the checkout delivered and still holds as delivered, and no name a copy teamai did not deliver shares', async () => {
    const { config, project, skill } = checkout();
    const home = path.join(path.dirname(project), 'home');
    vi.stubEnv('HOME', home);
    commitFile(config.repo.localPath, 'skills/deploy/SKILL.md');
    const rev = commitFile(config.repo.localPath, 'skills/docs/SKILL.md');
    const copy = (root: string, name: string): string => {
      const file = path.join(root, name, 'SKILL.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${name}\n`);
      return file;
    };
    const skills = path.join(project, '.claude', 'skills');
    const deploy = copy(skills, 'deploy');
    const docs = copy(skills, 'docs');
    const outside = copy(skills, 'outside');
    await recordDelivery(config, { rev, targets: ['claude'], files: [skill, deploy, docs, outside] });
    fs.writeFileSync(deploy, 'deploy, as the member edited it\n');
    copy(path.join(home, '.claude', 'skills'), 'docs');
    copy(skills, 'mine');

    await SessionCaptures.atStart(config, 'claude', start(project), {});

    expect((await SessionCaptures.read(config, 'claude-code', SESSION)).map((capture) => capture.teamSkills)).toEqual([{ review: [skill] }]);
  });

  it('sweeps the captures of a session whose file is gone a day after they were written, and keeps the rest', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev, targets: ['claude'], files: [skill] });
    const transcript = (id: string): string => path.join(path.dirname(project), `${id}.jsonl`);
    for (const id of ['kept', 'gone']) fs.writeFileSync(transcript(id), '{}\n');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
      for (const id of ['kept', 'gone', 'unnamed']) {
        await SessionCaptures.atStart(config, 'claude', start(project, { session_id: id, ...(id === 'unnamed' ? {} : { transcript_path: transcript(id) }) }), {});
      }
      vi.useRealTimers();
      await SessionCaptures.atStart(config, 'claude', start(project, { session_id: 'fresh', transcript_path: transcript('fresh') }), {});
    } finally {
      vi.useRealTimers();
    }
    fs.rmSync(transcript('gone'));

    await SessionCaptures.sweep(config);

    expect((await Promise.all(['kept', 'gone', 'unnamed', 'fresh'].map(async (id) => [id, (await SessionCaptures.read(config, 'claude-code', id)).length]))))
      .toEqual([['kept', 1], ['gone', 0], ['unnamed', 1], ['fresh', 1]]);
    expect(fs.existsSync(path.join(config.dataHome ?? '', 'sessions', 'captures', 'claude-code', 'gone'))).toBe(false);
  });

  it('takes the project head from the git state the session start already read, and reads none itself', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev, targets: ['claude'], files: [skill] });
    const read = { head: 'c'.repeat(40), dirty: true };

    await SessionCaptures.atStart(config, 'claude', start(project, { [GIT_AT_START_PAYLOAD_KEY]: read }), {});
    await SessionCaptures.atStart(config, 'claude', start(project, { [GIT_AT_START_PAYLOAD_KEY]: null }), {});

    expect((await SessionCaptures.read(config, 'claude-code', SESSION)).map((capture) => capture.agent.project)).toEqual([{ commit: read.head, dirty: true }, undefined]);
  });

  it('captures what a Claude session starts as: the tool, the model, the checkout\'s full revision and the project head', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });

    await SessionCaptures.atStart(config, 'claude', start(project), {});

    expect(await SessionCaptures.read(config, 'claude-code', SESSION)).toEqual([{
      captureId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      platform: 'claude-code',
      sessionId: SESSION,
      capturedAt: expect.any(String),
      agent: expect.objectContaining({
        tool: { name: 'claude' },
        model: { requested: 'claude-opus-5-5' },
        team: { revision: rev, localChanges: false, selection: { scope: 'project', additionalRoles: [] } },
        project: { commit: git(project, 'rev-parse', 'HEAD'), dirty: false },
        driver: 'session',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      teamSkills: { review: [skill] },
    }]);
  });

  it('writes a second capture when the session resumes, and none for a compaction', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });

    await SessionCaptures.atStart(config, 'claude', start(project), {});
    await SessionCaptures.atStart(config, 'claude', start(project, { source: 'resume' }), {});
    await SessionCaptures.atStart(config, 'claude', start(project, { source: 'compact' }), {});

    expect(await SessionCaptures.read(config, 'claude-code', SESSION)).toHaveLength(2);
  });

  it('writes none for a session teamai launched, for a workflow step or a judge', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });

    for (const by of ['workflow', 'scorer']) await SessionCaptures.atStart(config, 'claude', start(project), { TEAMAI_LAUNCHED_BY: by });

    expect(await SessionCaptures.read(config, 'claude-code', SESSION)).toEqual([]);
  });

  it('logs a capture it cannot write at debug level, and never throws', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
    const blocked = path.join(project, 'blocked');
    fs.writeFileSync(blocked, '');
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {});
    cleanups.push(() => debug.mockRestore());

    await expect(SessionCaptures.atStart({ ...config, dataHome: blocked }, 'claude', start(project), {})).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^session capture: /));
  });

  it('adds the tool version to the capture the session start wrote, in the background pass', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
    const captureId = await SessionCaptures.atStart(config, 'claude', start(project), {});
    const [before] = await SessionCaptures.read(config, 'claude-code', SESSION);
    cleanups.push(fakeClaude(project, '2.1.308'));

    await SessionCaptures.addToolVersion(config, 'claude', { ...start(project), [CAPTURE_PAYLOAD_KEY]: captureId });

    const [after] = await SessionCaptures.read(config, 'claude-code', SESSION);
    expect(after?.agent.tool).toEqual({ name: 'claude', version: '2.1.308' });
    expect(after?.agent.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(after?.agent.fingerprint).not.toBe(before?.agent.fingerprint);
  });

  it('marks every capture of the session teamChanged when its pull delivers a new revision, and none when it does not', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
    await SessionCaptures.atStart(config, 'claude', start(project), {});
    await SessionCaptures.atStart(config, 'claude', start(project, { source: 'resume' }), {});

    const unchanged = await SessionCaptures.checkoutDelivery(config, 'claude');
    await SessionCaptures.markTeamChanged(config, 'claude', start(project), unchanged);
    expect((await SessionCaptures.read(config, 'claude-code', SESSION)).map((capture) => capture.teamChanged)).toEqual([undefined, undefined]);

    const before = await SessionCaptures.checkoutDelivery(config, 'claude');
    await recordDelivery(config, { rev: commitFile(config.repo.localPath, 'skills/other/SKILL.md'), targets: ['claude'], files: [skill] });
    await SessionCaptures.markTeamChanged(config, 'claude', start(project), before);
    expect((await SessionCaptures.read(config, 'claude-code', SESSION)).map((capture) => capture.teamChanged)).toEqual([true, true]);
  });

  it('adds the team skills the session\'s own pull delivered to its captures, and keeps the ones it started with', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev, targets: ['claude'], files: [skill] });
    const captureId = await SessionCaptures.atStart(config, 'claude', start(project), {});

    const before = await SessionCaptures.checkoutDelivery(config, 'claude');
    const deploy = path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md');
    fs.mkdirSync(path.dirname(deploy), { recursive: true });
    fs.writeFileSync(deploy, 'deploy\n');
    await recordDelivery(config, { rev: commitFile(config.repo.localPath, 'skills/deploy/SKILL.md'), targets: ['claude'], files: [skill, deploy] });
    await SessionCaptures.markTeamChanged(config, 'claude', { ...start(project), [CAPTURE_PAYLOAD_KEY]: captureId }, before);

    expect((await SessionCaptures.read(config, 'claude-code', SESSION)).map((capture) => capture.teamSkills)).toEqual([{ review: [skill], deploy: [deploy] }]);
  });

  it('adds what a resume\'s pull delivered to the resume\'s capture only, not to the captures before it', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev, targets: ['claude'], files: [skill] });
    await SessionCaptures.atStart(config, 'claude', start(project), {});
    const resumed = await SessionCaptures.atStart(config, 'claude', start(project, { source: 'resume' }), {});

    const before = await SessionCaptures.checkoutDelivery(config, 'claude');
    const deploy = path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md');
    fs.mkdirSync(path.dirname(deploy), { recursive: true });
    fs.writeFileSync(deploy, 'deploy\n');
    await recordDelivery(config, { rev: commitFile(config.repo.localPath, 'skills/deploy/SKILL.md'), targets: ['claude'], files: [skill, deploy] });
    await SessionCaptures.markTeamChanged(config, 'claude', { ...start(project, { source: 'resume' }), [CAPTURE_PAYLOAD_KEY]: resumed }, before);

    expect((await SessionCaptures.read(config, 'claude-code', SESSION)).map((capture) => capture.teamSkills))
      .toEqual([{ review: [skill] }, { review: [skill], deploy: [deploy] }]);
  });

  it('adds a team skill the session\'s own pull restored at the same revision, and leaves the captures unmarked', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev, targets: ['claude'], files: [skill] });
    fs.rmSync(path.dirname(skill), { recursive: true });
    const captureId = await SessionCaptures.atStart(config, 'claude', start(project), {});

    const before = await SessionCaptures.checkoutDelivery(config, 'claude');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, 'review\n');
    await SessionCaptures.markTeamChanged(config, 'claude', { ...start(project), [CAPTURE_PAYLOAD_KEY]: captureId }, before);

    expect((await SessionCaptures.read(config, 'claude-code', SESSION)).map(({ teamSkills, teamChanged }) => ({ teamSkills, teamChanged })))
      .toEqual([{ teamSkills: { review: [skill] }, teamChanged: undefined }]);
  });

  it('gives two members on the same revision with different roles a different selection and fingerprint', async () => {
    const { config, project, rev, skill } = checkout();
    const teamOf = async (primaryRole: string) => {
      const member = { ...config, primaryRole, dataHome: path.join(config.dataHome ?? '', primaryRole) };
      await recordDelivery(member, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
      await SessionCaptures.atStart(member, 'claude', start(project), {});
      const [captured] = await SessionCaptures.read(member, 'claude-code', SESSION);
      return captured?.agent;
    };

    const backend = await teamOf('backend');
    const frontend = await teamOf('frontend');
    expect([backend?.team?.selection?.primaryRole, frontend?.team?.selection?.primaryRole]).toEqual(['backend', 'frontend']);
    expect(backend?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(frontend?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(backend?.fingerprint).not.toBe(frontend?.fingerprint);
  });

  it('keeps the selection of the last pull after the member changes roles without pulling', async () => {
    const { config, project, rev, skill } = checkout();
    const backend = { ...config, primaryRole: 'backend' };
    await recordDelivery(backend, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
    const frontend = { ...config, primaryRole: 'frontend' };
    await saveScopeSelection(backend, frontend);

    await SessionCaptures.atStart(frontend, 'claude', start(project), {});

    const [captured] = await SessionCaptures.read(frontend, 'claude-code', SESSION);
    expect(captured?.agent.team?.selection?.primaryRole).toBe('backend');
  });

  it('marks the captures teamChanged when the session\'s pull delivers the same revision for another selection', async () => {
    const { config, project, rev, skill } = checkout();
    const backend = { ...config, primaryRole: 'backend' };
    await recordDelivery(backend, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
    await SessionCaptures.atStart(backend, 'claude', start(project), {});

    const before = await SessionCaptures.checkoutDelivery(backend, 'claude');
    await recordDelivery({ ...config, primaryRole: 'frontend' }, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
    await SessionCaptures.markTeamChanged(backend, 'claude', start(project), before);

    expect((await SessionCaptures.read(backend, 'claude-code', SESSION)).map((capture) => capture.teamChanged)).toEqual([true]);
  });

  it('marks the captures teamChanged when the session\'s pull delivers the same revision for other workspace children', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill], children: 'children-before' });
    await SessionCaptures.atStart(config, 'claude', start(project), {});

    const before = await SessionCaptures.checkoutDelivery(config, 'claude');
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill], children: 'children-after' });
    await SessionCaptures.markTeamChanged(config, 'claude', start(project), before);

    const captures = await SessionCaptures.read(config, 'claude-code', SESSION);
    expect(captures.map((capture) => capture.teamChanged)).toEqual([true]);
    expect(SessionCaptures.agentOf(captures, undefined)?.team).toBeUndefined();
  });

  it('keeps both changes when another process rewrites the session\'s captures at the same time', async () => {
    const { config, project, rev, skill } = checkout();
    await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: [skill] });
    const captureId = await SessionCaptures.atStart(config, 'claude', start(project), {});
    cleanups.push(fakeClaude(project, '2.1.308'));
    const writer = stalledVersionWriter(path.dirname(project), config, { ...start(project), [CAPTURE_PAYLOAD_KEY]: captureId });
    await until(writer.stalled);

    const before = await SessionCaptures.checkoutDelivery(config, 'claude');
    await recordDelivery(config, { rev: commitFile(config.repo.localPath, 'skills/other/SKILL.md'), targets: ['claude'], files: [skill] });
    const marked = SessionCaptures.markTeamChanged(config, 'claude', start(project), before);
    await Promise.race([marked, new Promise((resolve) => setTimeout(resolve, 1000))]);
    fs.writeFileSync(writer.go, '');
    await Promise.all([marked, writer.exited]);

    expect((await SessionCaptures.read(config, 'claude-code', SESSION)).map(({ agent, teamChanged }) => ({ version: agent.tool.version, teamChanged })))
      .toEqual([{ version: '2.1.308', teamChanged: true }]);
  }, 30_000);
});
