import { describe, it, expect, beforeEach } from 'vitest';

import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import { extractStructuralGraphAsFacts } from '../wiki-engine/code-knowledge/ast/index.js';
import { swiftModuleScope } from '../wiki-engine/code-knowledge/ast/module-scope.js';
import { resetParserRegistryForTests } from '../wiki-engine/code-knowledge/ast/parser-registry.js';

function makeFile(relativePath: string, content: string): CodeCollectedFile {
  return {
    path: `/virtual/${relativePath}`,
    relativePath,
    language: 'swift',
    sha256: 'test',
    content,
  };
}

const REPO_ROOT = '/virtual';

async function extractFiles(files: Array<[string, string]>) {
  return extractStructuralGraphAsFacts({
    repoRoot: REPO_ROOT,
    files: files.map(([relativePath, content]) => makeFile(relativePath, content)),
  });
}

describe('Swift module scope', () => {
  it('reads the module boundary from a SwiftPM layout', () => {
    expect(swiftModuleScope('Sources/App/Models.swift')).toBe('Sources/App');
    expect(swiftModuleScope('Sources/App/Nested/Deep.swift')).toBe('Sources/App');
    expect(swiftModuleScope('Tests/AppTests/ModelsTests.swift')).toBe('Tests/AppTests');
    expect(swiftModuleScope('Sources\\App\\Models.swift')).toBe('Sources/App');
  });

  it('refuses to invent a module where the layout states none', () => {
    // No `Sources/` or `Tests/` segment: an arbitrary directory tree says
    // nothing about Swift's module boundary, so no scope is claimed.
    expect(swiftModuleScope('App/Models.swift')).toBeUndefined();
    expect(swiftModuleScope('MySources/App/Models.swift')).toBeUndefined();
    // A file sitting directly under Sources/ has no target directory.
    expect(swiftModuleScope('Sources/App.swift')).toBeUndefined();
    expect(swiftModuleScope('Sources/App/Models.ts')).toBeUndefined();
  });
});

describe('Swift module-scope resolution (web-tree-sitter WASM)', () => {
  beforeEach(() => {
    resetParserRegistryForTests();
  });

  it('resolves a conformance to a protocol declared in another file of the same module', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Protocols.swift', 'protocol LocalProto {\n  func describe() -> String\n}\n'],
      [
        'Sources/App/Models.swift',
        'struct Point: LocalProto {\n  func describe() -> String { return "point" }\n}\n',
      ],
    ]);

    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.from).toBe('Sources/App/Models.swift');
    expect(implementsEdges[0]?.to).toBe('Sources/App/Protocols.swift');
    expect(implementsEdges[0]?.evidence[0]?.note).toBe('Point implements LocalProto');
  });

  it('resolves a call to a function declared in another file of the same module', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Math.swift', 'func helper() -> Int { return 1 }\n'],
      ['Sources/App/Runner.swift', 'func run() -> Int {\n  return helper()\n}\n'],
    ]);

    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Runner.swift');
    expect(references[0]?.to).toBe('Sources/App/Math.swift');
    expect(references[0]?.confidence).toBe('INFERRED');
  });

  it('resolves a receiver call whose type lives in another file of the same module', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Service.swift', 'class Service {\n  func ping() -> Int { return 1 }\n}\n'],
      ['Sources/App/App.swift', 'func run() -> Int {\n  return Service.ping()\n}\n'],
    ]);

    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.to).toBe('Sources/App/Service.swift');
  });

  it('keeps a symbol from a different target unresolved', async () => {
    const { result } = await extractFiles([
      ['Sources/Other/Remote.swift', 'protocol RemoteProto { }\n'],
      ['Sources/App/Models.swift', 'struct Point: RemoteProto { }\n'],
    ]);

    // A separate target is a separate module: without an import the name is not
    // visible, and emitting an edge here would be fabrication.
    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('emits nothing when the name is declared more than once in the module', async () => {
    const { result } = await extractFiles([
      ['Sources/App/A.swift', 'protocol Dup { }\n'],
      ['Sources/App/B.swift', 'protocol Dup { }\n'],
      ['Sources/App/C.swift', 'struct S: Dup { }\n'],
    ]);

    // Two candidates mean the layout cannot say which file defines it, so the
    // resolution declines rather than picking one at random.
    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('does not guess a module outside a SwiftPM layout', async () => {
    const { result } = await extractFiles([
      ['App/Protocols.swift', 'protocol LocalProto { }\n'],
      ['App/Models.swift', 'struct Point: LocalProto { }\n'],
    ]);

    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('leaves same-file resolution unchanged', async () => {
    const { result } = await extractFiles([
      [
        'Sources/App/All.swift',
        [
          'protocol LocalProto { }',
          '',
          'struct Point: LocalProto { }',
          '',
          'func helper() -> Int { return 1 }',
          '',
          'func run() -> Int { return helper() }',
          '',
        ].join('\n'),
      ],
    ]);

    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.from).toBe('Sources/App/All.swift');
    expect(implementsEdges[0]?.to).toBe('Sources/App/All.swift');

    // A same-file call still resolves to EXTRACTED; it must not be downgraded
    // to the cross-file path now that the fallback exists.
    const helperCall = result.callSites.find((c) => c.calleeText === 'helper');
    expect(helperCall?.confidence).toBe('EXTRACTED');
    expect(helperCall?.resolvedTargetFile).toBe('Sources/App/All.swift');
  });
});
