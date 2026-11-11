import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHash, openLedger } from '../resources/delivered-copies.js';
import { DeliveredFolders } from '../resources/delivered-folders.js';
import { FolderFiles, type FolderFile } from '../resources/folder-files.js';
import type { LocalConfig } from '../types.js';
import { log as logger } from '../utils/logger.js';

/** Whether the temp directory's file system takes two names that differ only in case for one. */
const TMP_IGNORES_CASE = fs.existsSync(fs.realpathSync.native(os.tmpdir()).toUpperCase());

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-delivered-folders-'));
  dirs.push(dir);

  return dir;
}

const file = (filePath: string, content: string, executable = false): FolderFile => ({ path: filePath, executable, bytes: Buffer.from(content) });

/** Every file under `dir` with its content, `/`-separated, hidden entries included. */
function tree(dir: string): Record<string, string> {
  const found: Record<string, string> = {};

  const visit = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) visit(child);
      else found[child] = fs.readFileSync(path.join(dir, child), 'utf8');
    }
  };

  visit('');

  return found;
}

describe('DeliveredFolders.pathOf', () => {
  const base = { username: 't', additionalRoles: [] };
  const home = path.join(os.tmpdir(), 'home');
  const user: LocalConfig = { ...base, scope: 'user', dataHome: path.join(home, '.teamai'), repo: { localPath: path.join(home, '.teamai', 'repo'), remote: 'acme/team' } };

  const workspace: LocalConfig = {
    ...base, scope: 'project', projectRoot: path.join(home, 'shop'), dataHome: path.join(home, '.teamai', 'projects', 'shop-1a2b'),
    repo: { localPath: path.join(home, '.teamai', 'projects', 'shop-1a2b', 'repo'), remote: 'acme/team' },
  };

  const selfModeConfig: LocalConfig = {
    ...base, scope: 'project', projectRoot: path.join(home, 'shop-wt'), dataHome: path.join(home, '.teamai', 'projects', 'shop-1a2b'),
    repo: { localPath: path.join(home, 'shop-wt', '.teamai'), remote: 'acme/shop', kind: 'self', businessRepoRoot: path.join(home, 'shop-wt') },
  };

  it.each([
    ['the user scope', user, null, path.join(home, '.teamai', 'hooks', 'lint')],
    ['the user scope, in a namespace', user, 'payments', path.join(home, '.teamai', 'hooks', 'payments', 'lint')],
    ['a workspace with a remote team, shared by its worktrees', workspace, null, path.join(home, '.teamai', 'projects', 'shop-1a2b', 'hooks', 'lint')],
    ['a worktree in self mode, in its own checkout', selfModeConfig, 'payments', path.join(home, 'shop-wt', '.teamai', 'delivered', 'hooks', 'payments', 'lint')],
  ] as const)('puts a folder of %s in the data home of the scope that owns it', (_case, localConfig, namespace, expected) => {
    expect(DeliveredFolders.pathOf(localConfig, { type: 'hooks', namespace, name: 'lint' })).toBe(expected);
  });
});

