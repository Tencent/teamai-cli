import { describe, it, expect } from 'vitest';

import { resolveImportSpecifier } from '../wiki-engine/code-knowledge/ast/import-resolver.js';

/**
 * Build a fileExists predicate backed by an in-memory Set.
 *
 * No real filesystem access occurs; the predicate simply checks whether the
 * given repo-root-relative path is a member of `known`.
 */
function makeExists(known: Set<string>): (relativePath: string) => Promise<boolean> {
  return async (relativePath: string) => known.has(relativePath);
}

const REPO_ROOT = '/repo';

describe('resolveImportSpecifier — Python absolute package imports', () => {
  it('resolves absolute package import to a module .py file', async () => {
    const known = new Set(['hai_flow/conf.py']);
    const result = await resolveImportSpecifier(
      REPO_ROOT,
      'hai_flow/app.py',
      'hai_flow.conf',
      makeExists(known),
    );
    expect(result).toBeDefined();
    expect(result?.targetFile).toBe('hai_flow/conf.py');
    expect(result?.confidence).toBe('EXTRACTED');
  });

  it('resolves absolute package import to a package __init__.py', async () => {
    const known = new Set(['hai_flow/core/__init__.py']);
    const result = await resolveImportSpecifier(
      REPO_ROOT,
      'hai_flow/app.py',
      'hai_flow.core',
      makeExists(known),
    );
    expect(result).toBeDefined();
    expect(result?.targetFile).toBe('hai_flow/core/__init__.py');
    expect(result?.confidence).toBe('EXTRACTED');
  });

  it('resolves absolute package import from a deeply nested file using repoRoot, not fromDir', async () => {
    // fromFile is three directories deep; the target is rooted at repoRoot.
    // This verifies that resolution is NOT relative to the importing file.
    const known = new Set(['hai_flow/utils/string_util.py']);
    const result = await resolveImportSpecifier(
      REPO_ROOT,
      'hai_flow/api/v2/views.py',
      'hai_flow.utils.string_util',
      makeExists(known),
    );
    expect(result).toBeDefined();
    expect(result?.targetFile).toBe('hai_flow/utils/string_util.py');
    expect(result?.confidence).toBe('EXTRACTED');
  });

  it('still resolves relative Python imports correctly (no regression)', async () => {
    // Specifier must be "./helper" (not ".helper") so that path.join strips
    // the leading dot and produces "hai_flow/api/helper", not the hidden-file
    // path "hai_flow/api/.helper".  This verifies resolveRelativeImport still
    // fires and is not preempted by the new resolveAbsolutePackageImport branch.
    const known = new Set(['hai_flow/api/helper.py']);
    const result = await resolveImportSpecifier(
      REPO_ROOT,
      'hai_flow/api/views.py',
      './helper',
      makeExists(known),
    );
    expect(result).toBeDefined();
    expect(result?.targetFile).toBe('hai_flow/api/helper.py');
  });

  it('returns undefined for an external package when no matching file exists in the repo', async () => {
    const known = new Set<string>();

    const resultOs = await resolveImportSpecifier(
      REPO_ROOT,
      'hai_flow/app.py',
      'os',
      makeExists(known),
    );
    expect(resultOs).toBeUndefined();

    const resultApscheduler = await resolveImportSpecifier(
      REPO_ROOT,
      'hai_flow/app.py',
      'apscheduler.schedulers.background',
      makeExists(known),
    );
    expect(resultApscheduler).toBeUndefined();
  });

  it('does not apply Python dot-path mapping for TypeScript source files', async () => {
    // pkg.mod looks like a Python absolute import but fromFile is .ts, so
    // the absolute-package branch is skipped; no tsconfig present, so undefined.
    const known = new Set(['pkg/mod.py']);
    const result = await resolveImportSpecifier(
      REPO_ROOT,
      'app.ts',
      'pkg.mod',
      makeExists(known),
    );
    expect(result).toBeUndefined();
  });
});
