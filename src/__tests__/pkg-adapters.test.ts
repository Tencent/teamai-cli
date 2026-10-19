import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudePluginAdapter } from '../pkg/adapters/claude-plugin.js';
import { extractNpmLockEntries, NpmAdapter } from '../pkg/adapters/npm.js';
import type { CommandExecutor } from '../utils/exec.js';

describe('NpmAdapter', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-npm-adapter-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('extracts only declared top-level packages from package-lock v3', () => {
    expect(extractNpmLockEntries({
      lockfileVersion: 3,
      packages: {
        'node_modules/typescript': {
          version: '5.9.2',
          integrity: 'sha512-ts',
          resolved: 'https://registry.test/typescript.tgz',
        },
        'node_modules/parent/node_modules/child': { version: '1.0.0' },
      },
    }, [{ name: 'typescript', version: '^5.9.0' }])).toEqual([{
      name: 'typescript',
      version: '5.9.2',
      source: 'npm',
      integrity: 'sha512-ts',
      resolved: 'https://registry.test/typescript.tgz',
    }]);
  });

  it('runs npm install with argument arrays and snapshots package-lock', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/typescript': { version: '5.9.2' },
      },
    }));
    const execute = vi.fn<CommandExecutor>().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const adapter = new NpmAdapter(execute);

    const lock = await adapter.install(
      [{ name: 'typescript', version: '^5.9.0' }],
      { cwd: dir, scope: 'project' },
    );

    expect(execute).toHaveBeenCalledWith(
      'npm',
      ['install', 'typescript@^5.9.0'],
      expect.objectContaining({ cwd: dir }),
    );
    expect(lock[0]).toMatchObject({ name: 'typescript', version: '5.9.2' });
  });

  it('does not execute npm in dry-run mode', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const execute = vi.fn<CommandExecutor>();
    await new NpmAdapter(execute).install(
      [{ name: 'is-odd', version: '*' }],
      { cwd: dir, scope: 'project', dryRun: true },
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses pnpm at a workspace member that has no pnpm markers of its own', async () => {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const member = path.join(dir, 'packages', 'app');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'package.json'), '{}');
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (command, args) => ({
      code: 0,
      stdout: command === 'pnpm' && args[0] === 'list' ? '[{"dependencies":{}}]' : '',
      stderr: '',
    }));

    await new NpmAdapter(execute).install(
      [{ name: 'is-odd', version: '*' }],
      { cwd: member, scope: 'project' },
    );

    expect(execute).toHaveBeenCalledWith(
      'pnpm',
      ['add', 'is-odd'],
      expect.objectContaining({ cwd: member }),
    );
  });

  it('respects an explicit npm packageManager over an ancestor pnpm workspace', async () => {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    const nested = path.join(dir, 'apps', 'standalone-npm-app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ packageManager: 'npm@10.8.2' }));
    fs.writeFileSync(path.join(nested, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/typescript': { version: '5.9.2' } },
    }));
    const execute = vi.fn<CommandExecutor>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await new NpmAdapter(execute).install(
      [{ name: 'is-odd', version: '*' }],
      { cwd: nested, scope: 'project' },
    );

    expect(execute).toHaveBeenCalledWith(
      'npm',
      ['install', 'is-odd'],
      expect.objectContaining({ cwd: nested }),
    );
  });

  it('passes --workspace-root when installing at the pnpm workspace root itself', async () => {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (command, args) => ({
      code: 0,
      stdout: command === 'pnpm' && args[0] === 'list' ? '[{"dependencies":{}}]' : '',
      stderr: '',
    }));

    await new NpmAdapter(execute).install(
      [{ name: 'is-odd', version: '*' }],
      { cwd: dir, scope: 'project' },
    );

    expect(execute).toHaveBeenCalledWith(
      'pnpm',
      ['add', '--workspace-root', 'is-odd'],
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('includes dev and optional dependencies when snapshotting a pnpm install', async () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (command, args) => ({
      code: 0,
      stdout: command === 'pnpm' && args[0] === 'add'
        ? ''
        : JSON.stringify([{
          dependencies: { 'is-odd': { version: '3.0.1' } },
          devDependencies: { vitest: { version: '3.2.7' } },
          optionalDependencies: { fsevents: { version: '2.3.3' } },
        }]),
      stderr: '',
    }));

    const lock = await new NpmAdapter(execute).install(
      [
        { name: 'is-odd', version: '*' },
        { name: 'vitest', version: '*' },
        { name: 'fsevents', version: '*' },
      ],
      { cwd: dir, scope: 'project' },
    );

    expect(lock).toEqual(expect.arrayContaining([
      { name: 'is-odd', version: '3.0.1', source: 'npm' },
      { name: 'vitest', version: '3.2.7', source: 'npm' },
      { name: 'fsevents', version: '2.3.3', source: 'npm' },
    ]));
  });

  it('installs CLI tools globally with their declared registry and snapshots npm list', async () => {
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (_command, args) => {
      if (args[0] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify({
            dependencies: {
              '@tencent/tokenlint': { version: '1.3.3' },
            },
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const adapter = new NpmAdapter(execute);
    const declaration = [{
      name: '@tencent/tokenlint',
      version: 'latest',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    }];

    const lock = await adapter.install(declaration, { cwd: dir, scope: 'user' });

    expect(execute).toHaveBeenCalledWith(
      'npm',
      [
        'install',
        '--global',
        '@tencent/tokenlint@latest',
        '--registry',
        'https://mirrors.tencent.com/npm/',
      ],
      expect.objectContaining({ cwd: dir }),
    );
    expect(execute).toHaveBeenCalledWith(
      'npm',
      ['list', '--global', '--depth=0', '--json'],
      expect.any(Object),
    );
    expect(lock).toEqual([{
      name: '@tencent/tokenlint',
      version: '1.3.3',
      source: 'npm',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    }]);
  });

  it('groups installs by project/global scope and registry', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/typescript': { version: '5.9.2' } },
    }));
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (_command, args) => ({
      code: 0,
      stdout: args[0] === 'list' ? '{"dependencies":{"tokenlint":{"version":"1.0.0"}}}' : '',
      stderr: '',
    }));

    await new NpmAdapter(execute).install([
      { name: 'typescript', version: '^5.9.0' },
      {
        name: 'tokenlint',
        version: '1.0.0',
        global: true,
        registry: 'https://registry.example.com/',
      },
    ], { cwd: dir, scope: 'project' });

    expect(execute).toHaveBeenCalledWith(
      'npm',
      ['install', 'typescript@^5.9.0'],
      expect.any(Object),
    );
    expect(execute).toHaveBeenCalledWith(
      'npm',
      [
        'install', '--global', 'tokenlint@1.0.0',
        '--registry', 'https://registry.example.com/',
      ],
      expect.any(Object),
    );
  });

  it('keeps global dry-run side-effect free without requiring package.json', async () => {
    const execute = vi.fn<CommandExecutor>();
    await new NpmAdapter(execute).install([{
      name: '@tencent/tokenlint',
      version: 'latest',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    }], { cwd: dir, scope: 'user', dryRun: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports an installed package whose version does not satisfy the declaration', async () => {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/typescript': { version: '4.9.5' } },
    }));

    const [status] = await new NpmAdapter().status(
      [{ name: 'typescript', version: '^5.9.0' }],
      { cwd: dir, scope: 'project' },
    );

    expect(status).toEqual({
      name: 'typescript',
      installed: false,
      version: '4.9.5',
      detail: 'declared ^5.9.0, installed 4.9.5',
    });
  });

  it('accepts an installed package that satisfies a declared range', async () => {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/typescript': { version: '5.9.2' } },
    }));

    const [status] = await new NpmAdapter().status(
      [{ name: 'typescript', version: '^5.9.0' }],
      { cwd: dir, scope: 'project' },
    );
    expect(status.installed).toBe(true);
  });
});