describe('DeliveredFolders.identify', () => {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });

  /** A team repo whose commit holds `hooks/lint/`: a script git keeps executable and a `.bat` saved in GBK, with `__pycache__/` ignored. */
  function teamRepo(): string {
    const repo = tempDir();
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, '.gitignore'), '__pycache__/\n');
    fse.outputFileSync(path.join(repo, 'hooks', 'lint', 'HOOK.yaml'), 'event: Stop\ncommand: bash "${TEAMAI_HOOK_DIR}/lint.sh"\n');
    fse.outputFileSync(path.join(repo, 'hooks', 'lint', 'lint.sh'), 'echo lint\n');
    // "测试" in GBK, which is not UTF-8.
    fse.outputFileSync(path.join(repo, 'hooks', 'lint', 'lint.bat'), Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]));
    git(repo, 'add', '.');
    git(repo, 'update-index', '--chmod=+x', 'hooks/lint/lint.sh');
    git(repo, 'commit', '-qm', 'lint');

    return repo;
  }

  /** The hook folder of a clone of `repo` made with `config`, where a member's pull reads it. */
  function clone(repo: string, ...config: string[]): string {
    const dir = path.join(tempDir(), 'team');
    execFileSync('git', ['clone', '-q', ...config.flatMap((setting) => ['-c', setting]), repo, dir]);

    return path.join(dir, 'hooks', 'lint');
  }

  /** The files pull reads at `dir`, with what Node on Windows reports for each: no executable bit. */
  async function filesAt(dir: string, platform: 'posix' | 'windows' = 'posix'): Promise<FolderFile[]> {
    const read = await FolderFiles.read(dir);

    if (read.kind !== 'files') throw new Error(`${dir} is not a folder: ${read.problems.map(FolderFiles.describe).join(', ')}`);

    return read.files.map((one) => (platform === 'windows' ? { ...one, executable: false } : one));
  }

  async function versionAt(dir: string, platform: 'posix' | 'windows' = 'posix'): Promise<string> {
    const identified = await DeliveredFolders.identify(dir, await filesAt(dir, platform));

    if (!identified.ok) throw new Error(identified.reason);

    return identified.version;
  }

  it('is the same in every checkout of a commit, whatever autocrlf, the executable bit or a file\'s encoding', async () => {
    const repo = teamRepo();
    const macos = clone(repo, 'core.autocrlf=false');
    const windows = clone(repo, 'core.autocrlf=true', 'core.fileMode=false');
    fse.outputFileSync(path.join(windows, '__pycache__', 'lint.cpython-312.pyc'), '\0compiled');

    expect(fs.readFileSync(path.join(windows, 'lint.bat')).subarray(-2).toString('latin1')).toBe('\r\n');
    expect(await versionAt(windows, 'windows')).toBe(await versionAt(macos));
  });

  it('delivers none of the files git ignores', async () => {
    const windows = clone(teamRepo(), 'core.autocrlf=true');
    fse.outputFileSync(path.join(windows, '__pycache__', 'lint.cpython-312.pyc'), '\0compiled');
    const identified = await DeliveredFolders.identify(windows, await filesAt(windows));

    expect(identified.ok && identified.files.map((one) => one.path)).toEqual(['HOOK.yaml', 'lint.bat', 'lint.sh']);
  });

  it('changes when the team commits a change to a file\'s mode alone', async () => {
    const repo = teamRepo();
    const before = await versionAt(clone(repo));
    git(repo, 'update-index', '--chmod=-x', 'hooks/lint/lint.sh');
    git(repo, 'commit', '-qm', 'not executable');

    expect(await versionAt(clone(repo))).not.toBe(before);
  });

  it('counts what the author has not committed yet: an edited file, then a new one', async () => {
    const author = path.join(teamRepo(), 'hooks', 'lint');
    const committed = await versionAt(author);
    fs.appendFileSync(path.join(author, 'lint.sh'), 'echo more\n');
    const edited = await versionAt(author);
    fs.writeFileSync(path.join(author, 'fix.sh'), 'echo fix\n');

    expect([edited, await versionAt(author)]).toEqual([expect.not.stringMatching(committed), expect.not.stringMatching(edited)]);
  });

  it('counts a file git is told to assume unchanged as it is on disk', async () => {
    const repo = teamRepo();
    const author = path.join(repo, 'hooks', 'lint');
    git(repo, 'update-index', '--assume-unchanged', 'hooks/lint/HOOK.yaml');
    const unchanged = await versionAt(author);
    fs.appendFileSync(path.join(author, 'HOOK.yaml'), 'timeout: 5\n');

    expect(await versionAt(author)).not.toBe(unchanged);
  });

  it('delivers a file whose name is NFD on disk and NFC in git', async () => {
    const repo = teamRepo();
    fs.writeFileSync(path.join(repo, 'hooks', 'lint', 'café.sh'), 'echo cafe\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'cafe');
    const dir = path.join(repo, 'hooks', 'lint');
    const identified = await DeliveredFolders.identify(dir, await filesAt(dir));

    expect(identified.ok && identified.files.map((one) => one.path.normalize('NFC'))).toEqual(['HOOK.yaml', 'café.sh', 'lint.bat', 'lint.sh']);
  });

  it('refuses a folder holding a git submodule, whose files git does not list', async () => {
    const vendored = tempDir();
    git(vendored, 'init', '-q');
    fs.writeFileSync(path.join(vendored, 'main.js'), 'console.log(1)\n');
    git(vendored, 'add', '.');
    git(vendored, 'commit', '-qm', 'server');
    const repo = teamRepo();
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', vendored, 'hooks/lint/server');
    git(repo, 'commit', '-qm', 'vendor the server');
    const dir = path.join(repo, 'hooks', 'lint');
    const identified = await DeliveredFolders.identify(dir, await filesAt(dir));

    expect(identified.ok ? null : identified.reason).toContain('server/ is a git submodule');
  });

  it('refuses a folder holding a git submodule even where it is not checked out', async () => {
    const vendored = tempDir();
    git(vendored, 'init', '-q');
    fs.writeFileSync(path.join(vendored, 'main.js'), 'console.log(1)\n');
    git(vendored, 'add', '.');
    git(vendored, 'commit', '-qm', 'server');
    const repo = teamRepo();
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', vendored, 'hooks/lint/server');
    git(repo, 'commit', '-qm', 'vendor the server');
    const member = clone(repo);
    const identified = await DeliveredFolders.identify(member, await filesAt(member));

    expect([fs.readdirSync(path.join(member, 'server')), identified.ok ? null : identified.reason]).toEqual([[], expect.stringContaining('server/ is a git submodule')]);
  });

  it('refuses a folder holding a git repository of its own', async () => {
    const dir = path.join(teamRepo(), 'hooks', 'lint');
    git(path.join(dir), 'init', '-q', 'server');
    fs.writeFileSync(path.join(dir, 'server', 'main.js'), 'console.log(1)\n');
    const identified = await DeliveredFolders.identify(dir, await filesAt(dir));

    expect(identified.ok ? null : identified.reason).toContain('server/ is a git repository of its own');
  });

  it('leaves out a repository of its own under a directory git ignores, as it does every ignored file', async () => {
    const repo = teamRepo();
    const dir = path.join(repo, 'hooks', 'lint');
    fs.appendFileSync(path.join(repo, '.gitignore'), 'build/\n');
    git(dir, 'init', '-q', path.join('build', 'vend'));
    fs.writeFileSync(path.join(dir, 'build', 'vend', 'main.js'), 'console.log(1)\n');
    const identified = await DeliveredFolders.identify(dir, await filesAt(dir));

    expect(identified.ok ? identified.files.map((one) => one.path) : identified.reason).toEqual(['HOOK.yaml', 'lint.bat', 'lint.sh']);
  });

  it('names the first few files git does not list, and how many more', async () => {
    const dir = tempDir();
    git(dir, 'init', '-q');
    const files = ['a', 'b', 'c', 'd', 'e'].map((name) => file(`${name}.sh`, 'echo\n'));
    const identified = await DeliveredFolders.identify(dir, files);

    expect(identified.ok ? null : identified.reason).toMatch(/^git lists a\.sh, b\.sh, c\.sh and 2 more as neither tracked, new nor ignored\./);
  });

  it('versions the bytes and the executable bit of a folder outside git', async () => {
    const dir = tempDir();
    const files = [file('HOOK.yaml', 'event: Stop\n'), file('lint.sh', 'echo lint\n', true)];
    const version = async (given: FolderFile[]): Promise<string | null> => {
      const identified = await DeliveredFolders.identify(dir, given);

      return identified.ok ? identified.version : null;
    };

    expect(await version(files)).toMatch(/^[0-9a-f]{8}$/);
    expect(await version(files.map((one) => ({ ...one, executable: false })))).not.toBe(await version(files));
  });

  it('fails, naming the folder, when git cannot list it', async () => {
    const repo = teamRepo();
    const dir = path.join(repo, 'hooks', 'lint');
    const files = await filesAt(dir);
    fs.writeFileSync(path.join(repo, '.git', 'index'), 'not an index');
    const identified = await DeliveredFolders.identify(dir, files);

    expect(identified.ok ? null : identified.reason).toContain(dir);
  });
});

