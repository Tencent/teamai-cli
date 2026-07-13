import { describe, it, expect, vi, beforeEach } from 'vitest';

// execFile is mocked so the npm-argument logic and error mapping can be tested
// without spawning a real npm process. The mock forwards to a mutable spy so
// each test can control the callback outcome.
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args),
}));

const {
  buildNpmInstallArgs,
  buildNpmUninstallArgs,
  installPluginPackage,
  uninstallPluginPackage,
  getInstalledPluginVersion,
} = await import('../plugin-installer.js');

beforeEach(() => {
  execFileMock.mockReset();
});

describe('plugin-installer: npm argument building', () => {
  it('installs a registry package pinned to a version', () => {
    expect(buildNpmInstallArgs({ package: 'my-plugin', version: '1.2.0' }))
      .toEqual(['install', '--global', 'my-plugin@1.2.0']);
  });

  it('installs a registry package without a version', () => {
    expect(buildNpmInstallArgs({ package: 'my-plugin' }))
      .toEqual(['install', '--global', 'my-plugin']);
  });

  it('installs a scoped registry package', () => {
    expect(buildNpmInstallArgs({ package: '@scope/plugin', version: '2.0.0' }))
      .toEqual(['install', '--global', '@scope/plugin@2.0.0']);
  });

  it('prefers a tarball path over a registry package', () => {
    expect(buildNpmInstallArgs({ package: 'my-plugin', version: '1.0.0', tarballPath: '/tmp/x.tgz' }))
      .toEqual(['install', '--global', '/tmp/x.tgz']);
  });

  it('throws when neither package nor tarball is given', () => {
    expect(() => buildNpmInstallArgs({})).toThrow(/package name or a tarball/);
  });

  it('builds uninstall args by package name', () => {
    expect(buildNpmUninstallArgs('@scope/plugin')).toEqual(['uninstall', '--global', '@scope/plugin']);
  });
});

describe('plugin-installer: npm execution', () => {
  it('resolves when npm exits successfully', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: (e: unknown, r: unknown) => void) =>
      cb(null, { stdout: 'ok', stderr: '' }));
    await expect(installPluginPackage({ package: 'p', version: '1.0.0' })).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledWith('npm', ['install', '--global', 'p@1.0.0'], expect.any(Object), expect.any(Function));
  });

  it('maps a missing npm binary to a clear error', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: (e: unknown) => void) => {
      const err = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
      cb(err);
    });
    await expect(uninstallPluginPackage('p')).rejects.toThrow(/npm not found on PATH/);
  });

  it('surfaces npm stderr on failure', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: (e: unknown) => void) => {
      cb(Object.assign(new Error('exit 1'), { stderr: '  E404 not found  ' }));
    });
    await expect(installPluginPackage({ package: 'nope', version: '9.9.9' })).rejects.toThrow(/E404 not found/);
  });
});

describe('plugin-installer: getInstalledPluginVersion', () => {
  it('returns the installed version from npm ls JSON', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb: (e: unknown, r: unknown) => void) =>
      cb(null, { stdout: JSON.stringify({ dependencies: { 'my-plugin': { version: '1.2.3' } } }), stderr: '' }));
    await expect(getInstalledPluginVersion('my-plugin')).resolves.toBe('1.2.3');
  });

  it('returns undefined when the package is absent (npm ls exits non-zero with stdout)', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb: (e: unknown) => void) =>
      cb(Object.assign(new Error('exit 1'), { code: 'ELSPROBLEMS', stdout: JSON.stringify({ dependencies: {} }) })));
    await expect(getInstalledPluginVersion('missing')).resolves.toBeUndefined();
  });

  it('throws a clear error when npm is missing', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb: (e: unknown) => void) =>
      cb(Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })));
    await expect(getInstalledPluginVersion('x')).rejects.toThrow(/npm not found on PATH/);
  });
});
