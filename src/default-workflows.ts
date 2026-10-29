import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getCurrentVersion } from './package-info.js';
import { formatDiagnostic, parseWorkflow } from './workflow/parse.js';
import type { CachedWorkflow, ResolvedWorkflow, WorkflowSource } from './workflow/types.js';

// ─── Default workflows (#1388) ───────────────────────────
//
//  The CLI ships workflows a team gets without writing them,
//  as workflows/<name>.yaml in the npm package. A team file of
//  the same name replaces one. The workflow cache resolves
//  them (loadCachedWorkflow, listCachedWorkflows) only while
//  no team version of that name runs; they are never written
//  to the cache or the team repo. A run records which one it
//  ran (originOf), and a handoff refuses a default run whose
//  shipped file differs on the other machine.
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

/**
 * Where the definition a run executes came from: the team's files, or the default the teamai that started it ships, by
 * version, since another version may ship other bytes and no team commit holds them.
 */
export const RunOriginSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('team') }),
  z.object({ source: z.literal('default'), teamaiVersion: z.string().min(1) }),
]);
export type RunOrigin = z.infer<typeof RunOriginSchema>;

/** The origin a run of `resolved` records. */
function originOf(resolved: ResolvedWorkflow): RunOrigin {
  return resolved.source === 'default' ? { source: 'default', teamaiVersion: getCurrentVersion() } : { source: 'team' };
}

/** The source of a run's definition: a run started before origins were recorded ran the team's, as only those existed. */
function sourceOfRun(run: { origin?: RunOrigin }): WorkflowSource {
  return run.origin?.source ?? 'team';
}

export const DefaultWorkflows = { named, all, originOf, sourceOfRun } as const;
