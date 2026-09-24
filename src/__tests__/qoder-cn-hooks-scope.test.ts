import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { reconcileTeamHooksForConfig } from '../hooks.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * Qoder CN shares its PROJECT-scope layout with the international Qoder
 * (`<root>/.qoder/`) and differs only in its USER-scope directory (`~/.qoder-cn`
 * instead of `~/.qoder`). The hook entry points must therefore reconcile the
 * *scoped* path table: anything that iterates the raw `teamConfig.toolPaths`
 * writes a CN user's hooks into the international build's `~/.qoder/settings.json`
 * — the same class of bug this PR fixes, mirrored.
 *
 * These tests drive the real derivation (`TeamaiConfigSchema` → `scopedToolPaths()`
 * → `reconcileTeamHooksForConfig`) instead of a hand-written path table, so all
 * four supporting changes are load-bearing: dropping `userScope.settings`, its
 * splice in `scopedToolPaths()`, or reverting the `scopedToolPaths()` call in
 * `hooks.ts` back to `teamConfig.toolPaths` turns the user-scope test red.
 */
describe('Qoder CN hooks route by scope', () => {
  let home: string;
  let project: string;
  let repo: string;

  // The shipped config table rather than a fixture: the `qoder-cn` paths under
  // test are the ones the CLI actually resolves.
  const teamConfig = (): TeamaiConfig => TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

  const userLocalConfig = (): LocalConfig => ({
    repo: { localPath: repo, remote: 'test/repo' },
    username: 'u',
    scope: 'user',
    additionalRoles: [],
  } as unknown as LocalConfig);

  // Self single-repo mode roots the hook base dir at projectRoot
  // (`resolveHookScope`), which is where a project-scope layout is observable
  // on disk; a non-self project scope would resolve its base dir to HOME.
  const selfLocalConfig = (): LocalConfig => ({
    repo: { localPath: repo, remote: 'test/repo', kind: 'self', businessRepoRoot: project },
    username: 'u',
    scope: 'project',
    projectRoot: project,
    additionalRoles: [],
  } as unknown as LocalConfig);

  const cnUserSettings = (): string => path.join(home, '.qoder-cn', 'settings.json');
  const intlUserSettings = (): string => path.join(home, '.qoder', 'settings.json');
  const cnProjectSettings = (): string => path.join(project, '.qoder', 'settings.json');
  const cnProjectUserDirSettings = (): string => path.join(project, '.qoder-cn', 'settings.json');

  /** Every `command` string in a tool settings file, whatever nesting it uses. */
  function commandStrings(node: unknown): string[] {
    if (Array.isArray(node)) return node.flatMap(commandStrings);
    if (node && typeof node === 'object') {
      return Object.entries(node as Record<string, unknown>)
        .flatMap(([key, value]) => (key === 'command' && typeof value === 'string' ? [value] : commandStrings(value)));
    }
    return [];
  }

  const writesQoderCnHooks = async (file: string): Promise<boolean> =>
    (await commandStrings(await fse.readJson(file))).some((command) => command.includes('--tool qoder-cn'));

  beforeEach(async () => {
    home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-qcn-home-'));
    project = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-qcn-proj-'));
    repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-qcn-repo-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(home);
    await fse.remove(project);
    await fse.remove(repo);
  });

  it('user scope: ~/.qoder-cn/settings.json, never the international ~/.qoder/settings.json', async () => {
    // Both builds are installed. The CN hooks must reach the CN file only; the
    // international file is a different product's config and must stay absent.
    await fse.ensureDir(path.join(home, '.qoder-cn'));
    await fse.ensureDir(path.join(home, '.qoder'));

    await reconcileTeamHooksForConfig(teamConfig(), userLocalConfig(), { filterAgents: ['qoder-cn'] });

    // Asserted as one pair: on the pre-fix layout this reports the full
    // { CN file: false, international file: true } swap in a single diff.
    expect({
      cnFile: await fse.pathExists(cnUserSettings()),
      internationalFile: await fse.pathExists(intlUserSettings()),
    }).toEqual({ cnFile: true, internationalFile: false });
    expect(await writesQoderCnHooks(cnUserSettings())).toBe(true);
  });

  it('project scope: <projectRoot>/.qoder/settings.json, never .qoder-cn/', async () => {
    await fse.ensureDir(path.join(project, '.qoder'));

    await reconcileTeamHooksForConfig(teamConfig(), selfLocalConfig(), { filterAgents: ['qoder-cn'] });

    expect(await fse.pathExists(cnProjectSettings())).toBe(true);
    expect(await writesQoderCnHooks(cnProjectSettings())).toBe(true);
    // The CN user directory is a user-scope location, not a project one.
    expect(await fse.pathExists(cnProjectUserDirSettings())).toBe(false);
    expect(await fse.pathExists(cnUserSettings())).toBe(false);
  });

  // Qoder and Qoder CN share ONE project-scope hook file, so with both targets
  // enabled (the default: no --agent whitelist) the file must be reconciled once
  // — for Qoder, the target that owns `<root>/.qoder/` — instead of the later
  // `qoder-cn` pass re-rendering every built-in with `--tool qoder-cn` and
  // dropping Qoder's tool-scoped team hooks. The single-target pass above still
  // targets the file as `qoder-cn`, because nothing else claims it there.
  it('project scope: a file shared with Qoder is reconciled once, as Qoder', async () => {
    await fse.ensureDir(path.join(project, '.qoder'));
    await fse.ensureDir(path.join(repo, 'hooks'));
    await fse.writeFile(path.join(repo, 'hooks', 'hooks.yaml'), `
hooks:
  - id: qoder-only
    description: qoder only hook
    event: Stop
    matcher: "*"
    command: echo QODER_ONLY_PAYLOAD
    tools: [qoder]
`);

    // No filterAgents: every configured target, exactly what pull/init do.
    await reconcileTeamHooksForConfig(teamConfig(), selfLocalConfig());

    const commands = commandStrings(await fse.readJson(cnProjectSettings()));
    expect(commands.some((command) => /--tool qoder(?![-\w])/.test(command))).toBe(true);
    expect(commands.some((command) => command.includes('--tool qoder-cn'))).toBe(false);
    // The tool-scoped team hook survives, because its owning target wrote the file.
    expect(commands.some((command) => command.includes('QODER_ONLY_PAYLOAD'))).toBe(true);
  });
});
