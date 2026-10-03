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

  it('keeps the package root in the module boundary', () => {
    // Two packages in one repository can name their targets the same. The scope
    // has to span the path up to the target, or the two would be one module and
    // a name in one could resolve into the other.
    const a = swiftModuleScope('Packages/A/Sources/App/Models.swift');
    const b = swiftModuleScope('Packages/B/Sources/App/Models.swift');
    expect(a).toBe('Packages/A/Sources/App');
    expect(b).toBe('Packages/B/Sources/App');
    expect(a).not.toBe(b);
  });

  it('takes the innermost marker, so a package vendored under Tests/ keeps its own root', () => {
    // A repository may vendor whole packages under a directory it already named
    // `Tests`/`Sources`. The inner marker is those packages' boundary; taking the
    // outer one would scope `Tests/Fixtures/A/...` and `Tests/Fixtures/B/...` to
    // the same `Tests/Fixtures` and merge two packages.
    expect(swiftModuleScope('Tests/Fixtures/A/Sources/App/Models.swift')).toBe('Tests/Fixtures/A/Sources/App');
    expect(swiftModuleScope('Tests/Fixtures/A/Sources/App/Deep/Models.swift')).toBe('Tests/Fixtures/A/Sources/App');
    // A directory merely *named* `Tests` inside a target is not a boundary when
    // it cannot hold a target directory of its own — the file directly under it
    // leaves the real marker the only candidate.
    expect(swiftModuleScope('Sources/App/Tests/Helper.swift')).toBe('Sources/App');
    // The bias this direction buys: a marker this function mistakes for a
    // package root only ever yields a scope nested INSIDE the true module, so it
    // under-scopes (loses a resolution) instead of spanning two real modules.
    expect(swiftModuleScope('Sources/App/Tests/Sub/Helper.swift')).toBe('Sources/App/Tests/Sub');
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

  it('does not resolve a file-scoped declaration from another file', async () => {
    const { result } = await extractFiles([
      [
        'Sources/App/Internal.swift',
        [
          'private func hidden() -> Int { return 1 }',
          'fileprivate func alsoHidden() -> Int { return 2 }',
          'func visible() -> Int { return 3 }',
          '',
        ].join('\n'),
      ],
      [
        'Sources/App/Runner.swift',
        [
          'func run() -> Int {',
          '  let a = hidden()',
          '  let b = alsoHidden()',
          '  let c = visible()',
          '  return a + b + c',
          '}',
          '',
        ].join('\n'),
      ],
    ]);

    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    for (const name of ['hidden', 'alsoHidden', 'visible']) {
      expect(calls.has(name)).toBe(true);
    }
    // Same file, same call shape, same `-> Int` signature: the only variable is
    // the modifier on the declaration. `private` and `fileprivate` stop at the
    // file that declares them; the unmodified function is module-wide.
    expect(calls.get('hidden')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('alsoHidden')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('visible')?.resolvedTargetFile).toBe('Sources/App/Internal.swift');
  });

  it('does not resolve a method or a protocol requirement from another file', async () => {
    const { result } = await extractFiles([
      [
        'Sources/App/Service.swift',
        [
          'struct Service {',
          '  func handle() -> Int { return 1 }',
          '}',
          '',
          'protocol Handler {',
          '  func respond() -> Int',
          '}',
          '',
          'func handled() -> Int { return 2 }',
          '',
        ].join('\n'),
      ],
      [
        'Sources/App/Runner.swift',
        [
          'func run() -> Int {',
          '  let a = handle()',
          '  let b = respond()',
          '  let c = handled()',
          '  return a + b + c',
          '}',
          '',
        ].join('\n'),
      ],
    ]);

    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    for (const name of ['handle', 'respond', 'handled']) {
      expect(calls.has(name)).toBe(true);
    }
    // A member is reached through its container, not by a bare name, so only the
    // top-level function is something a sibling file can call on its own.
    expect(calls.get('handle')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('respond')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('handled')?.resolvedTargetFile).toBe('Sources/App/Service.swift');
  });

  it('does not resolve a call to a member the enclosing type inherits', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Base.swift', 'class Base {\n  func work() -> Int { return 1 }\n}\n'],
      ['Sources/App/Sub.swift', 'class Sub: Base {\n  func run() -> Int { return work() }\n}\n'],
      ['Sources/App/Global.swift', 'func work() -> Int { return 2 }\n'],
    ]);

    // `Sub` inherits `work()` from `Base`, so that member is what the call runs.
    // The top-level `func work()` in a third file is not, and an edge to it is an
    // invented one.
    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    expect(calls.has('work')).toBe(true);
    expect(calls.get('work')?.resolvedTargetFile).toBeUndefined();
    expect(result.edges.filter((e) => e.relation === 'REFERENCES')).toHaveLength(0);
  });

  it('does not resolve a call to a member an extension in another file adds', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Sub.swift', 'class Sub {\n  func run() -> Int { return work() }\n}\n'],
      ['Sources/App/Ext.swift', 'extension Sub {\n  func work() -> Int { return 3 }\n}\n'],
      ['Sources/App/Global.swift', 'func work() -> Int { return 2 }\n'],
    ]);

    // The same shape with the member added by an extension rather than inherited.
    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    expect(calls.has('work')).toBe(true);
    expect(calls.get('work')?.resolvedTargetFile).toBeUndefined();
    expect(result.edges.filter((e) => e.relation === 'REFERENCES')).toHaveLength(0);
  });

  it('does not resolve a call to a callable property a type declares', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Base.swift', 'class Base {\n  let work: () -> Int = { 1 }\n}\n'],
      ['Sources/App/Sub.swift', 'class Sub: Base {\n  func run() -> Int { return work() }\n}\n'],
      ['Sources/App/Global.swift', 'func work() -> Int { return 2 }\n'],
    ]);

    // A property holding a closure is called under a bare name exactly like a
    // method, so it shadows the module level the same way. A `property_declaration`
    // is not one of the symbols the Swift query captures, which is why the member
    // names are read off the tree rather than off the symbol list.
    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    expect(calls.has('work')).toBe(true);
    expect(calls.get('work')?.resolvedTargetFile).toBeUndefined();
    expect(result.edges.filter((e) => e.relation === 'REFERENCES')).toHaveLength(0);
  });

  it('still resolves a call no type in the module declares as a member', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Base.swift', 'class Base {\n  func other() -> Int { return 1 }\n}\n'],
      ['Sources/App/Sub.swift', 'class Sub: Base {\n  func run() -> Int { return work() }\n}\n'],
      ['Sources/App/Global.swift', 'func work() -> Int { return 2 }\n'],
    ]);

    // The control for the two cases above: no member is named `work`, so the
    // module-level function is the only candidate and the edge still stands.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Sub.swift');
    expect(references[0]?.to).toBe('Sources/App/Global.swift');
  });

  it('still resolves a call no type encloses when an unrelated type declares the name', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Helper.swift', 'struct Helper {\n  func work() {}\n}\n'],
      ['Sources/App/Global.swift', 'func work() {}\n'],
      ['Sources/App/Runner.swift', 'func run() {\n  work()\n}\n'],
    ]);

    // `run()` is a free function: there is no `self` for a bare `work` to be
    // read off, so `Helper.work` cannot be what the call means and the
    // module-level `work` is the only candidate. The member names are
    // module-wide, which is why the veto has to be asked per call site —
    // applied to every call, this one loses an edge nothing shadows.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Runner.swift');
    expect(references[0]?.to).toBe('Sources/App/Global.swift');
  });

  it('does not resolve a type nested inside another file', async () => {
    const { result } = await extractFiles([
      [
        'Sources/App/Outer.swift',
        [
          'struct Outer {',
          '  struct Config {',
          '    static func make() -> Int { return 1 }',
          '  }',
          '}',
          '',
          'struct TopLevelConfig {',
          '  static func make() -> Int { return 2 }',
          '}',
          '',
        ].join('\n'),
      ],
      [
        'Sources/App/Builder.swift',
        [
          'func build() -> Int {',
          '  let a = Config.make()',
          '  let b = TopLevelConfig.make()',
          '  return a + b',
          '}',
          '',
        ].join('\n'),
      ],
    ]);

    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    for (const name of ['Config.make', 'TopLevelConfig.make']) {
      expect(calls.has(name)).toBe(true);
    }
    expect(calls.get('Config.make')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('TopLevelConfig.make')?.resolvedTargetFile).toBe('Sources/App/Outer.swift');
  });

  it('does not merge same-named targets of different packages', async () => {
    const { result } = await extractFiles([
      ['Packages/A/Sources/App/Proto.swift', 'protocol Shared { }\n'],
      ['Packages/B/Sources/App/Model.swift', 'struct S: Shared { }\n'],
    ]);

    // `Packages/A/Sources/App` and `Packages/B/Sources/App` share their last two
    // segments but are separate modules, so the name stays unresolved.
    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('resolves inside a nested package target', async () => {
    const { result } = await extractFiles([
      ['Packages/A/Sources/App/Proto.swift', 'protocol Shared { }\n'],
      ['Packages/A/Sources/App/Model.swift', 'struct S: Shared { }\n'],
    ]);

    // The control for the case above: the same layout, one package, so the
    // conformance must still resolve.
    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.to).toBe('Packages/A/Sources/App/Proto.swift');
  });

  it('does not merge two packages vendored under the same Tests directory', async () => {
    const { result } = await extractFiles([
      ['Tests/Fixtures/A/Sources/App/Proto.swift', 'protocol Shared { }\n'],
      ['Tests/Fixtures/B/Sources/App/Model.swift', 'struct S: Shared { }\n'],
    ]);

    // Both paths carry an outer `Tests` segment. A scan that took the first
    // marker would scope both to `Tests/Fixtures` — the same merge the package
    // root fix rules out one level down, just reached through the outer package.
    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('resolves inside a package vendored under a Tests directory', async () => {
    const { result } = await extractFiles([
      ['Tests/Fixtures/A/Sources/App/Proto.swift', 'protocol Shared { }\n'],
      ['Tests/Fixtures/A/Sources/App/Model.swift', 'struct S: Shared { }\n'],
    ]);

    // The control for the case above: the same layout, one fixture package.
    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.to).toBe('Tests/Fixtures/A/Sources/App/Proto.swift');
  });
});

