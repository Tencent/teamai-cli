import { describe, it, expect, beforeEach } from 'vitest';

import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import { extractStructuralGraphAsFacts } from '../wiki-engine/code-knowledge/ast/index.js';
import { resetParserRegistryForTests } from '../wiki-engine/code-knowledge/ast/parser-registry.js';

/**
 * Build an in-memory Swift file for AST extraction tests.
 *
 * repoRoot is a virtual path; import resolution relies on the in-memory
 * known-files set (relativePath), so no real files need to exist on disk.
 */
function makeFile(relativePath: string, content: string): CodeCollectedFile {
  return {
    path: `/virtual/${relativePath}`,
    relativePath,
    language: 'swift',
    sha256: 'test',
    content,
  };
}

const FILE = 'Sources/App/App.swift';
const REPO_ROOT = '/virtual';

async function extract(source: string) {
  return extractStructuralGraphAsFacts({
    repoRoot: REPO_ROOT,
    files: [makeFile(FILE, source)],
  });
}

describe('Swift AST structural extraction (web-tree-sitter WASM)', () => {
  beforeEach(() => {
    resetParserRegistryForTests();
  });

  it('parses Swift files instead of skipping them', async () => {
    const { result } = await extract('struct Point { }\n');

    expect(result.stats.filesParsed).toBe(1);
    expect(result.stats.filesSkipped).toBe(0);
    expect(result.gaps).toEqual([]);
  });

  it('records a module import once, keeping the dotted specifier', async () => {
    const { result } = await extract('import struct MyLib.Point\n');

    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.specifier).toBe('MyLib.Point');
    expect(result.imports[0]?.namespaceBinding).toBe('MyLib');
    expect(result.imports[0]?.isTypeOnly).toBe(false);
  });

  it('reports unresolvable module imports as EXTERNAL_IMPORT gaps', async () => {
    // Swift modules are not paths, so an import never resolves to a repo file.
    const { result } = await extract('import Foundation\n');

    expect(result.stats.importsResolved).toBe(0);
    expect(result.gaps.map((g) => g.kind)).toEqual(['EXTERNAL_IMPORT']);
    expect(result.gaps[0]?.message).toContain('Foundation');
  });

  it('extracts types, protocols and functions with modifier-aware visibility', async () => {
    const { result } = await extract(
      [
        'public protocol Drawable {',
        '  func draw() -> String',
        '}',
        '',
        'open class Shape {',
        '  public func render() -> String { return "shape" }',
        '}',
        '',
        'struct Point {',
        '  func area() -> Int { return 0 }',
        '}',
        '',
        'enum Color {',
        '  case red',
        '}',
        '',
        'actor Counter {',
        '  var value = 0',
        '}',
        '',
        '@MainActor final class ViewModel {',
        '  func load() {}',
        '}',
        '',
      ].join('\n'),
    );

    const byName = new Map(result.symbols.map((s) => [s.name, s]));

    expect(byName.get('Drawable')?.kind).toBe('interface');
    expect(byName.get('Shape')?.kind).toBe('class');
    expect(byName.get('Point')?.kind).toBe('class');
    expect(byName.get('Color')?.kind).toBe('class');
    expect(byName.get('Counter')?.kind).toBe('class');
    expect(byName.get('ViewModel')?.kind).toBe('class');
    expect(byName.get('render')?.kind).toBe('function');
    expect(byName.get('area')?.kind).toBe('function');

    // Swift is `internal` by default; only public/open/package leave the module.
    expect(byName.get('Drawable')?.exported).toBe(true);
    expect(byName.get('Shape')?.exported).toBe(true);
    expect(byName.get('render')?.exported).toBe(true);
    expect(byName.get('Point')?.exported).toBe(false);
    expect(byName.get('ViewModel')?.exported).toBe(false);
  });

  it('treats an extension as a conformance site without redeclaring the type', async () => {
    const { result } = await extract(
      [
        'protocol LocalProto { }',
        '',
        'struct Point { }',
        '',
        'extension Point: LocalProto, Equatable {',
        '  func area() -> Int { return 0 }',
        '}',
      ].join('\n'),
    );

    // `extension` adds no new type, so the extended type must stay a single symbol.
    expect(result.symbols.filter((s) => s.name === 'Point')).toHaveLength(1);
    expect(result.symbols.filter((s) => s.kind === 'class')).toHaveLength(1);

    // LocalProto is declared in the same file, so the conformance resolves to it.
    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.confidence).toBe('EXTRACTED');

    // Members declared inside the extension are still extracted.
    expect(result.symbols.map((s) => s.name)).toContain('area');
  });

  it('extracts protocol refinement as a relationship', async () => {
    const { result } = await extract(
      ['protocol Base { }', '', 'protocol Sub: Base, Sendable { }'].join('\n'),
    );

    // `Sendable` is not declared in this file and is not imported, so only the
    // local base protocol resolves.
    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.evidence[0]?.note).toBe('Sub implements Base');
  });

  it('resolves a self method call to the same-file symbol', async () => {
    const { result } = await extract(
      [
        'class Shape {',
        '  func draw() -> String {',
        '    return self.render()',
        '  }',
        '',
        '  func render() -> String { return "shape" }',
        '}',
      ].join('\n'),
    );

    const selfCall = result.callSites.find((c) => c.calleeText === 'render');
    expect(selfCall).toBeDefined();
    expect(selfCall?.resolvedTargetFile).toBe(FILE);
  });

  it('extracts a receiver call with its member name', async () => {
    const { result } = await extract(
      ['func run(shape: Shape) {', '  shape.draw()', '}'].join('\n'),
    );

    const memberCall = result.callSites.find((c) => c.receiver === 'shape');
    expect(memberCall?.calleeText).toBe('shape.draw');
  });
});
