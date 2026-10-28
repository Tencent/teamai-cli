import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDiagnostic, parseWorkflow } from './workflow/parse.js';
import type { CachedWorkflow } from './workflow/types.js';

// ─── Default workflows (#1388) ───────────────────────────
//
//  The CLI ships workflows a team gets without writing them,
//  as workflows/<name>.yaml in the npm package. A team file of
//  the same name replaces one. Only the workflow cache serves
//  them (loadCachedWorkflow, listCachedWorkflows), and only
//  while no team version of that name runs; they are never
//  written to the cache or the team repo.
//

/** `workflows/` in the package root. This file sits one level below it, in src/ and in the bundle in dist/ alike. */
function defaultsDir(): string {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;
  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }
  return path.join(moduleDir, '..', 'workflows');
}

let loaded: ReadonlyMap<string, CachedWorkflow> | undefined;

/** Every default by name, read and parsed once. A shipped file that does not parse is a teamai bug, so it throws. */
function defaults(): ReadonlyMap<string, CachedWorkflow> {
  if (loaded) return loaded;
  const dir = defaultsDir();
  const found = new Map<string, CachedWorkflow>();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.yaml')).sort()) {
    const relativePath = `workflows/${file}`;
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    const parsed = parseWorkflow(relativePath, content);
    if (!parsed.ok) throw new Error(`teamai's default ${relativePath} does not parse: ${parsed.diagnostics.map(formatDiagnostic).join('; ')}`);
    found.set(parsed.definition.name, {
      relativePath,
      sourceHash: createHash('sha256').update(content).digest('hex'),
      content,
      definition: parsed.definition,
      validatedAt: new Date(0).toISOString(),
    });
  }
  loaded = found;
  return found;
}

/** The default named `name`, or undefined when teamai ships none. */
function named(name: string): CachedWorkflow | undefined {
  return defaults().get(name);
}

/** Every default, in name order. */
function all(): CachedWorkflow[] {
  return [...defaults().values()];
}

export const DefaultWorkflows = { named, all } as const;