describe('Swift module-scope resolution yields to enclosing bindings', () => {
  beforeEach(() => {
    resetParserRegistryForTests();
  });

  // Every case below pairs a *shadowed* call with an unshadowed one of the same
  // name, and the shadowed one gets its own file. Edges are file-to-file, so
  // putting both in one file would make the assertion true either way: the
  // resolved call would supply the very edge the unresolved call must not.

  it('does not resolve a call to a parameter of the enclosing function', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Shadowed.swift', 'func shadowed(work: () -> Int) -> Int {\n  return work()\n}\n'],
      ['Sources/App/Plain.swift', 'func plain() -> Int {\n  return work()\n}\n'],
    ]);

    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Plain.swift');
    expect(references[0]?.to).toBe('Sources/App/Worker.swift');
  });

  it('does not resolve a call to a local binding', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      [
        'Sources/App/Shadowed.swift',
        'func shadowed() -> Int {\n  let work = { 1 }\n  return work()\n}\n',
      ],
      ['Sources/App/Plain.swift', 'func plain() -> Int {\n  return work()\n}\n'],
    ]);

    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Plain.swift');
  });

  it('does not resolve a call to a guard binding, which is a sibling statement', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      [
        'Sources/App/Shadowed.swift',
        'func shadowed(opt: (() -> Int)?) -> Int {\n  guard let work = opt else { return 0 }\n  return work()\n}\n',
      ],
      ['Sources/App/Plain.swift', 'func plain() -> Int {\n  return work()\n}\n'],
    ]);

    // `guard let` binds into the *rest of the block*, not into a nested scope,
    // so the call sits beside the guard instead of inside it. A walk that only
    // looked at ancestors would miss this one.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Plain.swift');
  });

  it('does not resolve a call to a closure parameter', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      [
        'Sources/App/Shadowed.swift',
        'func shadowed(handler: (() -> Int) -> Int) -> Int {\n  return handler { work in work() }\n}\n',
      ],
      ['Sources/App/Plain.swift', 'func plain() -> Int {\n  return work()\n}\n'],
    ]);

    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Plain.swift');
  });

  it('still resolves when the binding belongs to a different function of the same file', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      [
        'Sources/App/Mixed.swift',
        // Only the second function binds `work`, so exactly one of the two calls
        // may resolve. The assertion is two-sided: it fails if the binding is
        // ignored (both resolve, and the graph keeps one edge per resolved call)
        // and it fails under a position-blind per-file rule (neither resolves).
        // The binding set therefore has to be per call site, not per file.
        'func caller() -> Int {\n  return work()\n}\n\nfunc param(work: () -> Int) -> Int {\n  return work()\n}\n',
      ],
    ]);

    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Mixed.swift');
    expect(references[0]?.to).toBe('Sources/App/Worker.swift');
  });

  it('does not resolve a receiver that an enclosing scope binds', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Widget.swift', 'class Widget {\n  static func make() -> Int { return 1 }\n}\n'],
      ['Sources/App/Shadowed.swift', 'func shadowed(Widget: Int) -> Int {\n  return Widget.make()\n}\n'],
      ['Sources/App/Plain.swift', 'func plain() -> Int {\n  return Widget.make()\n}\n'],
    ]);

    // The receiver fallback leans on a naming convention, so it has to yield to
    // a scope that actually binds the name.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Plain.swift');
    expect(references[0]?.to).toBe('Sources/App/Widget.swift');
  });

  it('does not resolve a call an enclosing stored property shadows', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      [
        'Sources/App/Stored.swift',
        ['struct S {', '  let work: () -> Void', '  func run() {', '    work()', '  }', '}', ''].join('\n'),
      ],
    ]);

    // Swift reads an unqualified `work` inside a method as `self.work`, so the
    // stored property binds the name — even though it is neither a parameter nor
    // a local, the two shapes the collector once looked for.
    expect(result.edges.filter((e) => e.relation === 'REFERENCES')).toHaveLength(0);
  });

  it('does not resolve a receiver an enclosing generic parameter shadows', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Factory.swift', 'class Factory {\n  static func make() -> Int { return 1 }\n}\n'],
      ['Sources/App/Generic.swift', 'func run<Factory: Maker>() -> Int {\n  return Factory.make()\n}\n'],
    ]);

    // `Factory` in this position is the generic parameter, not the sibling
    // class the receiver fallback would otherwise claim.
    expect(result.edges.filter((e) => e.relation === 'REFERENCES')).toHaveLength(0);
  });

  it('does not resolve a call a closure capture list shadows', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Captured.swift', 'func outer() -> Int {\n  let g = { [work = makeWork()] in work() }\n  return g()\n}\n'],
    ]);

    // The capture list introduces `work` inside the closure. The lambda's own
    // parameter list is empty, which is all the old collector inspected.
    expect(result.edges.filter((e) => e.relation === 'REFERENCES')).toHaveLength(0);
  });

  it('does not let one call stand in for another in the same body', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Twice.swift', 'func run() -> Int {\n  work()\n  work()\n  return 0\n}\n'],
    ]);

    // Neither call binds `work`; each one only *uses* it. Counting the other
    // call's identifier as evidence would suppress both, so the over-collection
    // this rule accepts has a floor: a call's own name sits below it.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(2);
    for (const reference of references) expect(reference.to).toBe('Sources/App/Worker.swift');
  });

  it('recognises a binding whose name is not ASCII', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Pi.swift', 'func π() -> Int { return 1 }\n'],
      ['Sources/App/Runner.swift', 'func run(π: () -> Int) -> Int {\n  return π()\n}\n'],
    ]);

    // Swift identifiers are not ASCII. A class that only admits [A-Za-z] drops
    // the parameter and lets the sibling `func π()` win the fallback.
    expect(result.edges.filter((e) => e.relation === 'REFERENCES')).toHaveLength(0);
  });

  it('recognises a binding whose name has to be escaped', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func `repeat`() -> Int { return 1 }\n'],
      ['Sources/App/Shadowed.swift', 'func shadowed(`repeat`: () -> Int) -> Int {\n  return `repeat`()\n}\n'],
      ['Sources/App/Plain.swift', 'func plain() -> Int {\n  return `repeat`()\n}\n'],
    ]);

    // A name that collides with a keyword is written between backticks, and the
    // grammar reports it that way on both sides — the declaration and the call
    // carry the same token, so leaving the escaped form out of the set is the
    // only thing that breaks the pair.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Plain.swift');
    expect(references[0]?.to).toBe('Sources/App/Worker.swift');
  });

  it('recognises a binding whose name is a symbol', async () => {
    // U+1F680, written as an escape so the case stays readable in an editor.
    const rocket = '\u{1F680}';
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', `func ${rocket}() -> Int { return 1 }\n`],
      ['Sources/App/Shadowed.swift', `func shadowed(${rocket}: () -> Int) -> Int {\n  return ${rocket}()\n}\n`],
      ['Sources/App/Plain.swift', `func plain() -> Int {\n  return ${rocket}()\n}\n`],
    ]);

    // Swift admits symbol names, emoji included. A class built out of Unicode
    // *letters* still excludes every one of them.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Plain.swift');
    expect(references[0]?.to).toBe('Sources/App/Worker.swift');
  });

  it('resolves every call of a declaration that binds the name nowhere', async () => {
    const body = Array.from({ length: 12 }, () => '  work()').join('\n');
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Many.swift', `func run() -> Int {\n${body}\n  return 0\n}\n`],
    ]);

    // The shadowing set is read off the declaration once and handed to every
    // call inside it. Nothing binds `work` here, so all twelve calls resolve --
    // a set looked up for the wrong declaration, or emptied after the first
    // call, would show up as a shortfall rather than as a wrong edge.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(12);
    for (const reference of references) expect(reference.to).toBe('Sources/App/Worker.swift');
  });

  it('does not let a type position stand in for a binding', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Factory.swift', 'func Logger() -> Int { return 1 }\n'],
      ['Sources/App/Use.swift', 'func run(logger: Logger) -> Int {\n  return Logger()\n}\n'],
    ]);

    // `Logger` in the parameter list is a *type*, and only a value binding can
    // shadow a call. Counting the type position would suppress the resolution
    // and drop the edge to the sibling function that actually answers for it.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Use.swift');
    expect(references[0]?.to).toBe('Sources/App/Factory.swift');
  });

  it('does not let an argument mention stand in for a binding', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Run.swift', 'func run() {\n  consume(work)\n  work()\n}\n'],
    ]);

    // Passing a function along is a *use* of its name. Counting that mention as
    // a binding suppresses the call on the next line, and the edge it should
    // have carried disappears. The mention may sit on either side of the call.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Run.swift');
    expect(references[0]?.to).toBe('Sources/App/Worker.swift');
  });

  it('does not let an initializer mention stand in for a binding', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Run.swift', 'func run() {\n  let alias = work\n  work()\n}\n'],
    ]);

    // `let alias = work` binds `alias`; the name on the right is a *use*. Both
    // sit on the same `property_declaration`, so the identifier alone cannot
    // tell them apart -- the grammar marks them with different fields (`name`
    // against `value`), and the walker has to read the field. Counting the
    // mention as a binding suppressed the call on the next line.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Run.swift');
    expect(references[0]?.to).toBe('Sources/App/Worker.swift');
  });

  it('does not let an assignment value mention stand in for a binding', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Run.swift', 'func run() {\n  var alias = 0\n  alias = work\n  work()\n}\n'],
    ]);

    // `alias = work` assigns to `alias`; `work` on the right is a *mention*.
    // Reading that mention as if the assignment declared it shadowed the
    // module-level `work`, and the call on the next line then resolved to
    // nothing. A rule that had to be told about one statement form after another
    // would need a third fix here; reading the position needs none.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.to).toBe('Sources/App/Worker.swift');
  });

  it('does not let an assignment target stand in for a binding', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Alias.swift', 'func alias() -> Int { return 1 }\n'],
      ['Sources/App/Run.swift', 'func run() {\n  alias = work\n  alias()\n}\n'],
    ]);

    // The same statement read from the other side. `alias` is the assignment
    // *target* and `work` on the right is a mention, so neither side is a
    // binding and `alias()` answers to the sibling file. The value-position case
    // above cannot see this one: its target is a name a real `var` already
    // bound, so a rule that read assignment targets as declarations too would
    // leave that test green.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Run.swift');
    expect(references[0]?.to).toBe('Sources/App/Alias.swift');
  });

  it('resolves a call that passes its own name', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Run.swift', 'func run() {\n  work(work)\n}\n'],
    ]);

    // The declaration binds `work` nowhere, so both the callee and the argument
    // refer to the sibling function. Reading the declaration whole made the
    // argument the evidence that suppressed the callee -- the same mention, and
    // the same call.
    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Run.swift');
    expect(references[0]?.to).toBe('Sources/App/Worker.swift');
  });

  it('still shadows a call whose name a closure parameter binds', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Worker.swift', 'func work() -> Int { return 1 }\n'],
      ['Sources/App/Run.swift', 'func run() {\n  consume({ work in work() })\n}\n'],
    ]);

    // A closure handed over as an argument opens its own scope: its parameter
    // binds `work` for the body, so the inner call refers to that and not to the
    // sibling function. The binding sits on the closure's parameter, which is
    // where the walker reads it -- reaching it through an argument does not hide
    // it.
    expect(result.edges.filter((e) => e.relation === 'REFERENCES')).toHaveLength(0);
  });
});
