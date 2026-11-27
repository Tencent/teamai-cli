import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readWorkspaceChildren } from '../workspace-children.js';
import type { LocalConfig } from '../types.js';

describe('readWorkspaceChildren: registered nested workspaces stay out of the gate (#2124)', () => {
  let tmp: string;
  let projectRoot: string;
  let dataHome: string;

  const baseConfig = (): LocalConfig => ({
    repo: { localPath: projectRoot, remote: 'https://example.invalid/t.git', kind: 'git' },
    username: 'u', scope: 'project', projectRoot, dataHome, updatePolicy: 'auto',
    additionalRoles: [], enabledAgents: ['codebuddy'],
  } as LocalConfig);

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-children-nested-'));
    projectRoot = path.join(tmp, 'project');
    dataHome = path.join(tmp, 'data-home');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(dataHome, { recursive: true });
    // A git repo, so the walk treats it as one and stops at repo boundaries.
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const register = async (checkoutRoot: string): Promise<void> => {
    const id = path.basename(checkoutRoot).replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'ws';
    const dir = path.join(dataHome, 'workspaces', `${id}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'root'), checkoutRoot);
  };

  it('leaves the config untouched when nothing is registered', async () => {
    const config = await readWorkspaceChildren(baseConfig());
    expect(config.children).toBeUndefined();
  });

  it('merges a registered nested worktree into roots (#2124)', async () => {
    const worktree = path.join(projectRoot, 'worktree', 'feature-a');
    await fs.mkdir(worktree, { recursive: true });
    await register(worktree);

    const config = await readWorkspaceChildren(baseConfig());
    const roots = config.children?.roots.map((root) => path.resolve(root)) ?? [];

    expect(roots).toContain(path.resolve(worktree));
  });

  it('merges a second nested level too', async () => {
    const nested = path.join(projectRoot, 'worktree', 'feature-a');
    const deeper = path.join(nested, 'inner-checkout');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(deeper, { recursive: true });
    await register(nested);
    await register(deeper);

    const roots = (await readWorkspaceChildren(baseConfig())).children?.roots.map((root) => path.resolve(root)) ?? [];

    expect(roots).toContain(path.resolve(nested));
    expect(roots).toContain(path.resolve(deeper));
  });

  it('ignores registered roots outside the checkout', async () => {
    const elsewhere = path.join(tmp, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await register(elsewhere);

    const config = await readWorkspaceChildren(baseConfig());
    expect(config.children).toBeUndefined();
  });

  it('ignores the workspace own root when it registers itself', async () => {
    await register(projectRoot);

    const config = await readWorkspaceChildren(baseConfig());
    expect(config.children).toBeUndefined();
  });

  it('ignores a registered root whose checkout is gone', async () => {
    const ghost = path.join(projectRoot, 'worktree', 'removed');
    await fs.mkdir(ghost, { recursive: true });
    await register(ghost);
    await fs.rm(ghost, { recursive: true, force: true });

    const config = await readWorkspaceChildren(baseConfig());
    expect(config.children).toBeUndefined();
  });

  it('skips a registry entry whose root file is gone, rather than failing (#373)', async () => {
    // A removed worktree's cleanup and uninstall leave workspaces/<id>/ behind
    // without its root file; a live one may sit beside it.
    const orphaned = path.join(dataHome, 'workspaces', 'orphaned');
    const live = path.join(projectRoot, 'worktree', 'live');
    await fs.mkdir(orphaned, { recursive: true });
    await fs.mkdir(path.join(dataHome, 'workspaces', 'no-root-file-but-a-note'), { recursive: true });
    await fs.writeFile(path.join(dataHome, 'workspaces', 'no-root-file-but-a-note', 'managed-mcp-files.json'), '{}');
    await fs.mkdir(live, { recursive: true });
    await register(live);

    const config = await readWorkspaceChildren(baseConfig());
    const roots = config.children?.roots.map((root) => path.resolve(root)) ?? [];

    expect(roots).toEqual([path.resolve(live)]);
  });

  it('skips a registry entry whose root file cannot be read', async () => {
    const locked = path.join(dataHome, 'workspaces', 'locked');
    await fs.mkdir(locked, { recursive: true });
    // A directory where the file should be: reading it fails, the entry is skipped.
    await fs.mkdir(path.join(locked, 'root'), { recursive: true });

    const live = path.join(projectRoot, 'worktree', 'live');
    await fs.mkdir(live, { recursive: true });
    await register(live);

    const config = await readWorkspaceChildren(baseConfig());
    expect(config.children?.roots.map((root) => path.resolve(root))).toEqual([path.resolve(live)]);
  });

  it('does not persist the children on disk', async () => {
    const worktree = path.join(projectRoot, 'worktree', 'feature-a');
    await fs.mkdir(worktree, { recursive: true });
    await register(worktree);

    await readWorkspaceChildren(baseConfig());
    // Nothing here is persisted: the only writes under dataHome stay the registry's.
    const written = await fs.readdir(dataHome);
    expect(written.filter((entry) => entry.includes('children'))).toEqual([]);
  });
});
