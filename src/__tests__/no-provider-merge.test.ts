import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PullRequestLookup } from '../providers/types.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every provider file, a new adapter included, and the delivery code that calls them. */
function scope(): string[] {
  const providers = fs.readdirSync(path.join(SRC, 'providers'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join('providers', file));
  return [...providers, path.join('workflow', 'pr-delivery.ts')];
}

const MERGE_CALLS = [
  /['"`](?:pr|mr)['"`]\s*,\s*['"`]merge/i,
  /\b(?:pr|mr)\s+merge\b/i,
  /['"`]merge(?:[-_]?pulls?)?['"`]/i,
  // A REST merge or accept endpoint, not the words "pull/merge request".
  /\/merge\b(?!\s+requests?)/i,
  /\/accept\b/i,
  /auto_?merge|merge_when_pipeline_succeeds|mergePullRequest/i,
];

describe('workflow delivery never merges', () => {
  it('no provider file or delivery code holds a merge, accept or auto-merge call', () => {
    const found = scope().flatMap((file) => {
      const text = fs.readFileSync(path.join(SRC, file), 'utf8');
      return MERGE_CALLS.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`);
    });
    expect(found).toEqual([]);
  });

  it('the lookup delivery reads providers through can only find an open request', () => {
    expectTypeOf<keyof PullRequestLookup>().toEqualTypeOf<'findOpen'>();
  });

  it('delivery code imports nothing from the engine, which applies its outcome', () => {
    expect(fs.readFileSync(path.join(SRC, 'workflow', 'pr-delivery.ts'), 'utf8')).not.toMatch(/from '\.\/engine\.js'/);
  });
});
