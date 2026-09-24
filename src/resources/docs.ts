import path from 'node:path';
import fse from 'fs-extra';
import { ResourceHandler } from './base.js';
import { resolveBaseDir, type ResourceItem, type TeamaiConfig, type LocalConfig } from '../types.js';
import { expandHome } from '../utils/fs.js';
import { log } from '../utils/logger.js';

/**
 * The single directory the team docs bundle is copied into. In project scope a
 * `~/`-prefixed `sharing.docs.localDir` is relative to the project root, not to
 * HOME. `pull` writes here and `doctor` checks here (#598).
 */
export function resolveDocsDestination(teamConfig: TeamaiConfig, localConfig: LocalConfig): string {
  const localDir = teamConfig.sharing.docs.localDir;
  if (localConfig.scope === 'project' && localConfig.projectRoot && localDir.startsWith('~/')) {
    return path.join(localConfig.projectRoot, localDir.substring(2));
  }
  const expanded = expandHome(localDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(resolveBaseDir(localConfig), expanded);
}

/** Only absence means an empty bundle; permission and I/O errors must stop pruning. */
async function readEntries(dir: string) {
  try {
    return await fse.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Files in the docs mirror, including links themselves but never their targets. */
export async function listDocFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readEntries(expandHome(dir))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const nested = await listDocFiles(path.join(dir, entry.name));
      files.push(...nested.map(file => `${entry.name}/${file}`));
    } else {
      files.push(entry.name);
    }
  }
  return files;
}

/** Empty leaf directories that pruning would remove; never follow links or hidden entries. */
export async function listStaleDocDirectories(source: string | undefined, destination: string): Promise<string[]> {
  const sourceEntries = new Map((source ? await readEntries(source) : []).map(entry => [entry.name, entry]));
  const stale: string[] = [];
  for (const entry of await readEntries(destination)) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const sourceEntry = sourceEntries.get(entry.name);
    if (sourceEntry && !sourceEntry.isDirectory()) continue;
    const target = path.join(destination, entry.name);
    if (!sourceEntry && (await readEntries(target)).length === 0) {
      stale.push(`${entry.name}/`);
    } else {
      const nested = await listStaleDocDirectories(sourceEntry ? path.join(source!, entry.name) : undefined, target);
      stale.push(...nested.map(dir => `${entry.name}/${dir}`));
    }
  }
  return stale;
}

