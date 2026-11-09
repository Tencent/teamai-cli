import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHash, openLedger } from '../resources/delivered-copies.js';
import { DeliveredFolders } from '../resources/delivered-folders.js';
import type { FolderFile } from '../resources/folder-files.js';
import type { LocalConfig } from '../types.js';

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

  const singleRepo: LocalConfig = {
    ...base, scope: 'project', projectRoot: path.join(home, 'shop-wt'), dataHome: path.join(home, '.teamai', 'projects', 'shop-1a2b'),
    repo: { localPath: path.join(home, 'shop-wt', '.teamai'), remote: 'acme/shop', kind: 'self', businessRepoRoot: path.join(home, 'shop-wt') },
  };

  it.each([
    ['the user scope', user, null, path.join(home, '.teamai', 'hooks', 'lint')],
    ['the user scope, in a namespace', user, 'payments', path.join(home, '.teamai', 'hooks', 'payments', 'lint')],
    ['a workspace with a remote team, shared by its worktrees', workspace, null, path.join(home, '.teamai', 'projects', 'shop-1a2b', 'hooks', 'lint')],
    ['a single-repo worktree, in its own checkout', singleRepo, 'payments', path.join(home, 'shop-wt', '.teamai', 'delivered', 'hooks', 'payments', 'lint')],
  ] as const)('puts a folder of %s in the data home of the scope that owns it', (_case, localConfig, namespace, expected) => {
    expect(DeliveredFolders.pathOf(localConfig, { type: 'hooks', namespace, name: 'lint' })).toBe(expected);
  });
});

