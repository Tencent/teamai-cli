import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { fileURLToPath } from 'node:url';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const recordedNode = vi.hoisted(() => ({ path: null as string | null }));

// The Node the wrapper records: the bundled runtime's when a test names one, as WorkBuddy's would be.
vi.mock('../bundled-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bundled-runtime.js')>();

  return { ...actual, resolveWorkbuddyNode: () => recordedNode.path ?? actual.resolveWorkbuddyNode() };
});

import { spawnSync } from 'node:child_process';
import { reconcileHooksToAllTools } from '../hooks.js';
import { _resetShellCache, ensureTeamaiWrapper } from '../builtin-hooks.js';
import { gitHookCommand } from '../git-hook.js';

// Verify that reconcileHooksToAllTools (the pull/init main path) creates the
// teamai wrapper at $HOME/.teamai/bin/teamai when workbuddy or codebuddy is present.
//
// resolveTeamaiEntryScript() looks for index.js next to builtin-hooks.ts, which
// only the built bundle has. The tests report src/index.js as present instead
// of writing it: while a real src/index.js exists, every test file importing
// '../index.js' in parallel loads that file instead of src/index.ts.

const srcDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entryScript = path.join(srcDir, 'index.js');

function pretendEntryScriptExists(): void {
  const existsSync = fs.existsSync;
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => file === entryScript || existsSync(file));
}

describe('reconcileHooksToAllTools — wrapper creation on main inject path', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-wrapper-'));
    origHome = process.env.HOME;
    process.env.HOME = tmp;

    pretendEntryScriptExists();
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await fse.remove(tmp);
    vi.restoreAllMocks();
  });

  // Claude Code: its login-deferred hook entry starts teamai through the wrapper.
  for (const tool of ['workbuddy', 'codebuddy', 'claude']) {
    it(`creates wrapper when ${tool} is in toolPaths`, async () => {
      const settingsFile = `.${tool}/settings.json`;
      const toolRoot = path.join(tmp, `.${tool}`);
      await fse.ensureDir(toolRoot);

      const toolPaths: Record<string, { settings?: string }> = {
        [tool]: { settings: settingsFile },
      };

      await reconcileHooksToAllTools(toolPaths, tmp, [], path.join(tmp, 'managed-hooks.json'), {});

      const wrapperPath = path.join(tmp, '.teamai', 'bin', 'teamai');
      expect(await fse.pathExists(wrapperPath)).toBe(true);

      const wrapperContent = await fse.readFile(wrapperPath, 'utf-8');
      expect(wrapperContent).toContain('exec');
      expect(wrapperContent).toContain('index.js');
    });
  }

  it('does not throw when neither workbuddy nor codebuddy is present', async () => {
    const toolPaths: Record<string, { settings?: string }> = {
      claude: { settings: '.claude/settings.json' },
    };
    await fse.ensureDir(path.join(tmp, '.claude'));

    await expect(
      reconcileHooksToAllTools(toolPaths, tmp, [], path.join(tmp, 'managed-hooks.json'), {}),
    ).resolves.not.toThrow();
  });
});

describe('reconcileHooksToAllTools — wrapper creation on main inject path', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-wrapper-'));
    origHome = process.env.HOME;
    process.env.HOME = tmp;

    pretendEntryScriptExists();
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await fse.remove(tmp);
    vi.restoreAllMocks();
  });

  for (const tool of ['workbuddy', 'codebuddy']) {
    it(`creates wrapper when ${tool} is in toolPaths`, async () => {
      const settingsFile = `.${tool}/settings.json`;
      const toolRoot = path.join(tmp, `.${tool}`);
      await fse.ensureDir(toolRoot);

      const toolPaths: Record<string, { settings?: string }> = {
        [tool]: { settings: settingsFile },
      };

      await reconcileHooksToAllTools(toolPaths, tmp, [], path.join(tmp, 'managed-hooks.json'), {});

      const wrapperPath = path.join(tmp, '.teamai', 'bin', 'teamai');
      expect(await fse.pathExists(wrapperPath)).toBe(true);

      const wrapperContent = await fse.readFile(wrapperPath, 'utf-8');
      expect(wrapperContent).toContain('exec');
      expect(wrapperContent).toContain('index.js');
    });
  }

  it('does not throw when neither workbuddy nor codebuddy is present', async () => {
    const toolPaths: Record<string, { settings?: string }> = {
      claude: { settings: '.claude/settings.json' },
    };
    await fse.ensureDir(path.join(tmp, '.claude'));

    await expect(
      reconcileHooksToAllTools(toolPaths, tmp, [], path.join(tmp, 'managed-hooks.json'), {}),
    ).resolves.not.toThrow();
  });
});

describe('reconcileHooksToAllTools — teamai.cmd wrapper (win32)', () => {
  let tmp: string;
  let origHome: string | undefined;
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-wrapper-cmd-'));
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    _resetShellCache();

    pretendEntryScriptExists();
  });

  afterEach(async () => {
    platformSpy.mockRestore();
    _resetShellCache();
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await fse.remove(tmp);
    vi.restoreAllMocks();
  });

  it('writes teamai.cmd next to the POSIX shim so cmd.exe can resolve it', async () => {
    await fse.ensureDir(path.join(tmp, '.codebuddy'));

    await reconcileHooksToAllTools(
      { codebuddy: { settings: '.codebuddy/settings.json' } },
      tmp,
      [],
      path.join(tmp, 'managed-hooks.json'),
      {},
    );

    const cmdWrapper = path.join(tmp, '.teamai', 'bin', 'teamai.cmd');
    expect(await fse.pathExists(cmdWrapper)).toBe(true);
    const content = await fse.readFile(cmdWrapper, 'utf-8');
    expect(content).toContain('@echo off');
    expect(content).toContain('index.js');
    // The POSIX shim stays in place for the tools whose runner is a POSIX shell.
    expect(await fse.pathExists(path.join(tmp, '.teamai', 'bin', 'teamai'))).toBe(true);
  });
});