/** Remove stale visible entries without following local symlinks or removing dotfiles. */
async function pruneDocs(source: string | undefined, destination: string): Promise<void> {
  const sourceEntries = new Map((source ? await readEntries(source) : []).map(e => [e.name, e]));
  for (const entry of await readEntries(destination)) {
    if (entry.name.startsWith('.')) continue;
    const target = path.join(destination, entry.name);
    const sourceEntry = sourceEntries.get(entry.name);
    if (entry.isDirectory()) {
      if (sourceEntry && !sourceEntry.isDirectory()) continue;
      await pruneDocs(sourceEntry ? path.join(source!, entry.name) : undefined, target);
      // A stale directory containing hidden local files must survive.
      if (!sourceEntry && (await fse.readdir(target)).length === 0) await fse.rmdir(target);
    } else if (!sourceEntry) {
      await fse.unlink(target);
    }
  }
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function hasHiddenEntries(dir: string): Promise<boolean> {
  for (const entry of await readEntries(dir)) {
    if (entry.name.startsWith('.')) return true;
    if (entry.isDirectory() && await hasHiddenEntries(path.join(dir, entry.name))) return true;
  }
  return false;
}

/** Find replacements without traversing destination links or touching either tree. */
async function findDocConflicts(source: string, destination: string): Promise<Array<{ source: string; target: string }>> {
  const conflicts: Array<{ source: string; target: string }> = [];
  const localEntries = new Map((await readEntries(destination)).map(entry => [entry.name, entry]));
  for (const entry of await readEntries(source)) {
    if (entry.name.startsWith('.')) continue;
    const local = localEntries.get(entry.name);
    if (!local) continue;
    const src = path.join(source, entry.name);
    const target = path.join(destination, entry.name);
    if (local.isSymbolicLink() || entry.isSymbolicLink() || local.isDirectory() !== entry.isDirectory()) {
      if (local.isDirectory() && await hasHiddenEntries(target)) {
        throw new Error(`Cannot replace ${target}: it contains hidden local entries. Move them before retrying.`);
      }
      conflicts.push({ source: src, target });
    } else if (entry.isDirectory()) {
      conflicts.push(...await findDocConflicts(src, target));
    }
  }
  return conflicts;
}

async function copyDocs(source: string, destination: string): Promise<void> {
  const conflicts = await findDocConflicts(source, destination);
  const staging = conflicts.length ? await fse.mkdtemp(path.join(destination, '.teamai-docs-')) : undefined;
  const moved: Array<{ target: string; backup: string }> = [];
  const visible = (src: string) => !path.basename(src).startsWith('.');
  try {
    // Prepare replacements while the old entries are still in place. A copy
    // failure must not remove the directory/file it was meant to replace.
    for (const [index, conflict] of conflicts.entries()) {
      await fse.copy(conflict.source, path.join(staging!, `new-${index}`), { filter: visible });
    }
    const replacedSources = new Set(conflicts.map(conflict => conflict.source));
    await fse.copy(source, destination, {
      overwrite: true,
      filter: src => visible(src) && !replacedSources.has(src),
    });
    // Copying has finished before any rename: no copy worker can write into
    // a conflicting path while it is being replaced or restored.
    for (const [index, conflict] of conflicts.entries()) {
      const backup = path.join(staging!, `old-${index}`);
      await fse.rename(conflict.target, backup);
      moved.push({ target: conflict.target, backup });
      await fse.rename(path.join(staging!, `new-${index}`), conflict.target);
    }
  } catch (error) {
    for (const { target, backup } of moved.reverse()) {
      await fse.remove(target);
      await fse.rename(backup, target);
    }
    // If restoration itself fails, leave the backup directory for recovery.
    if (staging) await fse.remove(staging);
    throw error;
  }
  if (staging) await fse.remove(staging);
}

export class DocsHandler extends ResourceHandler {
  readonly type = 'docs' as const;

  async scanLocalForPush(_teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<ResourceItem[]> {
    // Docs are managed directly in team repo
    return [];
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const docsDir = path.join(localConfig.repo.localPath, 'docs');
    // Nested documents are synced as part of the same bundle.
    if (await this.countDocFiles(docsDir) === 0) return [];

    return [{
      name: 'docs',
      type: 'docs',
      sourcePath: docsDir,
      relativePath: 'docs/',
    }];
  }

  async countDocFiles(sourcePath: string): Promise<number> {
    return (await listDocFiles(sourcePath)).length;
  }

  async pushItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op
  }

  /**
   * Mirror non-hidden docs from the team repo to the dedicated local directory.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const localDocsDir = resolveDocsDestination(teamConfig, localConfig);
    const src = expandHome(item.sourcePath);
    // Validate the source before touching the destination, including an empty bundle.
    const entries = await readEntries(src);
    await fse.ensureDir(localDocsDir);
    const destination = await fse.realpath(localDocsDir);
    const repo = await fse.realpath(localConfig.repo.localPath);
    const base = await fse.realpath(resolveBaseDir(localConfig));
    // In single-repo mode the configured docs directory may already be the source.
    if (destination === path.join(repo, 'docs')) return;
    if (containsPath(destination, base) || containsPath(destination, repo) || containsPath(repo, destination)) {
      throw new Error('Docs pruning requires a dedicated localDir that does not overlap the team repo or contain the home or project root.');
    }
    if (entries.length > 0) {
      await copyDocs(src, localDocsDir);
    }
    // Copy first: a failed copy must not trigger deletion of the previous bundle.
    await pruneDocs(src, localDocsDir);
    log.debug(`Synced docs → ${localDocsDir}`);
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Removing docs is not supported via remove command. Delete from team repo directly.');
    return [];
  }
}