describe('DeliveredFolders.deliver', () => {
  it('writes every file of the folder at its path and records each in the ledger', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    const ledger = openLedger({});

    await DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'event: Stop\n'), file('lib/scan.sh', 'echo scan\n', true)], ledger });

    expect(tree(path.dirname(dest))).toEqual({ 'block-secrets/HOOK.yaml': 'event: Stop\n', 'block-secrets/lib/scan.sh': 'echo scan\n' });
    expect(ledger.hashes).toEqual({
      [path.join(dest, 'HOOK.yaml')]: contentHash('event: Stop\n'),
      [path.join(dest, 'lib', 'scan.sh')]: contentHash('echo scan\n'),
    });
  });

  it('replaces the previous version whole, at the same path, and leaves nothing beside it', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    const ledger = openLedger({});
    await DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'v1\n'), file('old.sh', 'old\n')], ledger });

    await DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'v2\n'), file('new.sh', 'new\n')], ledger });

    expect([tree(path.dirname(dest)), Object.keys(ledger.hashes).sort()]).toEqual([
      { 'block-secrets/HOOK.yaml': 'v2\n', 'block-secrets/new.sh': 'new\n' },
      [path.join(dest, 'HOOK.yaml'), path.join(dest, 'new.sh')],
    ]);
  });

  it('leaves a folder that already holds the version in place, and records it', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    const files = [file('HOOK.yaml', 'v1\n'), file('scan.sh', 'echo scan\n', true)];
    await DeliveredFolders.deliver({ dest, files, ledger: undefined });
    const before = fs.statSync(dest).ino;
    const ledger = openLedger({});

    await DeliveredFolders.deliver({ dest, files, ledger });

    expect([fs.statSync(dest).ino, Object.keys(ledger.hashes).length]).toEqual([before, 2]);
  });

  it('names the folder it cannot move aside, and why, and leaves the installed version in place', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    await DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'v1\n')], ledger: undefined });
    // What Windows answers while a hook still runs from the folder.
    const busy = Object.assign(new Error(`EBUSY: resource busy or locked, rename '${dest}'`), { code: 'EBUSY' });
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(busy);

    await expect(DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'v2\n')], ledger: undefined })).rejects.toThrow(
      `could not replace the delivered folder ${dest} (EBUSY: resource busy or locked, rename '${dest}'); `
      + 'a program running from it, such as a hook on Windows, can hold it, so close that program',
    );
    expect(tree(dest)).toEqual({ 'HOOK.yaml': 'v1\n' });
  });

  it('puts the installed version back when the new one cannot be moved into place, and names the folder and why', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    await DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'v1\n')], ledger: undefined });
    const rename = fs.promises.rename.bind(fs.promises);
    // What Windows can answer while a scanner holds the new version's files: the old one is already out of the way.
    const denied = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(rename).mockRejectedValueOnce(denied);

    await expect(DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'v2\n')], ledger: undefined })).rejects.toThrow(
      `could not move the new version of the delivered folder ${dest} into place (EPERM: operation not permitted, rename); `
      + 'the installed version stays, and the next pull tries again',
    );
    expect(tree(dest)).toEqual({ 'HOOK.yaml': 'v1\n' });
  });

  it('removes what an interrupted delivery left beside the folder', async () => {
    const dest = path.join(tempDir(), 'hooks', 'block-secrets');
    fs.mkdirSync(path.join(path.dirname(dest), '.block-secrets.new-0badc0de'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(dest), '.block-secrets.new-0badc0de', 'HOOK.yaml'), 'half written\n');
    fs.mkdirSync(path.join(path.dirname(dest), '.block-secrets.old-0badc0de'), { recursive: true });

    await DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'v1\n')], ledger: undefined });

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
      await DeliveredFolders.deliver({ dest, files: [file('HOOK.yaml', 'x\n')], ledger });
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
    await DeliveredFolders.deliver({ dest: at('Payments', 'Jira'), files: [file('MCP.yaml', 'x\n')], ledger });
    await DeliveredFolders.deliver({ dest: at('payments', 'jira'), files: [file('MCP.yaml', 'x\n')], ledger });

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
      { dest: at('format'), files: [file('HOOK.yaml', 'v1\n'), file('fmt.sh', 'v1\n')] },
      { dest: at('lint'), files: [file('HOOK.yaml', 'v1\n'), file('scan.sh', 'v1\n')] },
    ] });
    const rename = fs.promises.rename.bind(fs.promises);
    const denied = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    // format moves aside and takes its new version; lint moves aside, and its new version is refused.
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(rename).mockImplementationOnce(rename).mockImplementationOnce(rename).mockRejectedValueOnce(denied);

    await expect(DeliveredFolders.sync({ localConfig, type: 'hooks', ledger: undefined, prune: true, folders: [
      { dest: at('format'), files: [file('HOOK.yaml', 'v2\n'), file('check.sh', 'v2\n')] },
      { dest: at('lint'), files: [file('HOOK.yaml', 'v2\n'), file('check.sh', 'v2\n')] },
    ] })).rejects.toThrow(`could not move the new version of the delivered folder ${at('lint')} into place`);

    expect(tree(path.dirname(at('lint')))).toEqual({
      'format/HOOK.yaml': 'v1\n', 'format/fmt.sh': 'v1\n', 'lint/HOOK.yaml': 'v1\n', 'lint/scan.sh': 'v1\n',
    });
  });

  it('warns about a folder the team dropped that cannot be removed, keeps it, and delivers the rest', async () => {
    const localConfig = scope();
    const at = (name: string): string => DeliveredFolders.pathOf(localConfig, { type: 'hooks', namespace: null, name });
    await DeliveredFolders.sync({ localConfig, type: 'hooks', ledger: undefined, prune: true, folders: [{ dest: at('old'), files: [file('HOOK.yaml', 'v1\n')] }] });
    const busy = Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${at('old')}'`), { code: 'EBUSY' });
    vi.spyOn(fse, 'remove').mockRejectedValueOnce(busy);
    const { log } = await import('../utils/logger.js');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    await DeliveredFolders.sync({ localConfig, type: 'hooks', ledger: undefined, prune: true, folders: [{ dest: at('lint'), files: [file('HOOK.yaml', 'v1\n')] }] });

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
