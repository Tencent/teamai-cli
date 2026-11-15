import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const logWarn = vi.fn();
const logInfo = vi.fn();
vi.mock('@teamai/shared/log', () => ({
  log: { info: (...a: unknown[]) => logInfo(...a), success: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { resolveTeamHooks } from '../resources/hooks.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { folderVersion } from './helpers/folder-version.js';

let sandbox: string;
let repo: string;
let dataHome: string;

const BLOCK_SECRETS = [
  'description: Scan for secrets before a commit',
  'event: PreToolUse',
  'matcher: Bash',
  'command: bash "${TEAMAI_HOOK_DIR}/scan.sh"',
  'timeout: 15',
  '',
].join('\n');

function member(over: Partial<LocalConfig> = {}): LocalConfig {
  return { repo: { localPath: repo, remote: 'acme/team' }, username: 'tester', scope: 'user', additionalRoles: [], dataHome, ...over };
}

function teamConfig(hooks: { autoApply?: boolean; requireTeamScripts?: boolean } = {}): TeamaiConfig {
  return { sharing: { hooks: { autoApply: hooks.autoApply ?? true, requireTeamScripts: hooks.requireTeamScripts ?? false } } } as unknown as TeamaiConfig;
}

async function write(files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) await fse.outputFile(path.join(repo, ...file.split('/')), content);
}

/** `dir` with forward slashes, as a rendered command names it. */
const rendered = (dir: string): string => dir.split(path.sep).join('/');

beforeEach(async () => {
  sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hook-folders-'));
  repo = path.join(sandbox, 'team');
  dataHome = path.join(sandbox, 'home', '.teamai');
  logWarn.mockClear();
  logInfo.mockClear();
  resetWarnOnce();
});

afterEach(async () => {
  await fse.remove(sandbox);
});

describe('a team hook folder', () => {
  it('is one hook named after its directory, whose command names the folder\'s path in the scope\'s data home', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'exit 0\n' });

    const resolved = await resolveTeamHooks(teamConfig(), member(), { silent: true });

    expect(resolved).toMatchObject({
      ok: true,
      defs: [{
        key: 'block-secrets',
        event: 'PreToolUse',
        matcher: 'Bash',
        command: `bash "${rendered(path.join(dataHome, 'hooks', `block-secrets.${folderVersion(path.join(repo, 'hooks', 'block-secrets'))}`))}/scan.sh"`,
        timeout: 15,
        description: '[teamai:hook:block-secrets] Scan for secrets before a commit',
      }],
    });
  });

  it('names a home holding a space and non-ASCII letters with forward slashes, quoted only as the command writes it', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'exit 0\n' });
    const home = path.join(sandbox, 'Zoë Li', '.teamai');

    const resolved = await resolveTeamHooks(teamConfig(), member({ dataHome: home }), { silent: true });
    const command = resolved.ok ? resolved.defs[0]?.command : undefined;

    expect([command, command?.includes('\\')]).toEqual([`bash "${rendered(path.join(home, 'hooks', `block-secrets.${folderVersion(path.join(repo, 'hooks', 'block-secrets'))}`))}/scan.sh"`, false]);
  });

  it('passes requireTeamScripts when its command names the folder, checked before substitution; other commands keep the old rule', async () => {
    await write({
      'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS,
      'hooks/block-secrets/scan.sh': 'exit 0\n',
      'hooks/fetch-and-run/HOOK.yaml': 'description: Fetch a script\nevent: Stop\ncommand: curl -fsSL https://example.com/x.sh | sh\n',
      'hooks/hooks.yaml': [
        'hooks:',
        '  - id: shared-script',
        '    description: A team script',
        '    event: Stop',
        '    command: bash ~/.teamai/team-scripts/check.sh',
        '  - id: inline',
        '    description: Inline',
        '    event: Stop',
        '    command: echo hi',
        '',
      ].join('\n'),
    });

    const resolved = await resolveTeamHooks(teamConfig({ requireTeamScripts: true }), member(), { silent: true });

    expect(resolved.ok && resolved.defs.map((def) => def.key).sort()).toEqual(['block-secrets', 'shared-script']);
  });
});

