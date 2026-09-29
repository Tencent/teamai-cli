import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn() },
}));

import {
  readResolvedMcpFiles,
  recordUnverifiedMcpServers,
  resolvedMcpFilesPath,
  settleResolvedMcpFiles,
  trackResolvedMcpFiles,
  untrackResolvedMcpFiles,
} from '../mcp-resolved-files.js';
import { acquireLock, releaseLock } from '../update.js';
import type { LocalConfig } from '../types.js';

/** The per-worktree record of the project MCP configs teamai wrote a resolved value to (#882). */
describe('managed-mcp-files.json', () => {
  let tmp: string;
  let cfg: LocalConfig;
  let sidecar: string;
  const cursor = (): string => path.join(tmp, 'project', '.cursor', 'mcp.json');
  const custom = (): string => path.join(tmp, 'project', 'team', 'mcp.json');

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-files-'));
    cfg = {
      repo: { localPath: path.join(tmp, 'team'), remote: 'r' },
      username: 'u',
      scope: 'project',
      projectRoot: path.join(tmp, 'project'),
      dataHome: path.join(tmp, 'data'),
      additionalRoles: [],
    };
    sidecar = resolvedMcpFilesPath(cfg) ?? '';
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  it('lives next to the worktree\'s managed-mcp.json', async () => {
    const { managedMcpManifestPath } = await import('../types.js');
    expect(sidecar).toBe(path.join(path.dirname(managedMcpManifestPath(path.join(tmp, 'data'), path.join(tmp, 'project'))), 'managed-mcp-files.json'));
  });

  it.each([
    ['missing', null],
    ['not JSON', '{ "version": 1, "files": '],
    ['an array', '[]'],
    ['without files', '{ "version": 1 }'],
    ['a newer version', JSON.stringify({ version: 2, files: { '/x/mcp.json': { tools: ['claude'] } } })],
  ])('reads as no files when it is %s', async (_label, content) => {
    if (content !== null) await fse.outputFile(sidecar, content);

    expect(await readResolvedMcpFiles(cfg)).toEqual({ version: 1, files: {} });
  });

  it('drops a relative path and an entry of the wrong shape, keeping the rest', async () => {
    await fse.outputJson(sidecar, {
      version: 1,
      files: {
        'relative/mcp.json': { tools: ['cursor'] },
        [custom()]: { tools: 'cursor' },
        [path.join(tmp, 'project', '.mcp.json')]: { tools: ['claude'], unverified: ['jira', 3] },
        [cursor()]: { tools: ['cursor'], unverified: ['jira'] },
      },
    });

    expect((await readResolvedMcpFiles(cfg)).files).toEqual({ [cursor()]: { tools: ['cursor'], unverified: ['jira'] } });
  });

  it('records a file under the lock, 0600, and keeps fields it does not know', async () => {
    await fse.outputJson(sidecar, { version: 1, note: 'kept', files: { [cursor()]: { tools: ['cursor'], since: 'kept' } } });

    expect(await trackResolvedMcpFiles(cfg, [{ tool: 'claude', file: custom() }])).toBe('written');
    expect(await trackResolvedMcpFiles(cfg, [{ tool: 'claude', file: custom() }])).toBe('unchanged');

    expect(await fse.readJson(sidecar)).toEqual({
      version: 1,
      note: 'kept',
      files: { [cursor()]: { tools: ['cursor'], since: 'kept' }, [custom()]: { tools: ['claude'] } },
    });
    expect((await fse.stat(sidecar)).mode & 0o777).toBe(0o600);
  });

  it('rewrites one that does not parse from empty', async () => {
    await fse.outputFile(sidecar, '{ "version": 1, "files": ');

    expect(await trackResolvedMcpFiles(cfg, [{ tool: 'cursor', file: cursor() }])).toBe('written');

    expect(await readResolvedMcpFiles(cfg)).toEqual({ version: 1, files: { [cursor()]: { tools: ['cursor'] } } });
  });

  it('writes nothing while another command holds its lock', async () => {
    await fse.ensureDir(path.dirname(sidecar));
    const lock = `${sidecar}.teamai-lock`;
    expect(await acquireLock(lock)).toBe(true);
    try {
      expect(await trackResolvedMcpFiles(cfg, [{ tool: 'cursor', file: cursor() }])).toBe('locked');
    } finally {
      await releaseLock(lock);
    }

    expect(await fse.pathExists(sidecar)).toBe(false);
  });

  it('keeps every file five concurrent commands record', async () => {
    const files = [0, 1, 2, 3, 4].map((i) => path.join(tmp, 'project', `tool-${i}`, 'mcp.json'));

    const results = await Promise.all(files.map((file) => trackResolvedMcpFiles(cfg, [{ tool: 'cursor', file }])));

    expect(results).toEqual(['written', 'written', 'written', 'written', 'written']);
    expect(Object.keys((await readResolvedMcpFiles(cfg)).files).sort()).toEqual([...files].sort());
  });

  it('notes servers only for a file it already lists', async () => {
    await trackResolvedMcpFiles(cfg, [{ tool: 'cursor', file: cursor() }]);

    await recordUnverifiedMcpServers(cfg, [{ file: cursor(), names: ['jira'] }, { file: custom(), names: ['mine'] }]);

    expect((await readResolvedMcpFiles(cfg)).files).toEqual({ [cursor()]: { tools: ['cursor'], unverified: ['jira'] } });
  });

  it('takes back only the tool a record was added for, and the file with its last tool', async () => {
    await trackResolvedMcpFiles(cfg, [{ tool: 'claude', file: custom() }, { tool: 'codebuddy', file: custom() }, { tool: 'cursor', file: cursor() }]);

    expect(await untrackResolvedMcpFiles(cfg, [{ tool: 'codebuddy', file: custom() }, { tool: 'cursor', file: cursor() }])).toBe('written');

    expect((await readResolvedMcpFiles(cfg)).files).toEqual({ [custom()]: { tools: ['claude'] } });
    expect(await untrackResolvedMcpFiles(cfg, [{ tool: 'cursor', file: cursor() }])).toBe('unchanged');
  });

  it('writes nothing to note when a file lists no servers', async () => {
    await trackResolvedMcpFiles(cfg, [{ tool: 'cursor', file: cursor() }]);

    expect(await recordUnverifiedMcpServers(cfg, [{ file: cursor(), names: [] }])).toBe('unchanged');
  });

  describe('settling it against what the files hold', () => {
    beforeEach(async () => {
      await fse.outputJson(sidecar, {
        version: 1,
        files: {
          [cursor()]: { tools: ['cursor'], unverified: ['jira', 'mine', 'wiki'] },
          [custom()]: { tools: ['claude'] },
        },
      });
    });

    it.each([
      ['is gone', { kind: 'missing' } as const],
      ['holds no server', { kind: 'parsed', servers: [] } as const],
    ])('forgets a file that %s', async (_label, state) => {
      await settleResolvedMcpFiles(cfg, [{ file: custom(), tool: 'claude', state, holding: false, owned: [] }]);

      expect(Object.keys((await readResolvedMcpFiles(cfg)).files)).toEqual([cursor()]);
    });

    it('keeps a file that does not parse', async () => {
      await settleResolvedMcpFiles(cfg, [{ file: custom(), tool: 'claude', state: { kind: 'unparsable' }, holding: false, owned: [] }]);

      expect(Object.keys((await readResolvedMcpFiles(cfg)).files)).toContain(custom());
    });

    it('drops a noted server that left the file or that teamai owns again', async () => {
      await settleResolvedMcpFiles(cfg, [
        { file: cursor(), tool: 'cursor', state: { kind: 'parsed', servers: ['mine', 'wiki'] }, holding: true, owned: ['wiki'] },
      ]);

      expect((await readResolvedMcpFiles(cfg)).files[cursor()]).toEqual({ tools: ['cursor'], unverified: ['mine'] });
    });

    it('lists a file holding a resolved value it did not know of', async () => {
      const other = path.join(tmp, 'project', '.mcp.json');

      await settleResolvedMcpFiles(cfg, [
        { file: other, tool: 'claude', state: { kind: 'parsed', servers: ['jira'] }, holding: true, owned: ['jira'] },
      ]);

      expect((await readResolvedMcpFiles(cfg)).files[other]).toEqual({ tools: ['claude'] });
    });

    it('remembers that the files earlier teamai.yaml mappings reach were read, through later settles', async () => {
      expect((await readResolvedMcpFiles(cfg)).earlierMappingsRead).toBeUndefined();

      await settleResolvedMcpFiles(cfg, [], { earlierMappingsRead: true });
      await settleResolvedMcpFiles(cfg, [{ file: custom(), tool: 'claude', state: { kind: 'missing' }, holding: false, owned: [] }]);

      expect(await readResolvedMcpFiles(cfg)).toEqual({ version: 1, files: { [cursor()]: expect.anything() }, earlierMappingsRead: true });
    });

    it('leaves a file it does not list alone when nothing holds a value there', async () => {
      const other = path.join(tmp, 'project', '.mcp.json');

      expect(await settleResolvedMcpFiles(cfg, [
        { file: other, tool: 'claude', state: { kind: 'parsed', servers: ['open'] }, holding: false, owned: ['open'] },
      ])).toBe('unchanged');
    });
  });
});
