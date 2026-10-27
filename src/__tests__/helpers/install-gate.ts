import { installOf, isInstalledFor, locate, type Resource } from '../../locate.js';
import { TeamaiConfigSchema, type LocalConfig } from '../../types.js';

/** Whether `locate` counts `tool` installed for `resource` under `config`, with the built-in tool paths. */
export async function isInstalled(tool: string, resource: Resource, config: LocalConfig): Promise<boolean> {
  return isInstalledFor(await locate(tool, resource, installOf(TeamaiConfigSchema.parse({ team: 't', repo: 'r' }), config)));
}