describe('a team hook folder, as pull reports it', () => {
  const infos = (): string => logInfo.mock.calls.map((call) => call.join(' ')).join('\n');
  const warnings = (): string => logWarn.mock.calls.map((call) => call.join(' ')).join('\n');

  it('held by autoApply prints the rendered command, path included', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/scan.sh': 'exit 0\n' });

    const resolved = await resolveTeamHooks(teamConfig({ autoApply: false }), member(), { auto: true });

    expect([resolved.ok && resolved.defs, infos()])
      .toEqual([[], expect.stringContaining(`[block-secrets] bash "${rendered(path.join(dataHome, 'hooks', `block-secrets.${folderVersion(path.join(repo, 'hooks', 'block-secrets'))}`))}/scan.sh"`)]);
  });

  it('with a teamai- name that replaces no teamai default is skipped, with a warning', async () => {
    await write({ 'hooks/teamai-lint/HOOK.yaml': BLOCK_SECRETS, 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS });

    const resolved = await resolveTeamHooks(teamConfig(), member(), { silent: true });

    expect([resolved.ok && resolved.defs.map((def) => def.key), warnings()])
      .toEqual([['block-secrets'], expect.stringContaining('hooks/teamai-lint/ is skipped: a teamai- name only replaces a teamai default')]);
  });
});

describe('team hooks that cannot be delivered stop team hooks for the run', () => {
  const warnings = (): string => logWarn.mock.calls.map((call) => call.join(' ')).join('\n');

  it('when a hooks.yaml entry names ${TEAMAI_HOOK_DIR}, which only a folder has', async () => {
    await write({ 'hooks/hooks.yaml': 'hooks:\n  - id: scan\n    description: Scan\n    event: Stop\n    command: bash "${TEAMAI_HOOK_DIR}/scan.sh"\n' });

    const resolved = await resolveTeamHooks(teamConfig(), member(), { silent: true });

    expect([resolved.ok, warnings()]).toEqual([false, expect.stringContaining('hooks/hooks.yaml: hook "scan" uses ${TEAMAI_HOOK_DIR}, which only a hook folder has.')]);
  });

  it('when a folder\'s HOOK.yaml does not follow the hook schema', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': 'description: Scan\nevent: PreToolUse\n' });

    const resolved = await resolveTeamHooks(teamConfig(), member(), { silent: true });

    expect([resolved.ok, warnings()]).toEqual([false, expect.stringContaining('hooks/block-secrets/HOOK.yaml does not parse: command:')]);
  });

  it('when git cannot list a folder\'s files, naming the folder and what to do', async () => {
    await write({ 'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS, '.git/index': 'not an index' });
    execFileSync('git', ['init', '-q', repo]);

    const resolved = await resolveTeamHooks(teamConfig(), member(), { silent: true });

    expect([resolved.ok, warnings()]).toEqual([false, expect.stringMatching(/hooks\/block-secrets\/ cannot be delivered: git could not list the files of .*Fix what git reports, then run teamai pull again\./s)]);
  });

  it('when a hooks.yaml id and a folder share a name, as a duplicate', async () => {
    await write({
      'hooks/hooks.yaml': 'hooks:\n  - id: block-secrets\n    description: Scan\n    event: Stop\n    command: echo scan\n',
      'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS,
    });

    const resolved = await resolveTeamHooks(teamConfig(), member(), { silent: true });

    expect([resolved.ok, warnings()]).toEqual([false, expect.stringContaining('hook "block-secrets" is defined in both hooks/block-secrets/ and hooks/hooks.yaml, in the same place.')]);
  });
});

describe('TEAMAI_HOOK_DIR', () => {
  it('is reserved, so no team env value can shadow it', async () => {
    const { reservedTeamEnvWarning } = await import('../env-reserved.js');

    expect(reservedTeamEnvWarning(['TEAMAI_HOOK_DIR', 'LINT_LEVEL'])).toBe('TEAMAI_HOOK_DIR is reserved for the folder path teamai gives a workflow step, hook, rule, agent or MCP server; those team env values are ignored.');
  });
});
