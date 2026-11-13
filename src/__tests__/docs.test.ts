import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { DocsHandler } from '../resources/docs.js';
import { log } from '@teamai/shared/log';
import { commitTeamRepo } from './helpers/team-repo-history.js';
import { copyRegularTree } from '@teamai/shared/regular-file';

vi.mock('@teamai/shared/regular-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@teamai/shared/regular-file')>();

  return { ...actual, copyRegularTree: vi.fn(actual.copyRegularTree) };
});
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

  // Changed in #993: a file at a path the team history never had is the member's and stays; only
  // teamai's copies of docs the team removed are pruned.
  it('mirrors the team bundle, removing teamai\'s copies of removed docs and keeping the member\'s own files', async () => {
    const repo = path.join(root, 'repo');
    await fse.outputFile(path.join(source, 'retired.md'), 'retired');
    commitTeamRepo(repo, 'retired');
    await sync();
    await fse.remove(path.join(source, 'retired.md'));
    await fse.outputFile(path.join(source, 'guide.md'), 'new');
    await fse.outputFile(path.join(destination, 'draft.md'), 'local');
    commitTeamRepo(repo, 'retire');
    await sync();
    expect(await fse.pathExists(path.join(destination, 'retired.md'))).toBe(false);
    expect(await fse.readFile(path.join(destination, 'draft.md'), 'utf8')).toBe('local');
    expect(await fse.readFile(path.join(destination, 'guide.md'), 'utf8')).toBe('new');
  });

  it('keeps a local file the team does not have when the team history cannot be read (#993)', async () => {
    // A team directory with no git history: nothing proves the file teamai's, or a path the team never had.
    await fse.outputFile(path.join(source, 'guide.md'), 'new');
    await fse.outputFile(path.join(destination, 'draft.md'), 'local');
    await sync();
    expect(await fse.readFile(path.join(destination, 'draft.md'), 'utf8')).toBe('local');
    expect(await fse.readFile(path.join(destination, 'guide.md'), 'utf8')).toBe('new');
  });

  it('copies updates and removes deleted and renamed files, including nested directories', async () => {
    await fse.outputFile(path.join(source, 'guide.md'), 'old');
    await fse.outputFile(path.join(source, 'nested', 'old.md'), 'old');
    // The copy pull wrote is the team's earlier version, which history proves (#993).
    commitTeamRepo(path.join(root, 'repo'), 'old');
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
    // Each layout is committed: what pull wrote before is a team version, so it may be replaced (#993).
    const repo = path.join(root, 'repo');
    await fse.outputFile(path.join(source, name, 'old.md'), 'old directory');
    commitTeamRepo(repo, 'directory');
    await sync();
    await fse.remove(path.join(source, name));
    await fse.outputFile(path.join(source, name), 'new file');
    commitTeamRepo(repo, 'file');
    await sync();
    expect(await fse.readFile(path.join(destination, name), 'utf8')).toBe('new file');

    await fse.remove(path.join(source, name));
    await fse.outputFile(path.join(source, name, 'new.md'), 'new directory');
    commitTeamRepo(repo, 'directory again');
    await sync();
    expect(await fse.readFile(path.join(destination, name, 'new.md'), 'utf8')).toBe('new directory');
    expect(await fse.readdir(path.join(destination, name))).toEqual(['new.md']);
    expect((await fse.readdir(destination)).some(entry => entry.startsWith('.teamai-docs-'))).toBe(false);
  });

  it.each(['copy', 'rename'])('preserves conflicting entries when replacement %s fails', async (failure) => {
    await fse.outputFile(path.join(destination, 'guide', 'old.md'), 'old directory');
    await fse.outputFile(path.join(destination, 'api'), 'old file');
    await fse.outputFile(path.join(destination, 'stale.md'), 'stale');
    // The conflicting entries are earlier team versions, so pull may replace them (#993).
    await fse.outputFile(path.join(source, 'guide', 'old.md'), 'old directory');
    await fse.outputFile(path.join(source, 'api'), 'old file');
    commitTeamRepo(path.join(root, 'repo'), 'old layout');
    await fse.remove(path.join(source, 'guide'));
    await fse.remove(path.join(source, 'api'));
    await fse.outputFile(path.join(source, 'guide'), 'new file');
    await fse.outputFile(path.join(source, 'api', 'new.md'), 'new directory');
    commitTeamRepo(path.join(root, 'repo'), 'new layout');
    if (failure === 'copy') {
      vi.mocked(copyRegularTree).mockRejectedValueOnce(new Error('copy failed'));
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

  it('keeps a member\'s directory at the path of a team doc file, and writes nothing over it (#993)', async () => {
    await fse.outputFile(path.join(destination, 'guide.md', 'notes.txt'), 'mine');
    await fse.outputFile(path.join(source, 'guide.md'), 'team');
    commitTeamRepo(path.join(root, 'repo'));
    await sync();
    expect(await fse.readFile(path.join(destination, 'guide.md', 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('keeps a member\'s file at the path of a team docs directory, and writes nothing over it (#993)', async () => {
    await fse.outputFile(path.join(destination, 'guide'), 'mine');
    await fse.outputFile(path.join(source, 'guide', 'readme.md'), 'team');
    commitTeamRepo(path.join(root, 'repo'));
    await sync();
    expect(await fse.readFile(path.join(destination, 'guide'), 'utf8')).toBe('mine');
  });

  it('keeps a member\'s directory at a former team doc file\'s path when the team deletes that doc (#993)', async () => {
    const repo = path.join(root, 'repo');
    await fse.outputFile(path.join(source, 'guide'), 'team file');
    commitTeamRepo(repo, 'add guide');
    await sync();
    // The member replaces the delivered file with a directory of their own.
    await fse.remove(path.join(destination, 'guide'));
    await fse.outputFile(path.join(destination, 'guide', 'personal.md'), 'mine');
    await fse.remove(path.join(source, 'guide'));
    await fse.outputFile(path.join(source, 'other.md'), 'other');
    commitTeamRepo(repo, 'remove guide');
    await sync();
    expect(await fse.readFile(path.join(destination, 'guide', 'personal.md'), 'utf8')).toBe('mine');
  });

  it('keeps a member\'s link that replaced a team doc when the team deletes that doc (#993)', async () => {
    const repo = path.join(root, 'repo');
    await fse.outputFile(path.join(source, 'guide.md'), 'team');
    commitTeamRepo(repo, 'add guide');
    await sync();
    const outside = path.join(root, 'mine.md');
    await fse.outputFile(outside, 'mine');
    const link = path.join(destination, 'guide.md');
    await fse.remove(link);
    await fse.symlink(outside, link);
    await fse.remove(path.join(source, 'guide.md'));
    await fse.outputFile(path.join(source, 'other.md'), 'other');
    commitTeamRepo(repo, 'remove guide');
    await sync();
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(outside, 'utf8')).toBe('mine');
  });

  it('keeps a member\'s link whose target text equals a former team doc file\'s bytes (#993)', async () => {
    const repo = path.join(root, 'repo');
    // An old regular doc whose whole content is the text a link to personal.md holds.
    await fse.outputFile(path.join(source, 'guide.md'), 'personal.md');
    commitTeamRepo(repo, 'add guide');
    await sync();
    const link = path.join(destination, 'guide.md');
    await fse.remove(link);
    await fse.symlink('personal.md', link);
    await fse.remove(path.join(source, 'guide.md'));
    await fse.outputFile(path.join(source, 'other.md'), 'other');
    commitTeamRepo(repo, 'remove guide');
    await sync();
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('keeps a member\'s directory holding only a link where the team deleted a doc file (#993)', async () => {
    const repo = path.join(root, 'repo');
    await fse.outputFile(path.join(source, 'guide'), 'team file');
    commitTeamRepo(repo, 'add guide');
    await sync();
    const outside = path.join(root, 'mine.md');
    await fse.outputFile(outside, 'mine');
    await fse.remove(path.join(destination, 'guide'));
    await fse.ensureDir(path.join(destination, 'guide'));
    const link = path.join(destination, 'guide', 'personal.md');
    await fse.symlink(outside, link);
    await fse.remove(path.join(source, 'guide'));
    await fse.outputFile(path.join(source, 'other.md'), 'other');
    commitTeamRepo(repo, 'remove guide');
    await sync();
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(outside, 'utf8')).toBe('mine');
  });

  it('keeps a directory containing hidden local entries at a team doc file\'s path (#993)', async () => {
    // No team version holds `.keep`: the directory is the member's, so pull leaves it whole.
    await fse.outputFile(path.join(destination, 'guide', 'nested', '.keep'), 'private');
    await fse.outputFile(path.join(source, 'guide'), 'new file');
    commitTeamRepo(path.join(root, 'repo'));
    await sync();
    expect(await fse.readFile(path.join(destination, 'guide', 'nested', '.keep'), 'utf8')).toBe('private');
  });

  it('keeps a member\'s directory link where the team adds a docs directory, without following it (#993)', async () => {
    const outside = path.join(root, 'outside');
    await fse.outputFile(path.join(outside, 'keep.md'), 'outside');
    const link = path.join(destination, 'guide');
    await fse.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await fse.outputFile(path.join(source, 'guide', 'readme.md'), 'new directory');
    commitTeamRepo(path.join(root, 'repo'));
    await sync();
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fse.readlink(link)).toBe(outside);
    expect(await fse.readdir(outside)).toEqual(['keep.md']);
  });

  it('keeps a member\'s link at a team doc file\'s path, without touching its target (#993)', async () => {
    const outside = path.join(root, 'outside.md');
    await fse.outputFile(outside, 'mine');
    const link = path.join(destination, 'guide.md');
    await fse.symlink(outside, link);
    await fse.outputFile(path.join(source, 'guide.md'), 'team');
    commitTeamRepo(path.join(root, 'repo'));
    await sync();
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(outside, 'utf8')).toBe('mine');
  });

  it.each(['missing', 'empty', 'hidden-only'])('prunes a %s team bundle while retaining hidden local files', async (state) => {
    // docs/old/guide.md was a team doc, so the copy pull wrote is teamai's to prune (#993).
    const repo = path.join(root, 'repo');
    await fse.outputFile(path.join(source, 'old', 'guide.md'), 'old');
    commitTeamRepo(repo, 'old');
    await fse.remove(path.join(source, 'old'));
    await fse.outputFile(path.join(destination, 'old', 'guide.md'), 'old');
    await fse.outputFile(path.join(destination, 'old', '.keep'), 'local');
    await fse.outputFile(path.join(destination, '.private', 'draft.md'), 'local');
    if (state === 'missing') await fse.remove(source);
    if (state === 'hidden-only') await fse.outputFile(path.join(source, '.private', 'team.md'), 'hidden');
    commitTeamRepo(repo, 'remove old');
    await sync();
    expect(await fse.pathExists(path.join(destination, 'old', 'guide.md'))).toBe(false);
    expect(await fse.readFile(path.join(destination, 'old', '.keep'), 'utf8')).toBe('local');
    expect(await fse.readFile(path.join(destination, '.private', 'draft.md'), 'utf8')).toBe('local');
    expect(await fse.pathExists(path.join(destination, '.private', 'team.md'))).toBe(false);
  });

  // Changed in #993 from unlinking it: a link is the member's, so one at a path the team never had stays.
  it('keeps and names a member\'s link at a path the team never had, without traversing its target (#993)', async () => {
    const outside = path.join(root, 'outside');
    await fse.outputFile(path.join(outside, 'keep.md'), 'local');
    const link = path.join(destination, 'linked');
    await fse.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    // The history shows the team never had docs/linked (#993).
    commitTeamRepo(path.join(root, 'repo'));
    const warn = vi.spyOn(log, 'warn');
    await sync();
    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(path.join(outside, 'keep.md'), 'utf8')).toBe('local');
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toContain(
      `Kept ${link}: it is a link of yours, and the team does not have docs/linked. Delete it when you no longer need it.`,
    );
  });

  it('propagates a copy failure without pruning', async () => {
    await fse.outputFile(path.join(source, 'guide.md'), 'new');
    await fse.outputFile(path.join(destination, 'old.md'), 'old');
    vi.mocked(copyRegularTree).mockRejectedValueOnce(new Error('copy failed'));
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