// A hook command that deferred its login shell (TEAMAI_HOOK_LOGIN=deferred) runs this wrapper. When the Node or the
// entry it records is gone, it runs teamai as a login shell finds it, once; without the marker it is what it was.
describe.skipIf(process.platform === 'win32')('the wrapper a hook that deferred its login shell runs', () => {
  let tmp: string;
  let fakeBin: string;
  let record: string;

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-wrapper-deferred-')));
    fakeBin = path.join(tmp, 'fakebin');
    record = path.join(tmp, 'record');
    await fse.ensureDir(fakeBin);
    await fse.ensureDir(record);
    vi.stubEnv('HOME', tmp);
    pretendEntryScriptExists();
    for (const name of ['bash', 'node']) {
      await fse.writeFile(path.join(fakeBin, name), [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "$RECORD/${name}-argv"`,
        `printf %s "\${TEAMAI_HOOK_LOGIN-unset} \${TEAMAI_WRAPPER_FALLBACK-unset} $PATH" > "$RECORD/${name}-env"`,
        'exit 7',
        '',
      ].join('\n'), { mode: 0o755 });
    }
  });

  afterEach(async () => {
    recordedNode.path = null;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fse.remove(tmp);
  });

  const written = (node: string): string => {
    recordedNode.path = node;
    const binDir = ensureTeamaiWrapper();
    if (binDir === null) throw new Error('the wrapper was not written');

    return path.join(binDir, 'teamai');
  };
  const run = (command: string[], env: NodeJS.ProcessEnv) => spawnSync(command[0], command.slice(1), {
    env: { HOME: tmp, RECORD: record, PATH: `${path.join(tmp, '.teamai', 'bin')}:${fakeBin}:/usr/bin:/bin`, ...env }, encoding: 'utf8',
  });
  const recorded = (name: string): { argv: string[]; env: string } | null => (fs.existsSync(path.join(record, `${name}-argv`))
    ? { argv: fs.readFileSync(path.join(record, `${name}-argv`), 'utf8').split('\n').slice(0, -1), env: fs.readFileSync(path.join(record, `${name}-env`), 'utf8') }
    : null);
  const HOOK = ['hook-dispatch', 'post-tool-use', '--tool', 'claude'];

  it('runs teamai as a login shell finds it when its Node is gone, without the marker and without its own directory on PATH', () => {
    const wrapper = written(path.join(tmp, 'gone', 'node'));

    expect(run(['/bin/sh', wrapper, ...HOOK], { TEAMAI_HOOK_LOGIN: 'deferred' }).status).toBe(7);
    expect(recorded('bash')).toEqual({ argv: ['-lc', 'exec teamai "$@"', 'teamai', ...HOOK], env: `unset 1 ${fakeBin}:/usr/bin:/bin` });
  });

  it('exits 127 instead of looping when that login shell finds the wrapper again', () => {
    const wrapper = written(path.join(tmp, 'gone', 'node'));

    expect(run(['/bin/sh', wrapper, ...HOOK], { TEAMAI_HOOK_LOGIN: 'deferred', TEAMAI_WRAPPER_FALLBACK: '1' }).status).toBe(127);
    expect(recorded('bash')).toBeNull();
  });

  it('only runs its recorded Node, as before, without the marker', () => {
    const wrapper = written(path.join(tmp, 'gone', 'node'));

    expect(run(['/bin/sh', wrapper, ...HOOK], {}).status).not.toBe(0);
    expect(recorded('bash')).toBeNull();
  });

  it('keeps the file it already wrote when nothing in it changed, and replaces it when its Node did', () => {
    const wrapper = written(path.join(fakeBin, 'node'));
    const first = fs.statSync(wrapper).ino;

    expect(fs.statSync(written(path.join(fakeBin, 'node'))).ino).toBe(first);
    fs.chmodSync(wrapper, 0o644);
    expect(fs.statSync(written(path.join(fakeBin, 'node'))).mode & 0o111).not.toBe(0);
    written(path.join(tmp, 'other', 'node'));
    expect(fs.readFileSync(wrapper, 'utf8')).toContain(path.join(tmp, 'other', 'node'));
  });

  it('takes the git hook to teamai with its arguments', () => {
    const wrapper = written(path.join(fakeBin, 'node'));
    const command = gitHookCommand('post-checkout');

    // Git runs a configured hook command as `sh -c '<command> "$@"' <command> <args>`.
    expect(run(['/bin/sh', '-c', `${command} "$@"`, command, 'old', 'new', '1'], {}).status).toBe(0);
    expect(recorded('node')?.argv).toEqual([fs.readFileSync(wrapper, 'utf8').match(/exec "[^"]+" "([^"]+)" "\$@"/)?.[1], 'hook-dispatch', 'post-checkout', '--tool', 'git', 'old', 'new', '1']);
  });
});