describe('DeliveredFolders.deliver', () => {
  it('writes every file of the folder at its path and records each in the ledger', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    const ledger = openLedger({});

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'event: Stop\n'), file('lib/scan.sh', 'echo scan\n', true)], ledger });

    expect(tree(path.dirname(dest))).toEqual({ 'block-secrets/HOOK.yaml': 'event: Stop\n', 'block-secrets/lib/scan.sh': 'echo scan\n' });
    expect(ledger.hashes).toEqual({
      [path.join(dest, 'HOOK.yaml')]: contentHash('event: Stop\n'),
      [path.join(dest, 'lib', 'scan.sh')]: contentHash('echo scan\n'),
    });
  });

  it('replaces the previous version at the same path, keeping the files it dropped for what another worktree still runs, and leaves nothing beside it', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    const ledger = openLedger({});
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n'), file('old.sh', 'old\n')], ledger });

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v2\n'), file('new.sh', 'new\n')], ledger });

    expect([tree(path.dirname(dest)), Object.keys(ledger.hashes).sort()]).toEqual([
      { 'block-secrets/HOOK.yaml': 'v2\n', 'block-secrets/new.sh': 'new\n', 'block-secrets/old.sh': 'old\n' },
      [path.join(dest, 'HOOK.yaml'), path.join(dest, 'new.sh'), path.join(dest, 'old.sh')],
    ]);
  });

  it('gives the new version a path an earlier file clashes with: a file now a directory, or a directory now a file', async () => {
    const dest = path.join(tempDir(), 'mcp', 'jira-lite');
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('lib', 'old\n'), file('util/a.js', 'old\n')], ledger: undefined });

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('lib/a.js', 'new\n'), file('util', 'new\n')], ledger: undefined });

    expect(tree(dest)).toEqual({ 'lib/a.js': 'new\n', util: 'new\n' });
  });

  it('says which earlier file a new one took the place of, which a copy pull left as it was may still name', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const dest = path.join(tempDir(), 'rules', 'api');
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('RULE.md', 'v1\n'), file('details/checklist.md', 'old\n')], ledger: undefined });

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('RULE.md', 'v2\n'), file('details', 'new\n')], ledger: undefined });

    expect(warn.mock.calls.map((call) => call.join(' '))).toEqual([
      `${path.join(dest, 'details', 'checklist.md')} is gone: the new version has ${path.join(dest, 'details')} in its place. `
      + 'A rule copy or a configuration pull left as it was may still name it: update it to the new version\'s files.',
    ]);
  });

  it.skipIf(!TMP_IGNORES_CASE)('gives the new version a name an earlier file has in another case, where the file system takes them for one', async () => {
    const dest = path.join(tempDir(), 'mcp', 'jira-lite');
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('Notes.md', 'old\n'), file('lib/a.js', 'old\n')], ledger: undefined });

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('NOTES.md', 'new\n'), file('Lib', 'new\n')], ledger: undefined });

    expect(tree(dest)).toEqual({ 'NOTES.md': 'new\n', Lib: 'new\n' });
  });

  it.skipIf(TMP_IGNORES_CASE)('keeps an earlier file whose name differs from a new one only in case, where the file system tells them apart', async () => {
    const dest = path.join(tempDir(), 'mcp', 'jira-lite');
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('Checklist.md', 'old\n')], ledger: undefined });

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('checklist.md', 'new\n')], ledger: undefined });

    expect(tree(dest)).toEqual({ 'Checklist.md': 'old\n', 'checklist.md': 'new\n' });
  });

  it('drops the files an earlier version had for a folder whose reader lists what it holds', async () => {
    const dest = path.join(tempDir(), 'hooks', 'teamai-friction-reminder');
    await DeliveredFolders.deliver({ dest, earlierFiles: 'drop', files: [file('HOOK.yaml', 'v1\n'), file('problem.zh.md', 'zh\n')], ledger: undefined });

    await DeliveredFolders.deliver({ dest, earlierFiles: 'drop', files: [file('HOOK.yaml', 'v1\n'), file('problem.md', 'en\n')], ledger: undefined });

    expect(tree(dest)).toEqual({ 'HOOK.yaml': 'v1\n', 'problem.md': 'en\n' });
  });

  it('leaves a folder that already holds the version in place, and records it', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    const files = [file('HOOK.yaml', 'v1\n'), file('scan.sh', 'echo scan\n', true)];
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files, ledger: undefined });
    const before = fs.statSync(dest).ino;
    const ledger = openLedger({});

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files, ledger });

    expect([fs.statSync(dest).ino, Object.keys(ledger.hashes).length]).toEqual([before, 2]);
  });

  it('names the folder it cannot move aside, and why, and leaves the installed version in place', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n')], ledger: undefined });
    // What Windows answers while a hook still runs from the folder.
    const busy = Object.assign(new Error(`EBUSY: resource busy or locked, rename '${dest}'`), { code: 'EBUSY' });
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(busy);

    await expect(DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v2\n')], ledger: undefined })).rejects.toThrow(
      `could not replace the delivered folder ${dest} (EBUSY: resource busy or locked, rename '${dest}'); `
      + 'a program running from it, such as a hook on Windows, can hold it, so close that program',
    );
    expect(tree(dest)).toEqual({ 'HOOK.yaml': 'v1\n' });
  });

  it('puts the installed version back when the new one cannot be moved into place, and names the folder and why', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n')], ledger: undefined });
    const rename = fs.promises.rename.bind(fs.promises);
    // What Windows can answer while a scanner holds the new version's files: the old one is already out of the way.
    const denied = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(rename).mockRejectedValueOnce(denied);

    await expect(DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v2\n')], ledger: undefined })).rejects.toThrow(
      `could not move the new version of the delivered folder ${dest} into place (EPERM: operation not permitted, rename); `
      + 'the installed version stays, and the next pull tries again',
    );
    expect(tree(dest)).toEqual({ 'HOOK.yaml': 'v1\n' });
  });

  it('records the new version and warns when the previous one cannot be removed, which the next pull removes', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n')], ledger: undefined });
    const rm = fs.promises.rm.bind(fs.promises);
    const denied = Object.assign(new Error('EACCES: permission denied, rmdir'), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => (String(target).includes('.block-secrets.old-') ? Promise.reject(denied) : rm(target, options)));
    const { log } = await import('../utils/logger.js');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const ledger = openLedger({});

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v2\n')], ledger });

    const [message] = warn.mock.calls.map(([text]) => String(text));
    expect([tree(dest), Object.keys(ledger.hashes), warn.mock.calls.length]).toEqual([{ 'HOOK.yaml': 'v2\n' }, [path.join(dest, 'HOOK.yaml')], 1]);
    expect(message).toMatch(/^Could not remove .*\.block-secrets\.old-[0-9a-f]{8}, the previous version of .*block-secrets \(EACCES: permission denied, rmdir\)\. The new version is in place; the next pull removes it\.$/);
  });

  it('removes what an interrupted delivery left beside the folder', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    fs.mkdirSync(path.join(path.dirname(dest), '.block-secrets.new-0badc0de'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(dest), '.block-secrets.new-0badc0de', 'HOOK.yaml'), 'half written\n');
    fs.mkdirSync(path.join(path.dirname(dest), '.block-secrets.old-0badc0de'), { recursive: true });

    await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n')], ledger: undefined });

    expect(tree(path.dirname(dest))).toEqual({ 'block-secrets/HOOK.yaml': 'v1\n' });
  });
});

