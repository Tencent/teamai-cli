import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  resolveAnchors: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { codexTeamHookCheckout, codexTeamHookProject, reconcileTeamHooksForConfig } from '../hooks.js';
import { decodeCodebuddyProjectGate, parseCodebuddyTeamGate } from '../codebuddy-team-hooks.js';
import { dispatchedCodexHooks } from '../codex-team-hooks.js';
import { runBridgedTeamHooks } from '../bridged-team-hooks.js';
import { runHookCommand } from '../hook-command.js';
import { resetBundledRuntimeCache } from '../bundled-runtime.js';
import { toolHome } from '../tool-home.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { folderVersion } from './helpers/folder-version.js';

// A team hook folder on the tools whose team hooks run through `teamai hook-dispatch --team-hooks` (#1787): each
// gets the command with the folder's delivered path in place of ${TEAMAI_HOOK_DIR}, and runs the folder's script.

const LINT = 'description: Lint\nevent: SessionStart\ncommand: bash "${TEAMAI_HOOK_DIR}/lint.sh"\n';

let home: string;
let repo: string;
let project: string;
let dataHome: string;

const forward = (dir: string): string => dir.split(path.sep).join('/');

/** A workspace bound to the team repo at `repo`, whose data home is `dataHome`. */
function workspace(): LocalConfig {
  return { repo: { localPath: repo, remote: 'acme/team' }, username: 'tester', additionalRoles: [], scope: 'project', projectRoot: project, dataHome };
}

beforeEach(async () => {
  home = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hook-folders-dispatch-')));
  repo = path.join(home, '.teamai', 'projects', 'shop', 'repo');
  project = path.join(home, 'shop');
  dataHome = path.join(home, '.teamai', 'projects', 'shop');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  execFileSync('git', ['init', '-q', project]);
  await fse.outputFile(path.join(repo, 'hooks', 'lint', 'HOOK.yaml'), LINT);
  await fse.outputFile(path.join(repo, 'hooks', 'lint', 'lint.sh'), 'echo lint from the team folder\n');
  resetWarnOnce();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetBundledRuntimeCache();
  await fse.remove(home);
});

describe('a team hook folder on CodeBuddy\'s Windows project gate', () => {
  it('carries the command with the delivered path, base64-encoded after substitution', async () => {
    // The gate needs a Git Bash; stage the one candidate under HOME so the machine's own Git does not decide.
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) vi.stubEnv(key, '');
    await fse.ensureFile(path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'));
    await fse.ensureDir(path.join(home, '.codebuddy'));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    resetBundledRuntimeCache();

    await reconcileTeamHooksForConfig({ toolPaths: { codebuddy: { settings: '.codebuddy/settings.json' } } } as unknown as TeamaiConfig, workspace());

    const settings: { hooks?: Record<string, Array<{ description?: string; hooks: Array<{ command: string }> }>> } = await fse.readJson(path.join(home, '.codebuddy', 'settings.json'));
    const entry = (settings.hooks?.SessionStart ?? []).find((candidate) => candidate.description?.startsWith('[teamai:hook:lint]'));
    const rendered = parseCodebuddyTeamGate(entry?.hooks[0]?.command ?? '');

    expect([rendered?.id, Buffer.from(rendered?.encodedCommand ?? '', 'base64url').toString('utf8'), decodeCodebuddyProjectGate(rendered?.encodedGate ?? '')?.root])
      .toEqual(['lint', `bash "${forward(dataHome)}/hooks/lint.${folderVersion(path.join(repo, 'hooks', 'lint'))}/lint.sh"`, project]);
  });

  it('keeps the folder, once the team repo drops it, while CodeBuddy, which the member excluded, keeps the entry that runs it', async () => {
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) vi.stubEnv(key, '');
    await fse.ensureFile(path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'));
    await fse.ensureDir(path.join(home, '.codebuddy'));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    resetBundledRuntimeCache();
    const codebuddyTeam = { toolPaths: { codebuddy: { settings: '.codebuddy/settings.json' } } } as unknown as TeamaiConfig;
    const script = async (): Promise<string> => {
      const settings: { hooks?: Record<string, Array<{ description?: string; hooks: Array<{ command: string }> }>> } = await fse.readJson(path.join(home, '.codebuddy', 'settings.json'));
      const entry = (settings.hooks?.SessionStart ?? []).find((candidate) => candidate.description?.startsWith('[teamai:hook:lint]'));
      const command = Buffer.from(parseCodebuddyTeamGate(entry?.hooks[0]?.command ?? '')?.encodedCommand ?? '', 'base64url').toString('utf8');

      return /bash "([^"]+)"/.exec(command)?.[1] ?? '';
    };

    await reconcileTeamHooksForConfig(codebuddyTeam, workspace());
    const installed = await script();
    await fse.remove(path.join(repo, 'hooks', 'lint'));
    await reconcileTeamHooksForConfig(codebuddyTeam, { ...workspace(), disabledAgents: ['codebuddy'] });

    expect([await script(), await fse.readFile(installed, 'utf8')]).toEqual([installed, 'echo lint from the team folder\n']);
  });
});

describe('a team hook folder on Codex, when the project\'s .codex/hooks.json is not teamai\'s', () => {
  it('runs from the dispatcher, which runs the folder\'s script from the data home', async () => {
    await fse.ensureDir(path.join(home, '.codex'));
    await fse.outputJson(path.join(project, '.codex', 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo the member\'s own' }] }] } });
    const config = workspace();

    // With gitExclude on, teamai keeps its entries out of a project file it does not own.
    const team = { toolPaths: { codex: { settings: '.codex/hooks.json' } }, sharing: { gitExclude: { enabled: true } } } as unknown as TeamaiConfig;

    await reconcileTeamHooksForConfig(team, config);

    const projectKey = await codexTeamHookProject(config);
    const dispatched = projectKey === null ? undefined : await dispatchedCodexHooks(projectKey, await codexTeamHookCheckout(config) ?? undefined);
    const ran = await Promise.all((dispatched ?? []).map(async (hook) => (await runHookCommand(hook.command, { cwd: project, timeout: 30, stdin: '' })).stdout));

    expect([dispatched?.map((hook) => [hook.id, hook.command]), ran])
      .toEqual([[['lint', `bash "${forward(dataHome)}/hooks/lint.${folderVersion(path.join(repo, 'hooks', 'lint'))}/lint.sh"`]], ['lint from the team folder\n']]);
  });
});

describe('a team hook folder on a tool whose hooks run through teamai\'s bridge', () => {
  it('runs the folder\'s script from the user data home when OpenCode starts a session', async () => {
    await fse.ensureDir(toolHome('opencode'));
    const member: LocalConfig = { repo: { localPath: repo, remote: 'acme/team' }, username: 'tester', additionalRoles: [], scope: 'user' };

    await reconcileTeamHooksForConfig({ toolPaths: { opencode: { settings: '.config/opencode/opencode.json' } } } as unknown as TeamaiConfig, member);

    const reply = await runBridgedTeamHooks('opencode', 'SessionStart', JSON.stringify({ cwd: project }));

    expect([await fse.readFile(path.join(home, '.teamai', 'hooks', `lint.${folderVersion(path.join(repo, 'hooks', 'lint'))}`, 'lint.sh'), 'utf8'), JSON.parse(reply.stdout)])
      .toEqual(['echo lint from the team folder\n', { context: 'lint from the team folder' }]);
  });
});
