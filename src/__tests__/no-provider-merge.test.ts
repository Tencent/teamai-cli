import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PullRequestLookup } from '../providers/types.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('workflow delivery never merges', () => {
  it('the lookup delivery reads providers through can only find an open request', () => {
    expectTypeOf<keyof PullRequestLookup>().toEqualTypeOf<'findOpen'>();
  });

  it('delivery code imports nothing from the engine, which applies its outcome', () => {
    expect(fs.readFileSync(path.join(SRC, 'workflow', 'pr-delivery.ts'), 'utf8')).not.toMatch(/from '\.\/engine\.js'/);
  });

  it('the run snapshot loads neither delivery code nor a provider', () => {
    const loaded = [...runtimeImports(path.join('workflow', 'snapshot.ts'))];
    expect(loaded.filter((file) => file.startsWith(`providers${path.sep}`) || file === path.join('workflow', 'pr-delivery.ts'))).toEqual([]);
    expect(loaded).toContain(path.join('workflow', 'delivery-schema.ts'));
  });
});

/** `file` and every module it loads, following each relative import or re-export that is not `import type`. */
function runtimeImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  for (const [, specifier] of text.matchAll(/^(?:import|export)(?!\s+type\b)[^;]*?\sfrom\s+'(\.[^']*)\.js'/gm)) {
    runtimeImports(path.join(path.dirname(file), `${specifier}.ts`), seen);
  }
  return seen;
}