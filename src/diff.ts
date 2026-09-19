import { autoDetectInit } from './config.js';
import { getAllHandlers } from './resources/index.js';
import { log } from './utils/logger.js';
import { dirTeamSubsetEqual } from './utils/fs.js';
import type { GlobalOptions, ResourceType, ResourceDiffDetail, DiffResult, ResourceItem } from './types.js';

export interface DiffOptions extends GlobalOptions {
  type?: ResourceType;
  tool?: string;
}

/**
 * Show differences between local resources and team repo.
 * Currently shows local resources not yet pushed to the team repo.
 */
export async function diff(options: DiffOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();

  log.info('Checking local resources not pushed to team repo...\n');

  const handlers = getAllHandlers();
  const results: ResourceDiffDetail[] = [];

  for (const handler of handlers) {
    // Filter by type if specified
    if (options.type && handler.type !== options.type) continue;

    const localItems = await handler.scanLocalForPush(teamConfig, localConfig);

    for (const item of localItems) {
      const detail: ResourceDiffDetail = {
        type: handler.type,
        name: item.name,
        status: item.status === 'modified' ? 'modified' : 'added',
        localPath: item.sourcePath,
        namespace: item.namespace,
      };

      // Try to get last modified time
      try {
        const fs = await import('node:fs/promises');
        const stat = await fs.stat(item.sourcePath);
        detail.lastModified = stat.mtime;
      } catch {
        // Ignore stat errors
      }

      results.push(detail);
    }
  }

  // Sort by type then name
  results.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });

  // Calculate summary
  const summary = {
    added: results.filter((r) => r.status === 'added').length,
    modified: results.filter((r) => r.status === 'modified').length,
    removed: results.filter((r) => r.status === 'removed').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
  };

  // Output results
  if (results.length === 0) {
    log.success('All local resources are in sync with team repo.');
    return;
  }

  console.log('Local resources not pushed to team repo:\n');

  // Group by type
  const byType = new Map<ResourceType, ResourceDiffDetail[]>();
  for (const r of results) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  for (const [type, items] of byType) {
    console.log(`  ${type.charAt(0).toUpperCase() + type.slice(1)}:`);
    for (const item of items) {
      const statusChar = item.status === 'added' ? 'A' : item.status === 'modified' ? 'M' : 'D';
      const modifiedStr = item.lastModified ? ` (${formatDate(item.lastModified)})` : '';
      const nsStr = item.namespace ? ` [${item.namespace}]` : '';
      console.log(`    ${statusChar}  ${item.name}${nsStr}${modifiedStr}`);
    }
    console.log('');
  }

  // Summary
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`${summary.added} added`);
  if (summary.modified > 0) parts.push(`${summary.modified} modified`);
  if (summary.removed > 0) parts.push(`${summary.removed} removed`);

  console.log(`Summary: ${parts.join(', ')}`);
}

/**
 * Format date to readable string
 */
function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toISOString().split('T')[0];
}
