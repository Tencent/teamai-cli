import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

describe('resolveImportSpecifier — Swift module imports', () => {
  it('never resolves a Swift import through tsconfig path aliases', async () => {
    // A mixed repository where tsconfig maps the alias `Shared` onto a real
    // TypeScript file. Swift `import Shared` names a module, so it must not
    // become a dependency on that file — it stays unresolved and is recorded
    // as an EXTERNAL_IMPORT gap. A real tsconfig.json is required because the
    // paths mapping is read from disk.
    const root = await mkdtemp(path.join(tmpdir(), 'swift-import-resolver-'));
    try {
      await writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { Shared: ['src/shared.ts'] } } }),
        'utf8',
      );
      const known = new Set(['src/shared.ts']);

      const swift = await resolveImportSpecifier(
        root,
        'Sources/App/App.swift',
        'Shared',
        makeExists(known),
      );
      expect(swift).toBeUndefined();

      // Control: the identical alias still resolves for a TypeScript file, so
      // the guard is scoped to Swift and does not regress the TS track.
      const ts = await resolveImportSpecifier(root, 'src/index.ts', 'Shared', makeExists(known));
      expect(ts).toBeDefined();
      expect(ts?.targetFile).toBe('src/shared.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not resolve a Swift import through a wildcard tsconfig alias', async () => {
    // Wildcard aliases take the *other* branch of resolvePathsMapping, so this
    // pins the guard at the resolver level: were it moved inside the exact-match
    // branch, Swift specifiers would start resolving through `paths` again. The
    // specifier is deliberately not a realistic Swift module name — the point is
    // that whatever a Swift import looks like, the tsconfig fallback is not
    // reachable from a .swift file.
    const root = await mkdtemp(path.join(tmpdir(), 'swift-import-resolver-'));
    try {
      await writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } } }),
        'utf8',
      );
      const known = new Set(['lib/util.ts']);

      const swift = await resolveImportSpecifier(
        root,
        'Sources/App/App.swift',
        '@lib/util',
        makeExists(known),
      );
      expect(swift).toBeUndefined();

      const ts = await resolveImportSpecifier(root, 'src/index.ts', '@lib/util', makeExists(known));
      expect(ts).toBeDefined();
      expect(ts?.targetFile).toBe('lib/util.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
