import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../agent-version.js', () => ({ getAgentVersion: vi.fn(async () => '') }));

import { injectHooks } from '../hooks.js';
import { _resetShellCache } from '../builtin-hooks.js';
import { getAgentVersion } from '../agent-version.js';
import { toolHome } from '../tool-home.js';
import { TOOLS, type ToolId } from '../tools.js';

// Byte-equality anchor for the built-in (A) hooks (issue #19 §8 "兼容锚点").
// fixtures/hooks/<tool>.json were captured from the pre-refactor injector.
// Any refactor of the injection engine MUST keep these byte-identical so that
// already-installed machines see a zero-diff reconcile after a CLI upgrade.
//
// These fixtures pin the POSIX command shape. Windows launcher rendering is
// covered separately in hooks-windows-bash.test.ts.
const fixturesDir = path.resolve(__dirname, 'fixtures', 'hooks');

const cases = [
  ['claude', 'settings.json'],
  ['claude-internal', 'settings.json'],
  ['codebuddy', 'settings.json'],
  ['codex', 'hooks.json'],
  ['cursor', 'hooks.json'],
  ['workbuddy', 'settings.json'],
];

describe('hooks golden — built-in output is byte-identical to the captured baseline', () => {
  let tmp: string;
  beforeEach(async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    _resetShellCache();
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-golden-'));
  });
  afterEach(async () => {
    _resetShellCache();
    vi.restoreAllMocks();
    await fse.remove(tmp);
  });

  for (const [tool, file] of cases) {
    it(`${tool} output matches golden fixture`, async () => {
      const p = path.join(tmp, tool, file);
      await injectHooks(p, tool);
      const got = await fse.readFile(p, 'utf-8');
      const want = await fse.readFile(path.join(fixturesDir, `${tool}.json`), 'utf-8');
      expect(got).toBe(want);
    });
  }
});

// The member's own hook file takes the form the installed version allows (builtinHookForm); only Claude Code's and Codex's change.
describe('hooks golden — the hook file in the member\'s own tool home', () => {
  let tmp: string;
  beforeEach(async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    _resetShellCache();
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-golden-home-')));
    vi.stubEnv('HOME', tmp);
  });
  afterEach(async () => {
    _resetShellCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fse.remove(tmp);
  });

  it.each([
    { tool: 'claude', version: '2.1.322', fixture: 'claude-unwaited' },
    { tool: 'claude', version: '2.1.118', fixture: 'claude-login-deferred' },
    { tool: 'claude', version: '', fixture: 'claude-login-deferred' },
    { tool: 'codex', version: '0.167.0', fixture: 'codex-unwaited' },
    { tool: 'codex', version: '0.147.0', fixture: 'codex-login-deferred' },
    { tool: 'codex', version: '', fixture: 'codex-login-deferred' },
    ...cases.filter(([tool]) => tool !== 'claude' && tool !== 'codex').map(([tool]) => ({ tool, version: '2.1.322', fixture: tool })),
  ] as Array<{ tool: ToolId; version: string; fixture: string }>)('$tool at $version matches the $fixture fixture', async ({ tool, version, fixture }) => {
    for (const move of 'moves' in TOOLS[tool].home ? TOOLS[tool].home.moves.by : []) if (move.kind === 'env') vi.stubEnv(move.name, '');
    vi.mocked(getAgentVersion).mockResolvedValue(version);
    const p = path.join(toolHome(tool), cases.find(([name]) => name === tool)?.[1] ?? '');
    expect(p.startsWith(`${tmp}${path.sep}`)).toBe(true);

    await injectHooks(p, tool);

    expect(await fse.readFile(p, 'utf-8')).toBe(await fse.readFile(path.join(fixturesDir, `${fixture}.json`), 'utf-8'));
  });
});