describe('ClaudePluginAdapter', () => {
  const declaration = {
    marketplaces: [{
      name: 'claude-plugins-official',
      repo: 'anthropics/claude-plugins-official',
      ref: 'v1.0.0',
    }],
    plugins: [{ name: 'code-review@claude-plugins-official' }],
  };

  it('orchestrates marketplace add, plugin install, and JSON snapshot', async () => {
    let marketplaceQueries = 0;
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'plugin --help') {
        return { code: 0, stdout: 'plugin help', stderr: '' };
      }
      if (args.join(' ') === 'plugin marketplace list --json') {
        marketplaceQueries++;
        return {
          code: 0,
          stdout: marketplaceQueries === 1
            ? '[]'
            : JSON.stringify([{
              name: 'claude-plugins-official',
              source: 'github',
              repo: 'anthropics/claude-plugins-official',
              installLocation: '/tmp/plugins/official',
            }]),
          stderr: '',
        };
      }
      if (args.join(' ') === 'plugin list --json') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            id: 'code-review@claude-plugins-official',
            version: '1.2.0',
            scope: 'project',
            enabled: true,
            installPath: '/tmp/plugins/code-review',
          }]),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const lock = await new ClaudePluginAdapter(execute).install(
      declaration,
      { cwd: '/tmp/project', scope: 'project' },
    );

    expect(execute).toHaveBeenCalledWith(
      'claude',
      [
        'plugin', 'marketplace', 'add',
        'anthropics/claude-plugins-official@v1.0.0',
        '--scope', 'project',
      ],
      expect.any(Object),
    );
    expect(execute).toHaveBeenCalledWith(
      'claude',
      [
        'plugin', 'install', 'code-review@claude-plugins-official',
        '--scope', 'project', '--yes',
      ],
      expect.any(Object),
    );
    expect(lock.plugins[0]).toMatchObject({
      id: 'code-review@claude-plugins-official',
      version: '1.2.0',
      enabled: true,
    });
  });

  it('does not invoke Claude CLI in dry-run mode', async () => {
    const execute = vi.fn<CommandExecutor>();
    await new ClaudePluginAdapter(execute).install(
      declaration,
      { cwd: '/tmp/project', scope: 'project', dryRun: true },
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('treats a resolved local marketplace path as the same declared source', async () => {
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'plugin --help') {
        return { code: 0, stdout: 'plugin help', stderr: '' };
      }
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            name: 'local-tools',
            source: 'directory',
            path: '/tmp/project/marketplace',
          }]),
          stderr: '',
        };
      }
      if (args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: '[]', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    await new ClaudePluginAdapter(execute).install(
      {
        marketplaces: [{ name: 'local-tools', repo: './marketplace' }],
        plugins: [],
      },
      { cwd: '/tmp/project', scope: 'project' },
    );

    expect(execute).not.toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['marketplace', 'remove']),
      expect.any(Object),
    );
    expect(execute).not.toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['marketplace', 'add']),
      expect.any(Object),
    );
  });

  it('replaces an installed marketplace when its declared ref changes', async () => {
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'plugin --help') {
        return { code: 0, stdout: 'plugin help', stderr: '' };
      }
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            name: 'claude-plugins-official',
            source: 'github',
            repo: 'anthropics/claude-plugins-official',
          }]),
          stderr: '',
        };
      }
      if (args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: '[]', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    await new ClaudePluginAdapter(execute).install(
      declaration,
      {
        cwd: '/tmp/project',
        scope: 'project',
        previousPackages: {
          claude: {
            marketplaces: [{
              name: 'claude-plugins-official',
              repo: 'anthropics/claude-plugins-official',
              ref: 'v0.9.0',
            }],
            plugins: [],
          },
        },
      },
    );

    expect(execute).toHaveBeenCalledWith(
      'claude',
      ['plugin', 'marketplace', 'remove', 'claude-plugins-official', '--scope', 'project'],
      expect.any(Object),
    );
    expect(execute).toHaveBeenCalledWith(
      'claude',
      [
        'plugin', 'marketplace', 'add',
        'anthropics/claude-plugins-official@v1.0.0',
        '--scope', 'project',
      ],
      expect.any(Object),
    );
  });

  it('records the URL emitted for git marketplaces', async () => {
    const execute = vi.fn<CommandExecutor>().mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          code: 0,
          stdout: JSON.stringify([{
            name: 'acme',
            source: 'git',
            url: 'https://github.com/acme/plugins.git',
          }]),
          stderr: '',
        };
      }
      if (args.join(' ') === 'plugin list --json') {
        return { code: 0, stdout: '[]', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const lock = await new ClaudePluginAdapter(execute).snapshot({
      marketplaces: [{ name: 'acme', repo: 'https://github.com/acme/plugins.git' }],
      plugins: [],
    });
    expect(lock.marketplaces[0]?.repo).toBe('https://github.com/acme/plugins.git');
  });

  it('marks a Claude plugin version mismatch as unhealthy', async () => {
    const execute = vi.fn<CommandExecutor>().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{
        id: 'code-review@claude-plugins-official',
        version: '1.0.0',
        scope: 'project',
        enabled: true,
      }]),
      stderr: '',
    });

    const [status] = await new ClaudePluginAdapter(execute).status(
      {
        marketplaces: [],
        plugins: [{
          name: 'code-review@claude-plugins-official',
          version: '2.0.0',
        }],
      },
      { cwd: '/tmp/project', scope: 'project' },
    );

    expect(status).toEqual({
      name: 'code-review@claude-plugins-official',
      installed: false,
      version: '1.0.0',
      enabled: true,
      detail: 'declared 2.0.0, installed 1.0.0',
    });
  });

  it('checks marketplace registration and declared source', async () => {
    const execute = vi.fn<CommandExecutor>().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        { name: 'good', source: 'github', repo: 'acme/good' },
        { name: 'wrong', source: 'git', url: 'https://github.com/acme/other.git' },
      ]),
      stderr: '',
    });

    const statuses = await new ClaudePluginAdapter(execute).marketplaceStatus(
      {
        marketplaces: [
          { name: 'good', repo: 'acme/good' },
          { name: 'wrong', repo: 'https://github.com/acme/wrong.git' },
          { name: 'missing', repo: 'acme/missing' },
        ],
        plugins: [],
      },
      { cwd: '/tmp/project', scope: 'project' },
    );

    expect(statuses).toEqual([
      { name: 'good', installed: true, detail: 'acme/good' },
      {
        name: 'wrong',
        installed: false,
        detail: 'declared https://github.com/acme/wrong.git, registered https://github.com/acme/other.git',
      },
      { name: 'missing', installed: false, detail: 'declared but not registered' },
    ]);
  });
});
