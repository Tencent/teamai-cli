import path from 'node:path';
import fs from 'node:fs/promises';
import { ResourceHandler } from './base.js';
import { isSelfMode, type LocalConfig, type ResourceItem, type ResourceType, type TeamaiConfig } from '../types.js';
import { ensureDir, fileContentEqual, pathExists, readFileSafe, writeFile } from '../utils/fs.js';

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
    const files = await listRepoFilesRecursive(activeRoot);
    for (const rel of files) {
      if (fileFilter && !fileFilter(rel)) continue;
      const activeFile = path.join(activeRoot, ...rel.split('/'));
      const baseFile = path.join(baselineRoot, ...rel.split('/'));
      const relativePath = `${dir}/${rel}`;
      if (await pathExists(baseFile) && await fileContentEqual(activeFile, baseFile)) continue;
      const status = await pathExists(baseFile) ? 'modified' : 'new';
      items.push({
        name: rel,
        type,
        sourcePath: activeFile,
        relativePath,
        status,
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
  localConfigOrTeamConfig: TeamaiConfig | LocalConfig,
  maybeLocalConfig?: LocalConfig,
): Promise<void> {
  const localConfig = maybeLocalConfig ?? (localConfigOrTeamConfig as LocalConfig);
  const dest = path.resolve(localConfig.repo.localPath, ...item.relativePath.split('/'));
  const originalSource = path.resolve(item.sourcePath);
  if (originalSource !== dest) {
    await ensureDir(path.dirname(dest));
    const content = await readFileSafe(originalSource);
    if (content !== null) {
      await writeFile(dest, content);
    }
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
