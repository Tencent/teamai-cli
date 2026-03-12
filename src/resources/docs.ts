import path from 'node:path';
import fse from 'fs-extra';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig } from '../types.js';
import { pathExists, expandHome, listFiles } from '../utils/fs.js';
import { log } from '../utils/logger.js';

export class DocsHandler extends ResourceHandler {
  readonly type = 'docs' as const;

  async scanLocalForPush(_teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<ResourceItem[]> {
    // Docs are managed directly in team repo
    return [];
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const docsDir = path.join(localConfig.repo.localPath, 'docs');
    if (!await pathExists(docsDir)) return [];

    // Check if there are actual doc files (ignore .gitkeep and other dot files)
    const files = await listFiles(docsDir);
    const realFiles = files.filter(f => !f.startsWith('.'));
    if (realFiles.length === 0) return [];

    return [{
      name: 'docs',
      type: 'docs',
      sourcePath: docsDir,
      relativePath: 'docs/',
    }];
  }

  async countDocFiles(sourcePath: string): Promise<number> {
    const files = await listFiles(sourcePath);
    return files.filter(f => !f.startsWith('.')).length;
  }

  async pushItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op
  }

  /**
   * Sync docs from team repo to local docs directory.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    const localDocsDir = expandHome(teamConfig.sharing.docs.localDir);
    try {
      const src = expandHome(item.sourcePath);
      await fse.copy(src, localDocsDir, {
        overwrite: true,
        filter: (srcPath: string) => !path.basename(srcPath).startsWith('.'),
      });
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
