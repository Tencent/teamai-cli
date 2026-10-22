import path from 'node:path';
import fs from 'node:fs/promises';
import { ResourceHandler } from './base.js';
import { loadStateForScope } from '../config.js';
import { isSelfMode, type LocalConfig, type ResourceItem, type ResourceType, type State, type TeamaiConfig } from '../types.js';
import { namespaceOfPlacedPath, type PlaceableType } from '../push-namespaces.js';
import { ensureDir, fileContentEqual, pathExists } from '../utils/fs.js';
import { hashObject } from '../utils/git.js';

export async function listRepoFilesRecursive(dir: string, baseDir = dir): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await listRepoFilesRecursive(full, baseDir);
        files.push(...nested);
      } else if (entry.isFile()) {
        files.push(path.relative(baseDir, full).split(path.sep).join('/'));
      }
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * The author's shared-root copy of a resource an earlier push placed elsewhere,
 * judged against what that push delivered (`state.placements`). Unchanged is
 * `'delivered'`, whatever the team did to the placed file since. An edit goes
 * to the placed file, unless that file changed too: pushing would then
 * overwrite the other change, so the scan stops. Null when no record applies.
 */
export async function placedCopy(
  type: ResourceType,
  name: string,
  authorPath: string,
  activeFile: string,
  localConfig: LocalConfig,
  placements: NonNullable<State['placements']>,
): Promise<ResourceItem | 'delivered' | null> {
  const record = placements[`${type}:${authorPath}`];
  if (!record) return null;
  const repoPath = localConfig.repo.localPath;
  const placedFile = path.join(repoPath, ...record.path.split('/'));
  if (!await pathExists(placedFile)) return null;
  const [mine, theirs] = await Promise.all([hashObject(repoPath, activeFile), hashObject(repoPath, placedFile)]);
  if (!mine || !theirs) {
    throw new Error(`git could not read ${authorPath} or ${record.path} to compare them with what your push delivered`);
  }
  if (mine === record.blob) return 'delivered';
  if (theirs !== record.blob) {
    throw new Error(
      `${record.path} changed on the team repo after your ${authorPath} was placed there, and ${authorPath} `
      + `changed too, so pushing it would overwrite that change. Merge your edit into ${record.path}, keeping the team's change there, then delete ${authorPath}`,
    );
  }
  const item: ResourceItem & { prePlacementPath: string } = {
    name,
    type,
    sourcePath: activeFile,
    relativePath: record.path,
    namespace: namespaceOfPlacedPath(type as PlaceableType, record.path),
    status: 'modified',
    prePlacementPath: authorPath,
  };
  return item;
}

