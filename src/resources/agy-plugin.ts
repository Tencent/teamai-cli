import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../utils/fs.js';

/**
 * Antigravity CLI reads a project's MCP servers only from a plugin
 * (`<root>/.agents/plugins/<name>/mcp_config.json`), and a directory is a
 * plugin only with a `plugin.json` beside it. teamai's project servers ride a
 * plugin of its own, named by this manifest.
 */
const MANIFEST = 'plugin.json';
const TEAMAI_PLUGIN = { name: 'teamai' } as const;
/** The servers file of a plugin, which teamai writes only in its own plugin's directory. */
const PLUGIN_MCP_FILE = 'mcp_config.json';

/** Make the directory of `mcpFile` the teamai plugin agy loads, leaving a manifest already there as it is. */
export async function ensureAgyPluginManifest(mcpFile: string): Promise<void> {
  const manifest = path.join(path.dirname(mcpFile), MANIFEST);
  if (fs.existsSync(manifest)) return;
  await writeJsonAtomic(manifest, TEAMAI_PLUGIN);
}

/**
 * Once teamai's emptied `mcpFile` is gone, remove the manifest teamai wrote
 * beside it and the directory left with nothing else. A manifest holding
 * anything but teamai's is the member's plugin, and stays.
 */
export async function removeAgyPluginManifest(mcpFile: string): Promise<void> {
  const dir = path.dirname(mcpFile);
  // Every emptied MCP file comes here; only teamai's plugin directory holds a manifest of teamai's.
  if (path.basename(mcpFile) !== PLUGIN_MCP_FILE || path.basename(dir) !== TEAMAI_PLUGIN.name) return;
  const manifest = path.join(dir, MANIFEST);
  let text: string;
  try {
    text = await fs.promises.readFile(manifest, 'utf8');
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (JSON.stringify(parsed) !== JSON.stringify(TEAMAI_PLUGIN)) return;
  await fs.promises.rm(manifest, { force: true });
  // rmdir takes only an empty directory: `plugins/` goes too when teamai's was its last plugin.
  await fs.promises.rmdir(dir).then(() => fs.promises.rmdir(path.dirname(dir))).catch(() => undefined);
}
