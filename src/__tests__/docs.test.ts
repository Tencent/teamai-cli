import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { DocsHandler } from '../resources/docs.js';
import { LocalConfigSchema, TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

describe('DocsHandler nested documents', () => {
  const handler = new DocsHandler();
  let tmpDir: string;
  let docsDir: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-docs-'));
    vi.stubEnv('HOME', tmpDir);
    docsDir = path.join(tmpDir, 'repo', 'docs');
    localConfig = LocalConfigSchema.parse({
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'local/docs-test' },
      username: 'test', scope: 'user',
    });
    teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'local/docs-test', provider: 'git' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('discovers and syncs documents when all visible files are nested', async () => {
    const visible = ['ai/setup.md', 'ai/reference/api.pdf'];
    const hidden = ['.gitkeep', 'ai/.draft.md', 'ai/.private/note.md'];
    for (const docPath of [...visible, ...hidden]) {
      await fse.outputFile(path.join(docsDir, docPath), `Content: ${docPath}\n`);
    }
    const items = await handler.scanTeamForPull(teamConfig, localConfig);
    expect(items).toHaveLength(1);
    expect(await handler.countDocFiles(docsDir)).toBe(2);

    await handler.pullItem(items[0], teamConfig, localConfig);

    for (const docPath of visible) {
      expect(await fse.readFile(path.join(tmpDir, '.teamai', 'docs', docPath), 'utf8')).toBe(`Content: ${docPath}\n`);
    }
    for (const docPath of hidden) {
      expect(await fse.pathExists(path.join(tmpDir, '.teamai', 'docs', docPath))).toBe(false);
    }
  });

  it('does not offer a docs bundle for missing, empty, or hidden-only trees', async () => {
    expect(await handler.countDocFiles(docsDir)).toBe(0);
    expect(await handler.scanTeamForPull(teamConfig, localConfig)).toEqual([]);

    await fse.ensureDir(path.join(docsDir, 'empty'));
    await fse.outputFile(path.join(docsDir, 'ai', '.gitkeep'), '');
    await fse.outputFile(path.join(docsDir, '.private', 'note.md'), 'Hidden\n');
    expect(await handler.countDocFiles(docsDir)).toBe(0);
    expect(await handler.scanTeamForPull(teamConfig, localConfig)).toEqual([]);
  });
});

describe('DocsHandler pruning (#794)', () => {
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

  it.each(['guide', 'nested/guide'])('mirrors directory/file transitions at %s', async (name) => {
    await fse.outputFile(path.join(source, name, 'old.md'), 'old directory');
    await sync();
    await fse.remove(path.join(source, name));
    await fse.outputFile(path.join(source, name), 'new file');
    await sync();
    expect(await fse.readFile(path.join(destination, name), 'utf8')).toBe('new file');

    await fse.remove(path.join(source, name));
    await fse.outputFile(path.join(source, name, 'new.md'), 'new directory');
    await sync();
    expect(await fse.readFile(path.join(destination, name, 'new.md'), 'utf8')).toBe('new directory');
    expect(await fse.readdir(path.join(destination, name))).toEqual(['new.md']);
    expect((await fse.readdir(destination)).some(entry => entry.startsWith('.teamai-docs-'))).toBe(false);
  });

  it.each(['copy', 'rename'])('preserves conflicting entries when replacement %s fails', async (failure) => {
    await fse.outputFile(path.join(destination, 'guide', 'old.md'), 'old directory');
    await fse.outputFile(path.join(destination, 'api'), 'old file');
    await fse.outputFile(path.join(destination, 'stale.md'), 'stale');
    await fse.outputFile(path.join(source, 'guide'), 'new file');
    await fse.outputFile(path.join(source, 'api', 'new.md'), 'new directory');
    if (failure === 'copy') {
      vi.spyOn(fse, 'copy').mockRejectedValueOnce(new Error('copy failed'));
    } else {
      const rename = fse.rename.bind(fse);
      vi.spyOn(fse, 'rename')
        .mockImplementationOnce((from, to) => rename(from, to))
        .mockImplementationOnce((from, to) => rename(from, to))
        .mockImplementationOnce((from, to) => rename(from, to))
        // The first replacement succeeded; installing the second one fails.
        .mockRejectedValueOnce(new Error('rename failed'));
    }
    await expect(sync()).rejects.toThrow(`${failure} failed`);
    expect(await fse.readFile(path.join(destination, 'guide', 'old.md'), 'utf8')).toBe('old directory');
    expect(await fse.readFile(path.join(destination, 'api'), 'utf8')).toBe('old file');
    expect(await fse.readFile(path.join(destination, 'stale.md'), 'utf8')).toBe('stale');
    expect((await fse.readdir(destination)).sort()).toEqual(['api', 'guide', 'stale.md']);
  });

  it('refuses to replace a directory containing hidden local entries', async () => {
    await fse.outputFile(path.join(destination, 'guide', 'nested', '.keep'), 'private');
    await fse.outputFile(path.join(source, 'guide'), 'new file');
    await expect(sync()).rejects.toThrow('hidden local entries');
    expect(await fse.readFile(path.join(destination, 'guide', 'nested', '.keep'), 'utf8')).toBe('private');
  });

  it('replaces a directory link without modifying its target', async () => {
    const outside = path.join(root, 'outside');
    await fse.outputFile(path.join(outside, 'keep.md'), 'outside');
    await fse.symlink(outside, path.join(destination, 'guide'), process.platform === 'win32' ? 'junction' : 'dir');
    await fse.outputFile(path.join(source, 'guide', 'new.md'), 'new directory');
    await sync();
    expect((await fse.lstat(path.join(destination, 'guide'))).isSymbolicLink()).toBe(false);
    expect(await fse.readFile(path.join(destination, 'guide', 'new.md'), 'utf8')).toBe('new directory');
    expect(await fse.readdir(outside)).toEqual(['keep.md']);
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

  it('propagates a copy failure without pruning', async () => {
    await fse.outputFile(path.join(source, 'guide.md'), 'new');
    await fse.outputFile(path.join(destination, 'old.md'), 'old');
    vi.spyOn(fse, 'copy').mockRejectedValueOnce(new Error('copy failed'));
    await expect(sync()).rejects.toThrow('copy failed');
    expect(await fse.readFile(path.join(destination, 'old.md'), 'utf8')).toBe('old');
  });

  it('does not treat an unreadable source as an empty bundle', async () => {
    await fse.outputFile(path.join(destination, 'old.md'), 'old');
    vi.spyOn(fse, 'readdir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(sync()).rejects.toThrow('denied');
    expect(await fse.pathExists(path.join(destination, 'old.md'))).toBe(true);
  });

  it('leaves the source untouched when localDir already points to team docs', async () => {
    team.sharing.docs.localDir = source;
    await fse.outputFile(path.join(source, 'guide.md'), 'team');
    await sync();
    expect(await fse.readFile(path.join(source, 'guide.md'), 'utf8')).toBe('team');
  });

  it.each(['repo', 'home', '.'])('rejects an unsafe destination: %s', async (dir) => {
    team.sharing.docs.localDir = path.join(root, dir);
    await fse.outputFile(path.join(source, 'guide.md'), 'team');
    await expect(sync()).rejects.toThrow('dedicated localDir');
    expect(await fse.readFile(path.join(source, 'guide.md'), 'utf8')).toBe('team');
  });
});
