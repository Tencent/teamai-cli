/** Read-only protection for credentials and copies left by removed HTTP/model delivery. */
import fs from 'node:fs';
import path from 'node:path';
import { getUserHome } from './utils/home.js';
import { readFileSafe, readJson } from './utils/fs.js';
import { listWorktrees } from './utils/git.js';
import { gitExcludeFile } from './git-exclude.js';
export async function legacyCheckouts(): Promise<string[]> {
  const home = path.join(getUserHome(), '.teamai', 'local-agent');
  const config = await readJson<{ workspaceBindings?: Record<string, unknown> }>(path.join(home, 'config.json')).catch(() => null);
  const models = await readJson<{ workspaceModels?: Record<string, unknown> }>(path.join(home, 'model-manifest.json')).catch(() => null);
  const manifest = await readJson<{ scopes?: Record<string, unknown> }>(path.join(home, 'manifest.json')).catch(() => null);
  const roots = new Set([...Object.keys(config?.workspaceBindings ?? {}), ...Object.keys(models?.workspaceModels ?? {}),
    ...Object.keys(manifest?.scopes ?? {}).filter(key => key.startsWith('project:')).map(key => key.slice(8))]);
  for (const root of roots) for (const tree of await listWorktrees(root).catch(() => [])) roots.add(tree);
  return [...roots];
}


/** Whether a models file may hold an API key: it exists and is not proven to hold none. */
async function mayHoldModelKey(file: string): Promise<boolean> {
  let content: string | null;
  try {
    content = await readFileSafe(file);
  } catch {
    return true;
  }
  if (content === null) return false;
  try {
    const parsed: unknown = JSON.parse(content);
    const entries = Array.isArray(parsed) ? parsed : (parsed as { models?: unknown } | null)?.models;
    if (entries === undefined && typeof parsed === 'object' && parsed !== null) return false;
    if (!Array.isArray(entries)) return true;
    return entries.some((entry) => typeof entry !== 'object' || entry === null
      || ((entry as { apiKey?: unknown }).apiKey !== undefined && (entry as { apiKey?: unknown }).apiKey !== ''));
  } catch {
    return true;
  }
}


/**
 * The files a line of `excludeFile` (a `credentials` line: model files) still keeps out of
 * git: in each checkout that reads that exclude file, among `roots` and the
 * ones the local agent knows, the file the line names when it is there
 * (`withKey`: when it may hold a key). Null when none of those checkouts reads
 * that exclude file, so nothing here can judge the line.
 */
export async function modelFilesBehind(
  line: string,
  excludeFile: string,
  options: { roots?: string[]; withKey?: boolean } = {},
): Promise<string[] | null> {
  const { mcpExcludePatternPath } = await import('./mcp-git-exclude.js');
  const rel = mcpExcludePatternPath(line);
  let judged = false;
  const files = new Set<string>();
  for (const root of new Set([...options.roots ?? [], ...await legacyCheckouts()])) {
    const placed = await gitExcludeFile(root);
    if (placed?.excludeFile !== excludeFile) continue;
    judged = true;
    const file = path.join(placed.root, rel);
    const there = options.withKey
      ? await mayHoldModelKey(file)
      : await fs.promises.lstat(file).then(() => true, () => false);
    if (there) files.add(file);
  }
  return judged ? [...files] : null;
}
