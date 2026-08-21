import { describe, it, expect, beforeEach } from 'vitest';

import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import {
  astAvailable,
  extractStructuralGraphAsFacts,
} from '../wiki-engine/code-knowledge/ast/index.js';
import { resetParserRegistryForTests } from '../wiki-engine/code-knowledge/ast/parser-registry.js';
import { mergeCodeFacts } from '../wiki-engine/code-knowledge/ast/merge-edges.js';
import type { CodeFact } from '../wiki-engine/code-knowledge/code-extractors.js';
import { parseEdgeProvenance, edgeProvenanceRank, edgeReason } from '../enrich-with-ai.js';

/**
 * Build an in-memory collected file for AST extraction tests.
 *
 * repoRoot is a virtual path; import resolution relies on the in-memory
 * known-files set (relativePath), so no real files need to exist on disk.
 */
function makeFile(relativePath: string, content: string): CodeCollectedFile {
  const language = relativePath.endsWith('.py')
    ? 'python'
    : relativePath.endsWith('.go')
      ? 'go'
      : 'typescript';
  return {
    path: `/virtual/${relativePath}`,
    relativePath,
    language,
    sha256: 'test',
    content,
  };
}

const REPO_ROOT = '/virtual';

describe('AST structural extraction (web-tree-sitter WASM)', () => {
  beforeEach(() => {
    resetParserRegistryForTests();
  });

  it('reports AST as available in this environment', () => {
    expect(astAvailable()).toBe(true);
  });

  it('resolves a TypeScript relative import into a precise code-ast DEPENDS_ON edge', async () => {
    const files = [
      makeFile('src/a.ts', 'import { helper } from "./b";\nexport function run() {\n  return helper();\n}\n'),
      makeFile('src/b.ts', 'export function helper() {\n  return 42;\n}\n'),
    ];

    const { facts, result } = await extractStructuralGraphAsFacts({ repoRoot: REPO_ROOT, files });

    const dependsOn = result.edges.find(
      (e) => e.from === 'src/a.ts' && e.to === 'src/b.ts' && e.relation === 'DEPENDS_ON',
    );
    expect(dependsOn).toBeDefined();
    expect(dependsOn?.source).toBe('code-ast');

    // The adapted CodeFact carries the resolved target and a (code-ast) marker.
    const astFact = facts.find((f) => f.file === 'src/a.ts' && f.name === 'src/b.ts');
    expect(astFact).toBeDefined();
    expect(astFact?.kind).toBe('relation');
    expect(astFact?.detail).toContain('(code-ast)');

    expect(result.stats.imports).toBeGreaterThanOrEqual(1);
    expect(result.stats.importsResolved).toBeGreaterThanOrEqual(1);
  });

  it('resolves a cross-file call into a code-ast REFERENCES edge', async () => {
    const files = [
      makeFile('src/a.ts', 'import { helper } from "./b";\nexport function run() {\n  return helper();\n}\n'),
      makeFile('src/b.ts', 'export function helper() {\n  return 42;\n}\n'),
    ];

    const { result } = await extractStructuralGraphAsFacts({ repoRoot: REPO_ROOT, files });

    const references = result.edges.find(
      (e) => e.from === 'src/a.ts' && e.to === 'src/b.ts' && e.relation === 'REFERENCES',
    );
    expect(references).toBeDefined();
    expect(references?.source).toBe('code-ast');
  });

  it('extracts symbols and resolves a sibling module import from Python', async () => {
    // "from util import boot" captures module_name "util", which resolves
    // relative to main.py's directory → sibling pkg/util.py.
    const files = [
      makeFile('pkg/main.py', 'from util import boot\n\nclass App:\n    def start(self):\n        return boot()\n'),
      makeFile('pkg/util.py', 'def boot():\n    return 1\n'),
    ];

    const { result } = await extractStructuralGraphAsFacts({ repoRoot: REPO_ROOT, files });

    // class App + def start + def boot = at least 3 symbols
    expect(result.stats.symbols).toBeGreaterThanOrEqual(3);
    const edge = result.edges.find((e) => e.from === 'pkg/main.py' && e.to === 'pkg/util.py');
    expect(edge).toBeDefined();
    expect(edge?.source).toBe('code-ast');
  });

  it('treats module-level Python defs as exported so cross-file calls resolve to a symbol', async () => {
    // Regression: tree-sitter-python has no "__export__" node, so export
    // detection must fall back to module-level class/def. Without it every
    // Python symbol is exported=false and symbol-level call resolution never
    // fires (only the coarser file-level edge survives).
    const files = [
      makeFile('pkg/main.py', 'from util import boot\n\ndef run():\n    return boot()\n'),
      makeFile('pkg/util.py', 'def boot():\n    return 1\n'),
    ];

    const { result } = await extractStructuralGraphAsFacts({ repoRoot: REPO_ROOT, files });

    const bootSymbol = result.symbols.find((s) => s.name === 'boot' && s.file === 'pkg/util.py');
    expect(bootSymbol?.exported).toBe(true);

    // The call boot() in main.py resolves to boot's symbol id in util.py.
    const call = result.callSites.find((c) => c.calleeText === 'boot' && c.fromFile === 'pkg/main.py');
    expect(call?.resolvedTargetId).toBe('pkg/util.py#Function:boot');
    expect(call?.resolvedTargetFile).toBe('pkg/util.py');
  });

  it('extracts symbols from Go', async () => {
    const goSrc = [
      'package main',
      '',
      'import "fmt"',
      '',
      'type Server struct{}',
      '',
      'func Run() {',
      '  fmt.Println("hi")',
      '}',
      '',
    ].join('\n');
    const files = [makeFile('main.go', goSrc)];

    const { result } = await extractStructuralGraphAsFacts({ repoRoot: REPO_ROOT, files });

    // Go: func Run + type Server = 2 symbols
    expect(result.stats.symbols).toBeGreaterThanOrEqual(2);
    // "fmt" is an external package import → recorded as an EXTERNAL_IMPORT gap
    expect(result.gaps.some((g) => g.kind === 'EXTERNAL_IMPORT')).toBe(true);
  });

  it('records unresolved external imports as gaps', async () => {
    const files = [
      makeFile('src/a.ts', 'import { thing } from "some-external-pkg";\nexport const x = thing;\n'),
    ];

    const { result } = await extractStructuralGraphAsFacts({ repoRoot: REPO_ROOT, files });

    expect(result.gaps.some((g) => g.kind === 'EXTERNAL_IMPORT')).toBe(true);
  });

  it('mergeCodeFacts lets AST relation facts win over heuristic relation facts on the same line', () => {
    const astFacts: CodeFact[] = [
      {
        kind: 'relation',
        name: 'src/b.ts',
        file: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        detail: 'DEPENDS_ON → src/b.ts (code-ast)',
        confidence: 'EXTRACTED',
        evidenceType: 'usage',
      },
    ];
    const heuristicFacts: CodeFact[] = [
      {
        kind: 'relation',
        name: './b',
        file: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        detail: 'import ./b',
        confidence: 'INFERRED',
        evidenceType: 'usage',
      },
    ];

    const merged = mergeCodeFacts(astFacts, heuristicFacts);
    const relations = merged.filter((f) => f.kind === 'relation' && f.file === 'src/a.ts' && f.lineStart === 1);
    expect(relations).toHaveLength(1);
    expect(relations[0]?.detail).toContain('(code-ast)');
  });

  describe('enrich edge provenance', () => {
    it('preserves AST relation and source from a code-ast fact detail', () => {
      expect(parseEdgeProvenance('REFERENCES → src/repo.ts (code-ast)')).toEqual({
        relation: 'REFERENCES',
        source: 'code-ast',
      });
      expect(parseEdgeProvenance('DEPENDS_ON → src/b.ts (code-ast)')).toEqual({
        relation: 'DEPENDS_ON',
        source: 'code-ast',
      });
      expect(parseEdgeProvenance('IMPLEMENTS → src/iface.ts (code-ast)')).toEqual({
        relation: 'IMPLEMENTS',
        source: 'code-ast',
      });
    });

    it('falls back to DEPENDS_ON / code-heuristic for a raw regex fact detail', () => {
      expect(parseEdgeProvenance('import { x } from "./y";')).toEqual({
        relation: 'DEPENDS_ON',
        source: 'code-heuristic',
      });
    });

    it('ranks code-ast DEPENDS_ON above REFERENCES/IMPLEMENTS and heuristic (deterministic merge)', () => {
      const astDepends = { relation: 'DEPENDS_ON', source: 'code-ast' as const };
      const astRefs = { relation: 'REFERENCES', source: 'code-ast' as const };
      const astImpl = { relation: 'IMPLEMENTS', source: 'code-ast' as const };
      const heuristic = { relation: 'DEPENDS_ON', source: 'code-heuristic' as const };

      expect(edgeProvenanceRank(astDepends)).toBeGreaterThan(edgeProvenanceRank(astRefs));
      expect(edgeProvenanceRank(astRefs)).toBeGreaterThan(edgeProvenanceRank(astImpl));
      expect(edgeProvenanceRank(astImpl)).toBeGreaterThan(edgeProvenanceRank(heuristic));
      expect(edgeProvenanceRank(heuristic)).toBe(0);
    });

    it('edgeReason matches the resolved relation', () => {
      expect(edgeReason('a', 'b', 'REFERENCES')).toBe('a references b');
      expect(edgeReason('a', 'b', 'IMPLEMENTS')).toBe('a implements b');
      expect(edgeReason('a', 'b', 'DEPENDS_ON')).toBe('a imports from b');
    });
  });
});
