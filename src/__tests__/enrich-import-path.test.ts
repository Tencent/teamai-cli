import { describe, expect, it } from 'vitest';

import { resolveImportToModule } from '../enrich-with-ai.js';

/**
 * Code facts normalize every file path to '/' (toPosix in the collector), and
 * import specifiers in source text use '/'. Resolving a relative import must
 * therefore keep forward slashes on every platform — including Windows, where
 * path.join/normalize would otherwise emit '\\' and the split('/') would return
 * the whole path, silently dropping the module edge from the enrich manifest.
 *
 * This test is platform-independent: the same assertion is meaningful on Linux,
 * macOS and Windows, and it fails on Windows with the old path.join-based code.
 */
describe('resolveImportToModule relative paths', () => {
  it('resolves a parent-directory import to its top-level module', () => {
    expect(resolveImportToModule('src/app.ts', '../lib/util')).toBe('lib');
  });

  it('resolves a nested sibling import to its top-level module', () => {
    expect(resolveImportToModule('src/a/b.ts', './c')).toBe('src');
    expect(resolveImportToModule('src/a/b.ts', '../../lib/x')).toBe('lib');
  });

  it('rejects imports that escape the repository root', () => {
    expect(resolveImportToModule('src/app.ts', '../../outside')).toBeUndefined();
  });

  it('keeps non-relative import formats unchanged', () => {
    expect(resolveImportToModule('src/app.ts', 'framework.adapter.haiflow')).toBe('framework');
    expect(resolveImportToModule('src/app.ts', '@scope/pkg/foo')).toBeUndefined();
    expect(resolveImportToModule('src/app.ts', 'lodash/fp')).toBe('lodash');
  });
});
