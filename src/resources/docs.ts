import path from 'node:path';
import fse from 'fs-extra';
import { ResourceHandler } from './base.js';
import { resolveBaseDir, type ResourceItem, type TeamaiConfig, type LocalConfig } from '../types.js';
import { expandHome, listFilesRecursive } from '../utils/fs.js';
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
    const files = await listFilesRecursive(sourcePath);
    return files.filter(f => f.split('/').every(segment => !segment.startsWith('.'))).length;
  }

  async pushItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op
  }

  /**
   * Mirror non-hidden docs from the team repo to the dedicated local directory.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const localDocsDir = resolveDocsDestination(teamConfig, localConfig);
    try {
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
        await fse.copy(src, localDocsDir, {
          overwrite: true,
          filter: (srcPath: string) => !path.basename(srcPath).startsWith('.'),
        });
      }
      // Copy first: a failed copy must not trigger deletion of the previous bundle.
      await pruneDocs(src, localDocsDir);
      log.debug(`Synced docs → ${localDocsDir}`);
    } catch (e) {
      log.warn(`Failed to sync docs: ${(e as Error).message}`);
    }
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Removing docs is not supported via remove command. Delete from team repo directly.');
    return [];
  }
}
