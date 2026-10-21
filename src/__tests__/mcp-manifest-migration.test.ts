import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { managedMcpManifestPath, managedMcpWorkspaceId } from '../types.js';
import { loadProjectMcpManifest } from '../utils/mcp-manifest.js';
import { writeJsonAtomic } from '../utils/fs.js';

vi.mock('../utils/fs.js', async (original) => {
  const actual = await original<typeof import('../utils/fs.js')>();
  return { ...actual, writeJsonAtomic: vi.fn(actual.writeJsonAtomic) };
});

let root: string;
afterEach(async () => {
  const actual = await vi.importActual<typeof import('../utils/fs.js')>('../utils/fs.js');
  vi.mocked(writeJsonAtomic).mockReset().mockImplementation(actual.writeJsonAtomic);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-migration-'));
  const workspace = path.join(root, 'app');
  const home = path.join(root, 'partition');
  const partition = path.join(home, 'managed-mcp.json');
  const local = path.join(workspace, '.teamai', 'managed-mcp.json');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.dirname(local), { recursive: true });
  const a = { name: 'partition-server', hash: 'a' };
  const b = { name: 'workspace-server', hash: 'b' };
  const other = { name: 'other-workspace-server', hash: 'c' };
  await fs.writeFile(partition, JSON.stringify({
    [`claude:project:${managedMcpWorkspaceId(workspace)}`]: [a],
    'claude:project:other': [other],
  }));
  await fs.writeFile(local, JSON.stringify({ 'claude:project': [b] }));
  return { workspace, home, partition, local, expected: { 'claude:project': [a, b] } };
}

describe('project MCP manifest migration', () => {
  it('keeps both legacy sources retryable when writing their combined destination fails', async () => {
    const f = await fixture();
    const before = await Promise.all([fs.readFile(f.partition, 'utf8'), fs.readFile(f.local, 'utf8')]);
    const destination = managedMcpManifestPath(f.home, f.workspace);
    const actual = await vi.importActual<typeof import('../utils/fs.js')>('../utils/fs.js');
    vi.mocked(writeJsonAtomic).mockImplementation(async (file, value) => {
      if (file === destination && JSON.stringify(value).includes('workspace-server')) {
        throw new Error('injected destination write failure');
      }
      await actual.writeJsonAtomic(file, value);
    });

    await expect(loadProjectMcpManifest(f.home, f.workspace)).rejects.toThrow('injected destination write failure');
    expect(await Promise.all([fs.readFile(f.partition, 'utf8'), fs.readFile(f.local, 'utf8')])).toEqual(before);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    vi.mocked(writeJsonAtomic).mockImplementation(actual.writeJsonAtomic);
    const retry = await loadProjectMcpManifest(f.home, f.workspace);
    expect(retry.manifest).toEqual(f.expected);
    expect(JSON.parse(await fs.readFile(destination, 'utf8'))).toEqual(f.expected);
    // Only the other worktree's record survives cleanup.
    expect(JSON.parse(await fs.readFile(f.partition, 'utf8'))).toEqual({
      'claude:project:other': [{ name: 'other-workspace-server', hash: 'c' }],
    });
    expect(JSON.parse(await fs.readFile(f.local, 'utf8'))).toEqual({});
  });

  it('merges both sources without persisting a dry run', async () => {
    const f = await fixture();
    const before = await Promise.all([fs.readFile(f.partition, 'utf8'), fs.readFile(f.local, 'utf8')]);
    expect((await loadProjectMcpManifest(f.home, f.workspace, { dryRun: true })).manifest).toEqual(f.expected);
    expect(await Promise.all([fs.readFile(f.partition, 'utf8'), fs.readFile(f.local, 'utf8')])).toEqual(before);
    expect(writeJsonAtomic).not.toHaveBeenCalled();
  });

  it('already holds both sources when legacy cleanup fails', async () => {
    const f = await fixture();
    const actual = await vi.importActual<typeof import('../utils/fs.js')>('../utils/fs.js');
    vi.mocked(writeJsonAtomic).mockImplementation(async (file, value) => {
      if (file === f.partition || file === f.local) throw new Error('injected cleanup failure');
      await actual.writeJsonAtomic(file, value);
    });
    expect((await loadProjectMcpManifest(f.home, f.workspace)).manifest).toEqual(f.expected);
    expect(writeJsonAtomic).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await fs.readFile(managedMcpManifestPath(f.home, f.workspace), 'utf8'))).toEqual(f.expected);
    vi.mocked(writeJsonAtomic).mockClear();
    expect((await loadProjectMcpManifest(f.home, f.workspace)).manifest).toEqual(f.expected);
    expect(writeJsonAtomic).not.toHaveBeenCalled();
  });
});
