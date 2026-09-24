import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { DocsHandler } from '../resources/docs.js';
import { type LocalConfig, type TeamaiConfig } from '../types.js';
import { log } from '../utils/logger.js';

describe('docs pruning (#794)', () => {
  let root: string;
  let source: string;
  let destination: string;
  let team: TeamaiConfig;
  let local: LocalConfig;
  const handler = new DocsHandler();
  const sync = () => handler.pullItem({
    type: 'docs', name: 'docs', relativePath: 'docs/', sourcePath: source,
  }, team, local);

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-docs-prune-'));
    source = path.join(root, 'repo', 'docs');
    destination = path.join(root, 'home', 'docs');
    await fse.ensureDir(source);
    await fse.ensureDir(destination);
    vi.stubEnv('HOME', path.join(root, 'home'));
    team = { sharing: { docs: { localDir: destination } } } as TeamaiConfig;
    local = { scope: 'user', repo: { localPath: path.join(root, 'repo') } } as LocalConfig;
    vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  it('mirrors the team bundle by default, removing existing local residue', async () => {
    await fse.outputFile(path.join(source, 'guide.md'), 'new');
    await fse.outputFile(path.join(destination, 'draft.md'), 'local');
    await sync();
    expect(await fse.pathExists(path.join(destination, 'draft.md'))).toBe(false);
    expect(await fse.readFile(path.join(destination, 'guide.md'), 'utf8')).toBe('new');
  });

  it('copies updates and removes deleted and renamed files, including nested directories', async () => {
    await fse.outputFile(path.join(source, 'guide.md'), 'old');
    await fse.outputFile(path.join(source, 'nested', 'old.md'), 'old');
    await sync();
    await fse.remove(path.join(source, 'nested'));
    await fse.outputFile(path.join(source, 'guide.md'), 'new');
    await fse.outputFile(path.join(source, 'renamed', 'new.md'), 'new');
    await sync();
    expect(await fse.readFile(path.join(destination, 'guide.md'), 'utf8')).toBe('new');
    expect(await fse.readFile(path.join(destination, 'renamed', 'new.md'), 'utf8')).toBe('new');
    expect(await fse.pathExists(path.join(destination, 'nested'))).toBe(false);
    await sync();
    expect((await fse.readdir(destination)).sort()).toEqual(['guide.md', 'renamed']);
  });

  it.each(['missing', 'empty', 'hidden-only'])('prunes a %s team bundle while retaining hidden local files', async (state) => {
    await fse.outputFile(path.join(destination, 'old', 'guide.md'), 'old');
    await fse.outputFile(path.join(destination, 'old', '.keep'), 'local');
    await fse.outputFile(path.join(destination, '.private', 'draft.md'), 'local');
    if (state === 'missing') await fse.remove(source);
    if (state === 'hidden-only') await fse.outputFile(path.join(source, '.private', 'team.md'), 'hidden');
    await sync();
    expect(await fse.pathExists(path.join(destination, 'old', 'guide.md'))).toBe(false);
    expect(await fse.readFile(path.join(destination, 'old', '.keep'), 'utf8')).toBe('local');
    expect(await fse.readFile(path.join(destination, '.private', 'draft.md'), 'utf8')).toBe('local');
    expect(await fse.pathExists(path.join(destination, '.private', 'team.md'))).toBe(false);
  });

  it('unlinks stale directory links without traversing their targets', async () => {
    const outside = path.join(root, 'outside');
    await fse.outputFile(path.join(outside, 'keep.md'), 'local');
    await fse.symlink(outside, path.join(destination, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await sync();
    expect(await fse.pathExists(path.join(destination, 'linked'))).toBe(false);
    expect(await fse.readFile(path.join(outside, 'keep.md'), 'utf8')).toBe('local');
  });

  it('warns and does not prune after a copy failure', async () => {
    await fse.outputFile(path.join(source, 'guide.md'), 'new');
    await fse.outputFile(path.join(destination, 'old.md'), 'old');
    vi.spyOn(fse, 'copy').mockRejectedValueOnce(new Error('copy failed'));
    await sync();
    expect(log.warn).toHaveBeenCalledWith('Failed to sync docs: copy failed');
    expect(await fse.readFile(path.join(destination, 'old.md'), 'utf8')).toBe('old');
  });

  it('does not treat an unreadable source as an empty bundle', async () => {
    await fse.outputFile(path.join(destination, 'old.md'), 'old');
    vi.spyOn(fse, 'readdir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await sync();
    expect(log.warn).toHaveBeenCalledWith('Failed to sync docs: denied');
    expect(await fse.pathExists(path.join(destination, 'old.md'))).toBe(true);
  });

  it('leaves the source untouched when localDir already points to team docs', async () => {
    team.sharing.docs.localDir = source;
    await fse.outputFile(path.join(source, 'guide.md'), 'team');
    await sync();
    expect(log.warn).not.toHaveBeenCalled();
    expect(await fse.readFile(path.join(source, 'guide.md'), 'utf8')).toBe('team');
  });

  it.each(['repo', 'home', '.'])('rejects an unsafe destination: %s', async (dir) => {
    team.sharing.docs.localDir = path.join(root, dir);
    await fse.outputFile(path.join(source, 'guide.md'), 'team');
    await sync();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('dedicated localDir'));
    expect(await fse.readFile(path.join(source, 'guide.md'), 'utf8')).toBe('team');
  });
});
