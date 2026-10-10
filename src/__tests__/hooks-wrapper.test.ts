import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { fileURLToPath } from 'node:url';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reconcileHooksToAllTools } from '../hooks.js';
import { _resetShellCache } from '../builtin-hooks.js';

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
