import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn() },
}));

import { resolveTeamHookEntries, teamHookToDef, HooksHandler } from '../resources/hooks.js';
import type { LocalConfig } from '../types.js';

let repo: string;

function member(): LocalConfig {
  return { repo: { localPath: repo, remote: 'owner/repo' }, username: 'tester', scope: 'user', additionalRoles: [] };
}

/** The team hooks a member without roles or projects receives, or null when they do not resolve. */
async function parseTeamHooks(repoPath: string) {
  expect(repoPath).toBe(repo);
  const { resolution } = await resolveTeamHookEntries(member());
  return resolution.kind === 'resolved' ? resolution.entries.map((entry) => teamHookToDef(entry.entry.hook)) : null;
}

async function teamHookDefs() {
  const defs = await parseTeamHooks(repo);
  if (!defs) throw new Error('hooks did not resolve');
  return defs;
}

async function teamHookEntries() {
  const { resolution } = await resolveTeamHookEntries(member());
  if (resolution.kind !== 'resolved') throw new Error('hooks did not resolve');
  return resolution.entries.map((entry) => entry.entry.hook);
}

beforeEach(async () => {
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hooks-handler-'));
});
afterEach(async () => {
  await fse.remove(repo);
});

async function writeHooksYaml(content: string): Promise<void> {
  await fse.ensureDir(path.join(repo, 'hooks'));
  await fse.writeFile(path.join(repo, 'hooks', 'hooks.yaml'), content);
}

describe('parseTeamHooks', () => {
  it('returns [] when hooks/hooks.yaml is absent', async () => {
    expect(await parseTeamHooks(repo)).toEqual([]);
  });

  it('parses a valid team hook into a HookDef with the [teamai:hook:<id>] marker', async () => {
    await writeHooksYaml(`
hooks:
  - id: block-secret
    description: 扫描密钥
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "scan.sh" || true'
    timeout: 15
`);
    const defs = await teamHookDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      source: 'team',
      key: 'block-secret',
      event: 'PreToolUse',
      matcher: 'Bash',
      timeout: 15,
      description: '[teamai:hook:block-secret] 扫描密钥',
    });
  });

  it('carries an optional tools list through', async () => {
    await writeHooksYaml(`
hooks:
  - id: lint
    description: lint
    event: Stop
    command: npm run lint
    tools: [claude, cursor]
`);
    const defs = await teamHookDefs();
    expect(defs[0]?.tools).toEqual(['claude', 'cursor']);
    expect(defs[0]?.matcher).toBeUndefined();
  });

  it('keeps a (deprecated) roles list on the entry, and leaves it undefined when omitted', async () => {
    await writeHooksYaml(`
hooks:
  - id: guard-tf
    description: guard terraform apply
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/guard-tf.sh"'
    roles: [devops]
  - id: everyone
    description: for all
    event: Stop
    command: echo hi
`);
    const hooks = await teamHookEntries();
    expect(hooks[0]?.roles).toEqual(['devops']);
    expect(hooks[1]?.roles).toBeUndefined();
  });

  it('delivers no hook that carries the removed projects key', async () => {
    await writeHooksYaml(`
hooks:
  - id: checkout-lint
    description: checkout only
    event: Stop
    command: echo checkout
    projects: [checkout]
  - id: everyone
    description: for all
    event: Stop
    command: echo hi
`);
    const hooks = await teamHookEntries();
    expect(hooks.map((hook) => hook.id)).toEqual(['everyone']);
  });

  it('delivers no hook that carries projects, whatever its roles say', async () => {
    await writeHooksYaml(`
hooks:
  - id: both
    description: both axes
    event: Stop
    command: echo both
    roles: [frontend]
    projects: [checkout]
`);
    expect(await teamHookEntries()).toEqual([]);
  });

  it('rejects an invalid id and fails the whole file (never writes a broken set)', async () => {
    await writeHooksYaml(`
hooks:
  - id: 'Bad ID!'
    description: x
    event: Stop
    command: echo hi
`);
    expect(await parseTeamHooks(repo)).toBeNull();
  });

  // It parses as a mapping with no `hooks:` key, which read as no hooks and
  // removed every installed one (#822).
  it('fails the whole file on malformed yaml that parses as a mapping without hooks:', async () => {
    await writeHooksYaml(':::not yaml:::\n  - broken');
    expect(await parseTeamHooks(repo)).toBeNull();
  });

  it('fails the whole file when it is not YAML at all', async () => {
    await writeHooksYaml('hooks: [unclosed\n');
    expect(await parseTeamHooks(repo)).toBeNull();
  });
});

describe('HooksHandler', () => {
  const handler = new HooksHandler();

  it('does not reverse-push from local settings', async () => {
    const items = await handler.scanLocalForPush({} as never, { repo: { localPath: repo } } as never);
    expect(items).toEqual([]);
  });

  it('scanTeamForPull returns a single item when hooks.yaml exists', async () => {
    await writeHooksYaml('hooks: []');
    const items = await handler.scanTeamForPull({} as never, { repo: { localPath: repo } } as never);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'hooks.yaml', type: 'hooks' });
  });

  it('scanTeamForPull returns [] when hooks.yaml is absent', async () => {
    const items = await handler.scanTeamForPull({} as never, { repo: { localPath: repo } } as never);
    expect(items).toEqual([]);
  });

  it('countHooks counts the team hooks this member receives', async () => {
    await writeHooksYaml(`
hooks:
  - id: a
    description: a
    event: Stop
    command: echo a
  - id: b
    description: b
    event: Stop
    command: echo b
`);
    expect(await handler.countHooks(member())).toBe(2);
  });
});
