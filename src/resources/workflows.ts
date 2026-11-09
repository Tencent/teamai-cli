import path from 'node:path';
import { holdsMarker } from '../folder-markers.js';
import type { LocalConfig, ResourceItem, TeamaiConfig } from '../types.js';
import { WORKFLOW_MARKER } from '../workflow/folder.js';
import { RepoResourceHandler } from './repo-resource.js';

/**
 * The workflow folder `item` lies in, by its path under `workflows/` (`release`, `payments/release`): a directory at the
 * root or in a namespace that holds `WORKFLOW.yaml`. Undefined for a file outside one.
 */
async function folderOf(item: ResourceItem): Promise<{ name: string; dir: string } | undefined> {
  const segments = item.name.split('/');
  const workflowsDir = path.resolve(item.sourcePath, ...segments.map(() => '..'));

  for (const depth of [1, 2]) {
    if (segments.length <= depth) return undefined;
    const dir = path.join(workflowsDir, ...segments.slice(0, depth));

    if (await holdsMarker(dir, WORKFLOW_MARKER)) return { name: segments.slice(0, depth).join('/'), dir };
  }

  return undefined;
}

/** Workflows in a team tree: a `.yaml` file, or a folder that holds `WORKFLOW.yaml` with the files it needs beside it. */
export class WorkflowsHandler extends RepoResourceHandler {
  constructor() {
    super('workflows', 'workflows');
  }

  /** One item per workflow, as `teamai status` counts them: a folder is one, named after it, whatever files it holds. */
  async scanTeamForPull(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const items: ResourceItem[] = [];
    const folders = new Set<string>();

    for (const item of await super.scanTeamForPull(teamConfig, localConfig)) {
      const folder = await folderOf(item);

      if (folder === undefined) {
        if (item.name.endsWith('.yaml')) items.push(item);
        continue;
      }

      if (folders.has(folder.name)) continue;
      folders.add(folder.name);
      items.push({ ...item, name: folder.name, sourcePath: folder.dir, relativePath: `${this.dir}/${folder.name}/` });
    }

    return items;
  }

  /** Every changed `.yaml` file, and every changed file of a workflow folder, whatever its kind. */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const items: ResourceItem[] = [];

    for (const item of await super.scanLocalForPush(teamConfig, localConfig)) {
      if (item.name.endsWith('.yaml') || await folderOf(item) !== undefined) items.push(item);
    }

    return items;
  }
}