export async function scanRepoResourceForPush(
  type: ResourceType,
  dir: string,
  _teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  fileFilter?: (file: string) => boolean,
): Promise<ResourceItem[]> {
  if (isSelfMode(localConfig) && localConfig.projectRoot) {
    const activeRoot = path.join(localConfig.projectRoot, '.teamai', dir);
    const baselineRoot = path.join(localConfig.repo.localPath, dir);
    if (!await pathExists(activeRoot)) return [];

    const items: ResourceItem[] = [];
    // Where an earlier push placed a resource this machine still edits at its
    // shared-root path (`state.placements`, recorded once the PR landed). The
    // author's copy never moves, so without the record every later scan reads
    // it as brand new and collides with the placed copy it cannot see.
    const placements = (await loadStateForScope(localConfig)).placements ?? {};
    const files = await listRepoFilesRecursive(activeRoot);
    for (const rel of files) {
      if (fileFilter && !fileFilter(rel)) continue;
      const activeFile = path.join(activeRoot, ...rel.split('/'));
      const baseFile = path.join(baselineRoot, ...rel.split('/'));
      const relativePath = `${dir}/${rel}`;
      const atBaseline = await pathExists(baseFile);
      if (atBaseline && await fileContentEqual(activeFile, baseFile)) continue;
      if (!atBaseline) {
        const placed = await placedCopy(type, rel, relativePath, activeFile, localConfig, placements);
        if (placed === 'delivered') continue;
        if (placed) {
          items.push(placed);
          continue;
        }
      }
      items.push({
        name: rel,
        type,
        sourcePath: activeFile,
        relativePath,
        status: atBaseline ? 'modified' : 'new',
      });
    }
    return items;
  }

  const repoPath = localConfig.repo.localPath;
  const targetDir = path.join(repoPath, dir);
  if (!await pathExists(targetDir)) return [];

  let changedFiles: Set<string> | null = null;
  let untrackedFiles: Set<string> = new Set();
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const [changedRes, untrackedRes] = await Promise.all([
      execFileAsync('git', ['ls-files', '-z', '--modified', '--others', '--exclude-standard', '--', dir], { cwd: repoPath }),
      execFileAsync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', dir], { cwd: repoPath }),
    ]);
    changedFiles = new Set(changedRes.stdout.split('\0').filter(Boolean));
    untrackedFiles = new Set(untrackedRes.stdout.split('\0').filter(Boolean));
  } catch {
    changedFiles = null;
  }

  const allFiles = await listRepoFilesRecursive(targetDir);
  const items: ResourceItem[] = [];
  for (const rel of allFiles) {
    if (fileFilter && !fileFilter(rel)) continue;
    const relativePath = `${dir}/${rel}`;
    if (changedFiles && !changedFiles.has(relativePath)) continue;
    const sourcePath = path.join(targetDir, ...rel.split('/'));
    const status = untrackedFiles.has(relativePath) || !changedFiles ? 'new' : 'modified';
    items.push({
      name: rel,
      type,
      sourcePath,
      relativePath,
      status,
    });
  }
  return items;
}

export async function pushRepoResourceItem(
  item: ResourceItem,
  localConfig: LocalConfig,
): Promise<void> {
  const dest = path.resolve(localConfig.repo.localPath, ...item.relativePath.split('/'));
  const originalSource = path.resolve(item.sourcePath);
  if (originalSource !== dest) {
    await ensureDir(path.dirname(dest));
    // Byte-level copy: a PNG or other binary under docs/ must survive intact.
    // readFileSafe/writeFile are UTF-8 text I/O and corrupt non-text bytes
    // (e.g. 0x89 → U+FFFD → 0xEF 0xBF 0xBD on round-trip).
    await fs.copyFile(originalSource, dest);
    const repoRoot = path.resolve(localConfig.repo.localPath);
    if (originalSource.startsWith(repoRoot + path.sep)) {
      await fs.rm(originalSource, { force: true });
    }
  }
}

export class RepoResourceHandler extends ResourceHandler {
  constructor(
    readonly type: ResourceType,
    readonly dir: string = type,
    readonly fileFilter?: (file: string) => boolean,
  ) {
    super();
  }

  async scanLocalForPush(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<ResourceItem[]> {
    return scanRepoResourceForPush(this.type, this.dir, teamConfig, localConfig, this.fileFilter);
  }

  async scanTeamForPull(
    _teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<ResourceItem[]> {
    const dirPath = path.join(localConfig.repo.localPath, this.dir);
    if (!await pathExists(dirPath)) return [];
    const files = await listRepoFilesRecursive(dirPath);
    return files
      .filter((file) => !this.fileFilter || this.fileFilter(file))
      .map((file) => ({
        name: file,
        type: this.type,
        sourcePath: path.join(dirPath, ...file.split('/')),
        relativePath: `${this.dir}/${file}`,
      }));
  }

  async pushItem(
    item: ResourceItem,
    _teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<void> {
    await pushRepoResourceItem(item, localConfig);
  }

  async pullItem(
    _item: ResourceItem,
    _teamConfig: TeamaiConfig,
    _localConfig: LocalConfig,
  ): Promise<void> {
    // Pull synchronization is orchestrated by high-level sync routines in pull.ts and workflow cache.
  }

  async removeItem(
    name: string,
    _teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<string[]> {
    const target = path.resolve(localConfig.repo.localPath, this.dir, ...name.split('/'));
    await fs.rm(target, { force: true });
    return [name];
  }
}
