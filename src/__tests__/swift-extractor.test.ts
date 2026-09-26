import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import { collectCode } from '../wiki-engine/code-knowledge/code-collector.js';
import { extractSwift } from '../wiki-engine/code-knowledge/extractors/swift.js';
import { extractForLanguage, supportedLanguages } from '../wiki-engine/code-knowledge/extractors/index.js';

function swiftFile(content: string, relativePath = 'Sources/App/App.swift'): CodeCollectedFile {
  return {
    path: `/virtual/${relativePath}`,
    relativePath,
    language: 'swift',
    sha256: 'test',
    content,
  };
}

/** Collect the `kind:name` pairs the extractor produced. */
function extracted(content: string): string[] {
  return extractSwift([swiftFile(content)]).map((f) => `${f.kind}:${f.name}`);
}

describe('Swift heuristic extractor', () => {
  it('is registered for the swift language', () => {
    expect(supportedLanguages()).toContain('swift');
    expect(extractForLanguage('swift', [swiftFile('struct Point { }\n')])).not.toEqual([]);
  });

  it('extracts types, protocols and members', () => {
    const facts = extracted(
      [
        'public class Service {',
        '  func ping() {}',
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
        'actor Counter { }',
        '',
        'protocol Drawable {',
        '  func draw() -> String',
        '}',
      ].join('\n'),
    );

    expect(facts).toContain('component:Service');
    expect(facts).toContain('component:Point');
    expect(facts).toContain('component:Color');
    expect(facts).toContain('component:Counter');
    expect(facts).toContain('component:area');
    expect(facts).toContain('interface:Drawable');
  });

  it('sees past attributes and modifiers, including a `class func` type method', () => {
    const facts = extracted(
      [
        'class Registry {',
        '  static func make() -> Registry { return Registry() }',
        '  class func shared() -> Registry { return Registry() }',
        '}',
        '',
        '@MainActor',
        'final class Screen {',
        '  func show() {}',
        '}',
        '',
        'public final class Audit {',
        '  nonisolated func ping() {}',
        '  nonisolated(unsafe) func reset() {}',
        '}',
      ].join('\n'),
    );

    // `class func` must not be mistaken for a `class` declaration.
    expect(facts).toContain('component:Registry');
    expect(facts).toContain('component:make');
    expect(facts).toContain('component:shared');
    expect(facts).toContain('component:Screen');
    expect(facts).toContain('component:show');
    expect(facts).toContain('component:Audit');
    expect(facts).toContain('component:ping');
    expect(facts).toContain('component:reset');
  });

  it('records protocol conformances declared on an extension', () => {
    const facts = extracted(
      ['struct Point { }', '', 'extension Point: Equatable, CustomStringConvertible {', '  func area() -> Int { return 0 }', '}'].join('\n'),
    );

    expect(facts).toContain('interface:Point:impl:Equatable');
    expect(facts).toContain('interface:Point:impl:CustomStringConvertible');
    // The extension itself is not a new type.
    expect(facts.filter((f) => f === 'component:Point')).toHaveLength(1);
  });

  it('extracts import relations regardless of the import form', () => {
    const facts = extracted(
      ['import Foundation', 'import struct MyLib.Point', '@testable import MyLib', 'import func Darwin.sqrt'].join('\n'),
    );

    expect(facts).toEqual([
      'relation:Foundation',
      'relation:MyLib',
      'relation:MyLib',
      'relation:Darwin',
    ]);
  });

  it('infers error types from the Error suffix and reads environment config', () => {
    const facts = extracted(
      [
        'enum NetworkError: Error {',
        '  case timeout',
        '}',
        '',
        'func read() -> String {',
        '  return ProcessInfo.processInfo.environment["API_BASE_URL"] ?? ""',
        '}',
        '',
      ].join('\n'),
    );

    expect(facts).toContain('error:NetworkError');
    expect(facts).toContain('config:API_BASE_URL');
  });
});

describe('Swift source collection', () => {
  it('collects .swift files with the swift language and key-file marking', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'teamai-swift-collect-'));
    try {
      mkdirSync(path.join(root, 'Sources', 'App'), { recursive: true });
      writeFileSync(path.join(root, 'Sources', 'App', 'main.swift'), 'print("entry")\n');
      writeFileSync(path.join(root, 'Sources', 'App', 'Helper.swift'), 'struct Helper { }\n');

      const { manifest } = await collectCode({ root });
      const byPath = new Map(manifest.files.map((f) => [f.relativePath, f]));

      expect(byPath.get('Sources/App/main.swift')?.language).toBe('swift');
      expect(byPath.get('Sources/App/main.swift')?.isKeyFile).toBe(true);
      expect(byPath.get('Sources/App/Helper.swift')?.language).toBe('swift');
      expect(byPath.get('Sources/App/Helper.swift')?.isKeyFile).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