describe('DeliveredFolders.prune', () => {
  it('removes each folder of the type the scope no longer delivers, and takes it off the ledger', async () => {
    const dataHome = tempDir();
    const localConfig: LocalConfig = { username: 't', additionalRoles: [], scope: 'user', dataHome, repo: { localPath: path.join(dataHome, 'repo'), remote: 'acme/team' } };
    const ledger = openLedger({});
    const at = (namespace: string | null, name: string): string => DeliveredFolders.pathOf(localConfig, { type: 'hooks', namespace, name });

    for (const dest of [at(null, 'lint'), at(null, 'format'), at('payments', 'audit'), at('billing', 'audit')]) {
      await DeliveredFolders.deliver({ dest, earlierFiles: 'keep', files: [file('HOOK.yaml', 'x\n')], ledger });
    }

    const removed = await DeliveredFolders.prune({ localConfig, type: 'hooks', keep: [at(null, 'lint'), at('payments', 'audit')], ledger });

    expect([removed.sort(), tree(path.join(dataHome, 'hooks')), Object.keys(ledger.hashes).sort()]).toEqual([
      [path.join(dataHome, 'hooks', 'billing'), at(null, 'format')].sort(),
      { 'lint/HOOK.yaml': 'x\n', 'payments/audit/HOOK.yaml': 'x\n' },
      [path.join(at(null, 'lint'), 'HOOK.yaml'), path.join(at('payments', 'audit'), 'HOOK.yaml')].sort(),
    ]);
  });

  it('keeps a folder the team renamed only in case, as it is still delivered where a case-insensitive file system finds it', async () => {
    const dataHome = tempDir();
    const localConfig: LocalConfig = { username: 't', additionalRoles: [], scope: 'user', dataHome, repo: { localPath: path.join(dataHome, 'repo'), remote: 'acme/team' } };
    const ledger = openLedger({});
    const at = (namespace: string | null, name: string): string => DeliveredFolders.pathOf(localConfig, { type: 'mcp', namespace, name });
    await DeliveredFolders.deliver({ dest: at('Payments', 'Jira'), earlierFiles: 'keep', files: [file('MCP.yaml', 'x\n')], ledger });
    await DeliveredFolders.deliver({ dest: at('payments', 'jira'), earlierFiles: 'keep', files: [file('MCP.yaml', 'x\n')], ledger });

    await DeliveredFolders.prune({ localConfig, type: 'mcp', keep: [at('payments', 'jira')], ledger });

    expect(fs.readFileSync(path.join(at('payments', 'jira'), 'MCP.yaml'), 'utf8')).toBe('x\n');
  });
});

