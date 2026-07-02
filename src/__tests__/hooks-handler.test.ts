import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseTeamHooks, HooksHandler } from '../resources/hooks.js';

let repo: string;

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
    const defs = await parseTeamHooks(repo);
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
    const defs = await parseTeamHooks(repo);
    expect(defs[0].tools).toEqual(['claude', 'cursor']);
    expect(defs[0].matcher).toBeUndefined();
  });

  it('rejects an invalid id and skips the whole file (never writes a broken set)', async () => {
    await writeHooksYaml(`
hooks:
  - id: 'Bad ID!'
    description: x
    event: Stop
    command: echo hi
`);
    expect(await parseTeamHooks(repo)).toEqual([]);
  });

  it('skips the whole file on malformed yaml', async () => {
    await writeHooksYaml(':::not yaml:::\n  - broken');
    expect(await parseTeamHooks(repo)).toEqual([]);
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

  it('countHooks counts declared team hooks', async () => {
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
    expect(await handler.countHooks(repo)).toBe(2);
  });
});