describe('DeliveredFolders.sync', () => {
  const scope = (): LocalConfig => {
    const dataHome = tempDir();

    return { username: 't', additionalRoles: [], scope: 'user', dataHome, repo: { localPath: path.join(dataHome, 'repo'), remote: 'acme/team' } };
  };

  it('leaves every folder as installed when one cannot take its new version, so the installed hooks still match them', async () => {
    const localConfig = scope();
    const at = (name: string): string => DeliveredFolders.pathOf(localConfig, { type: 'hooks', namespace: null, name });
    await DeliveredFolders.sync({ localConfig, type: 'hooks', ledger: undefined, prune: true, folders: [
      { dest: at('format'), earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n'), file('fmt.sh', 'v1\n')] },
      { dest: at('lint'), earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n'), file('scan.sh', 'v1\n')] },
    ] });
    const rename = fs.promises.rename.bind(fs.promises);
    const denied = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    // format moves aside and takes its new version; lint moves aside, and its new version is refused.
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(rename).mockImplementationOnce(rename).mockImplementationOnce(rename).mockRejectedValueOnce(denied);

    await expect(DeliveredFolders.sync({ localConfig, type: 'hooks', ledger: undefined, prune: true, folders: [
      { dest: at('format'), earlierFiles: 'keep', files: [file('HOOK.yaml', 'v2\n'), file('check.sh', 'v2\n')] },
      { dest: at('lint'), earlierFiles: 'keep', files: [file('HOOK.yaml', 'v2\n'), file('check.sh', 'v2\n')] },
    ] })).rejects.toThrow(`could not move the new version of the delivered folder ${at('lint')} into place`);

    expect(tree(path.dirname(at('lint')))).toEqual({
      'format/HOOK.yaml': 'v1\n', 'format/fmt.sh': 'v1\n', 'lint/HOOK.yaml': 'v1\n', 'lint/scan.sh': 'v1\n',
    });
  });

  it('warns about a folder the team dropped that cannot be removed, keeps it, and delivers the rest', async () => {
    const localConfig = scope();
    const at = (name: string): string => DeliveredFolders.pathOf(localConfig, { type: 'hooks', namespace: null, name });
    await DeliveredFolders.sync({ localConfig, type: 'hooks', ledger: undefined, prune: true, folders: [{ dest: at('old'), earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n')] }] });
    const busy = Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${at('old')}'`), { code: 'EBUSY' });
    vi.spyOn(fse, 'remove').mockRejectedValueOnce(busy);
    const { log } = await import('../utils/logger.js');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    await DeliveredFolders.sync({ localConfig, type: 'hooks', ledger: undefined, prune: true, folders: [{ dest: at('lint'), earlierFiles: 'keep', files: [file('HOOK.yaml', 'v1\n')] }] });

    expect([tree(path.dirname(at('lint'))), warn.mock.calls.map(([message]) => String(message))]).toEqual([
      { 'lint/HOOK.yaml': 'v1\n', 'old/HOOK.yaml': 'v1\n' },
      [`Could not remove ${at('old')}, which the team no longer delivers (EBUSY: resource busy or locked, rmdir '${at('old')}'). Nothing names it any more; the next pull removes it.`],
    ]);
  });
});

describe('DeliveredFolders.render', () => {
  const dest = path.join(os.tmpdir(), 'home', '.teamai', 'hooks', 'lint');
  const forward = dest.split(path.sep).join('/');

  it('puts the folder\'s path, with forward slashes, in place of each ${TEAMAI_<TYPE>_DIR}, and nothing else', () => {
    expect(DeliveredFolders.render('bash "${TEAMAI_HOOK_DIR}/scan.sh" ${TEAMAI_HOOK_DIR}/x $TEAMAI_HOOK_DIR ${TEAMAI_RULE_DIR}', { type: 'hooks', dest }))
      .toBe(`bash "${forward}/scan.sh" ${forward}/x $TEAMAI_HOOK_DIR \${TEAMAI_RULE_DIR}`);
  });

  it('renders in one pass: a path that holds the variable is not read again', () => {
    const odd = path.join(os.tmpdir(), '${TEAMAI_HOOK_DIR}');

    expect(DeliveredFolders.render('cat ${TEAMAI_HOOK_DIR}/a', { type: 'hooks', dest: odd })).toBe(`cat ${odd.split(path.sep).join('/')}/a`);
  });

  it('renders the path from a tool\'s project directory variable when one is given', () => {
    const project = path.join(os.tmpdir(), 'shop-wt');

    expect(DeliveredFolders.render('bash "${TEAMAI_HOOK_DIR}/scan.sh"', {
      type: 'hooks', dest: path.join(project, '.teamai', 'delivered', 'hooks', 'lint'), project: { root: project, variable: '$CLAUDE_PROJECT_DIR' },
    })).toBe('bash "$CLAUDE_PROJECT_DIR/.teamai/delivered/hooks/lint/scan.sh"');
  });
});

describe('DELIVERED_DIR', () => {
  it('is reserved under .teamai/: no resource type or layout reads a directory of that name', async () => {
    const { RESOURCE_TYPES } = await import('../types.js');
    const { RESOURCE_LAYOUTS } = await import('../resources/resolver.js');
    const { DELIVERED_DIR } = await import('../resources/delivered-folders.js');

    expect([...RESOURCE_TYPES, ...Object.values(RESOURCE_LAYOUTS).map((layout) => layout.dir)]).not.toContain(DELIVERED_DIR);
  });
});
