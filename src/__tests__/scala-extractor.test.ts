import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import { collectCode } from '../wiki-engine/code-knowledge/code-collector.js';
import { buildCodeGraph } from '../wiki-engine/code-knowledge/code-graph.js';
import { traceCallChains } from '../wiki-engine/call-chain-tracer.js';
import { extractScala } from '../wiki-engine/code-knowledge/extractors/scala.js';
import { extractForLanguage, supportedLanguages } from '../wiki-engine/code-knowledge/extractors/index.js';

function scalaFile(content: string, relativePath = 'src/main/scala/com/payments/App.scala'): CodeCollectedFile {
  return {
    path: `/virtual/${relativePath}`,
    relativePath,
    language: 'scala',
    sha256: 'test',
    content,
  };
}

/** Collect the `kind:name` pairs the extractor produced. */
function extracted(content: string): string[] {
  return extractScala([scalaFile(content)]).map((f) => `${f.kind}:${f.name}`);
}

describe('Scala heuristic extractor', () => {
  it('is registered for the scala language', () => {
    expect(supportedLanguages()).toContain('scala');
    expect(extractForLanguage('scala', [scalaFile('object App { }\n')])).not.toEqual([]);
  });

  it('extracts classes, objects, traits, enums and defs', () => {
    const facts = extracted(
      [
        'package com.payments',
        '',
        'trait PaymentGateway {',
        '  def charge(order: Order): Receipt',
        '}',
        '',
        'final case class Invoice(id: Int, amount: BigDecimal)',
        '',
        'case object Paid',
        '',
        'class OrderRepository(cache: Cache)',
        '',
        'enum Color {',
        '  case Red, Blue',
        '}',
        '',
        'object Main extends App {',
        '  def run(): Unit = ()',
        '}',
      ].join('\n'),
    );

    expect(facts).toContain('interface:PaymentGateway');
    expect(facts).toContain('component:charge');
    expect(facts).toContain('component:Invoice');
    expect(facts).toContain('component:Paid');
    expect(facts).toContain('component:OrderRepository');
    expect(facts).toContain('component:Color');
    expect(facts).toContain('component:Main');
    expect(facts).toContain('component:run');
  });

  it('sees past annotations and modifiers, including a `case` match clause', () => {
    const facts = extracted(
      [
        '@Singleton',
        'final case class Invoice(id: Int)',
        '',
        'sealed abstract class Payment(val id: String)',
        '',
        'private[payments] object PaymentRegistry',
        '',
        'implicit class RichString(s: String) {',
        '  def quoted: String = s',
        '}',
        '',
        'transparent inline def show(x: Any): String = x.toString',
        '',
        'val label = payload match {',
        '  case Invoice(id) => id',
        '  case other => 0',
        '}',
      ].join('\n'),
    );

    // `case Invoice(id) =>` is a match clause, not a declaration.
    expect(facts.filter((f) => f === 'component:Invoice')).toHaveLength(1);
    expect(facts).toContain('component:Payment');
    expect(facts).toContain('component:PaymentRegistry');
    expect(facts).toContain('component:RichString');
    expect(facts).toContain('component:quoted');
    expect(facts).toContain('component:show');
  });

  it('extracts import relations regardless of the import form', () => {
    const facts = extracted(
      [
        'import com.payments.gateway',
        'import java.util.concurrent.TimeUnit',
        'import scala.collection.mutable.{Map => MMap}',
        'import com.payments.events._',
        'import com.payments.core.*',
        'import com.payments.model.{Invoice as Inv, Order => O}',
        'import com.demo.core.Invoice.apply',
      ].join('\n'),
    );

    // Relation names are slash-separated paths: buildCodeGraph and the
    // call-chain tracer both match against file paths, not dotted packages.
    // Brace selectors expand to one relation per imported symbol; a member
    // import narrows to the type's path.
    expect(facts).toEqual([
      'relation:com/payments/gateway',
      'relation:java/util/concurrent/TimeUnit',
      'relation:scala/collection/mutable/Map',
      'relation:scala-wildcard:com/payments/events',
      'relation:com/payments/events',
      'relation:scala-wildcard:com/payments/core',
      'relation:com/payments/core',
      'relation:com/payments/model/Invoice',
      'relation:com/payments/model/Order',
      'relation:com/demo/core/Invoice',
    ]);
  });

  it('falls back to the package path when no collected file matches the import', () => {
    const facts = extracted(
      ['import com.demo.core.{Invoice => _, _}', 'import com.demo.core.{Order => _}'].join('\n'),
    );

    // The fixture file sits outside com/demo/core, so the wildcard has no
    // collected file to name. A selector of only hidden names (`{Order => _}`)
    // imports nothing and emits nothing — no relation for `Invoice` either.
    expect(facts).toEqual(['relation:scala-wildcard:com/demo/core', 'relation:com/demo/core']);
  });

  it('reads a brace import scalafmt wraps across lines', () => {
    const facts = extracted(['import com.demo.core.{', '  Invoice,', '  Order => O', '}'].join('\n'));

    expect(facts).toEqual(['relation:com/demo/core/Invoice', 'relation:com/demo/core/Order']);
  });

  it('reads every clause of a comma-separated import', () => {
    const facts = extracted('import com.demo.A, com.demo.B');

    expect(facts).toEqual(['relation:com/demo/A', 'relation:com/demo/B']);
  });

  it('expands a wildcard over the package files and skips hidden names', () => {
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.{Invoice => _, _}\n', 'src/main/scala/com/demo/payments/Gateway.scala');
    const invoice = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\n', 'src/main/scala/com/demo/core/Invoice.scala');
    const main = scalaFile('package com.demo.core\n\nobject Main\n', 'src/main/scala/com/demo/core/Main.scala');

    const names = extractScala([gateway, invoice, main]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Main.scala', 'scala-decl:Invoice', 'scala-decl:Main']);
  });

  it('reads top-level declarations under a Scala 3 package block', () => {
    const models = scalaFile(
      ['package com.demo.core:', '  case class Invoice(id: Int)', '  object Registry:', '    def build: Int = 1'].join('\n'),
      'src/main/scala/com/demo/core/Models.scala',
    );
    const main = scalaFile('package com.demo.core:\n  object Main\n', 'src/main/scala/com/demo/core/Main.scala');
    const gateway = scalaFile(
      'package com.demo.payments\n\nimport com.demo.core.{Invoice => _, _}\nimport com.demo.core.Registry\n',
      'src/main/scala/com/demo/payments/Gateway.scala',
    );

    const names = extractScala([models, main, gateway]).filter((f) => f.kind === 'relation').map((f) => f.name);

    // `def build` sits one indent deeper than Registry — a member, not a name
    // the package exports; Invoice is hidden, Registry keeps Models.scala in.
    expect(names).toEqual(['scala-decl:Invoice,Registry', 'scala-decl:Main', 'scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Models.scala', 'src/main/scala/com/demo/core/Main.scala']);
  });

  it('ignores nested defs when a hidden name decides wildcard exclusion', () => {
    const models = scalaFile('package com.demo.core\n\nclass Invoice {\n  def total: Int = 1\n}\n', 'src/main/scala/com/demo/core/Models.scala');
    const main = scalaFile('package com.demo.core\n\nobject Main\n', 'src/main/scala/com/demo/core/Main.scala');
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.{Invoice => _, _}\n', 'src/main/scala/com/demo/payments/Gateway.scala');

    const names = extractScala([models, main, gateway]).filter((f) => f.kind === 'relation').map((f) => f.name);

    // Models.scala's only package-level name is the hidden Invoice — its
    // nested `def total` is not something the wildcard could have imported.
    expect(names).toEqual(['scala-decl:Invoice', 'scala-decl:Main', 'scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Main.scala']);
  });

  it('resolves a wildcard on an object to the file declaring it', () => {
    const domain = scalaFile('package com.demo\n\nobject Models {\n  val all = List(1)\n}\n', 'src/main/scala/com/demo/Domain.scala');
    const main = scalaFile('package com.demo.app\n\nimport com.demo.Models.*\n', 'src/main/scala/com/demo/app/Main.scala');

    const names = extractScala([domain, main]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-decl:Models', 'scala-wildcard:com/demo/Models', 'src/main/scala/com/demo/Domain.scala']);
  });

  it('expands a plain wildcard over the package files', () => {
    const main = scalaFile('package com.demo.app\n\nimport com.demo.core._\n', 'src/main/scala/com/demo/app/Main.scala');
    const invoice = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\n', 'src/main/scala/com/demo/core/Invoice.scala');
    const admin = scalaFile('package com.demo.core\n\nobject InternalAdmin\n', 'src/main/scala/com/demo/core/InternalAdmin.scala');

    const names = extractScala([main, invoice, admin]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Invoice.scala', 'src/main/scala/com/demo/core/InternalAdmin.scala', 'scala-decl:Invoice', 'scala-decl:InternalAdmin']);
  });

  it('expands a Scala 3 `*` wildcard the same way as `_`', () => {
    const main = scalaFile('package com.demo.app\n\nimport com.demo.core.*\n', 'src/main/scala/com/demo/app/Main.scala');
    const invoice = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\n', 'src/main/scala/com/demo/core/Invoice.scala');
    const admin = scalaFile('package com.demo.core\n\nobject InternalAdmin\n', 'src/main/scala/com/demo/core/InternalAdmin.scala');

    const names = extractScala([main, invoice, admin]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Invoice.scala', 'src/main/scala/com/demo/core/InternalAdmin.scala', 'scala-decl:Invoice', 'scala-decl:InternalAdmin']);
  });

  it('expands a wildcard over Java files of the package, minus hidden names', () => {
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.{Invoice => _, _}\n', 'src/main/scala/com/demo/payments/Gateway.scala');
    const invoiceJava: CodeCollectedFile = {
      path: '/virtual/src/main/java/com/demo/core/Invoice.java',
      relativePath: 'src/main/java/com/demo/core/Invoice.java',
      language: 'java',
      sha256: 'test',
      content: 'package com.demo.core;\n\npublic class Invoice {}\n',
    };
    const orderJava: CodeCollectedFile = {
      ...invoiceJava,
      relativePath: 'src/main/java/com/demo/core/Order.java',
      content: 'package com.demo.core;\n\npublic class Order {}\n',
    };
    const collected = [gateway, invoiceJava, orderJava];

    const names = extractScala([gateway], { allFiles: collected, priorDeclarations: new Map() })
      .filter((f) => f.kind === 'relation')
      .map((f) => f.name);

    expect(names).toEqual(['scala-wildcard:com/demo/core', 'src/main/java/com/demo/core/Order.java']);
  });

  it('resolves against a previous run\'s declarations when only the importer changed', () => {
    // Incremental run: the batch holds only the changed importer; the rest of
    // the project is known by path (content-less stubs) and cached facts.
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.{Invoice => _, _}\nimport com.demo.core.Order\n', 'src/main/scala/com/demo/payments/Gateway.scala');
    const stub = (relativePath: string): CodeCollectedFile => ({ path: `/virtual/${relativePath}`, relativePath, language: 'scala', sha256: '', content: '' });
    const priorDeclarations = new Map<string, Set<string>>([
      ['src/main/scala/com/demo/core/Invoice.scala', new Set(['Invoice'])],
      ['src/main/scala/com/demo/core/Main.scala', new Set(['Main'])],
      ['src/main/scala/com/demo/core/Models.scala', new Set(['Order'])],
    ]);

    const names = extractScala([gateway], {
      allFiles: [gateway, stub('src/main/scala/com/demo/core/Invoice.scala'), stub('src/main/scala/com/demo/core/Main.scala'), stub('src/main/scala/com/demo/core/Models.scala')],
      priorDeclarations,
    })
      .filter((f) => f.kind === 'relation')
      .map((f) => f.name);

    expect(names).toEqual(['scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Main.scala', 'src/main/scala/com/demo/core/Models.scala']);
  });

  it('keeps a declared-hidden symbol out of the wildcard even in a differently named file', () => {
    const models = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\n', 'src/main/scala/com/demo/core/Models.scala');
    const main = scalaFile('package com.demo.core\n\nobject Main\n', 'src/main/scala/com/demo/core/Main.scala');
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.{Invoice => _, _}\n', 'src/main/scala/com/demo/payments/Gateway.scala');

    const names = extractScala([models, main, gateway]).filter((f) => f.kind === 'relation').map((f) => f.name);

    // Models.scala declares only the hidden Invoice, so the wildcard skips it too.
    expect(names).toEqual(['scala-decl:Invoice', 'scala-decl:Main', 'scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Main.scala']);
  });

  it('does not import package-adjacent resources', () => {
    const main = scalaFile('package com.demo.app\n\nimport com.demo.core._\n', 'src/main/scala/com/demo/app/Main.scala');
    const invoice = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\n', 'src/main/scala/com/demo/core/Invoice.scala');
    const schema = scalaFile('-- schema', 'src/main/resources/com/demo/core/schema.sql');

    const names = extractScala([main, invoice], { allFiles: [main, invoice, schema], priorDeclarations: new Map() })
      .filter((f) => f.kind === 'relation')
      .map((f) => f.name);

    expect(names).toEqual(['scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Invoice.scala', 'scala-decl:Invoice']);
  });

  it('resolves a top-level def import to its file', () => {
    const helpers = scalaFile('package com.demo.core\n\ndef validate(s: String): Boolean = true\n', 'src/main/scala/com/demo/core/Helpers.scala');
    const main = scalaFile('package com.demo.app\n\nimport com.demo.core.validate\n', 'src/main/scala/com/demo/app/Main.scala');

    const names = extractScala([helpers, main]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-decl:validate', 'src/main/scala/com/demo/core/Helpers.scala']);
  });

  it('strips the _root_ qualifier from an import', () => {
    const models = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\n', 'src/main/scala/com/demo/core/Models.scala');
    const gateway = scalaFile('package com.demo.payments\n\nimport _root_.com.demo.core.Invoice\n', 'src/main/scala/com/demo/payments/Gateway.scala');

    const names = extractScala([models, gateway]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-decl:Invoice', 'src/main/scala/com/demo/core/Models.scala']);
  });

  it('reads nested Scala 3 package blocks', () => {
    const models = scalaFile(
      ['package com.demo:', '  package core:', '    case class Invoice(id: Int)', '  object Registry'].join('\n'),
      'src/main/scala/com/demo/core/Models.scala',
    );
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.Invoice\n', 'src/main/scala/com/demo/payments/Gateway.scala');

    const names = extractScala([models, gateway]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-decl:Invoice,Registry', 'src/main/scala/com/demo/core/Models.scala']);
  });

  it('reads declarations inside a braced package', () => {
    const models = scalaFile(['package com.demo.core {', '  class Invoice {', '    def total: Int = 1', '  }', '}'].join('\n'), 'src/main/scala/com/demo/core/Models.scala');
    const main = scalaFile('package com.demo.core\n\nobject Main\n', 'src/main/scala/com/demo/core/Main.scala');
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.{Invoice => _, _}\n', 'src/main/scala/com/demo/payments/Gateway.scala');

    const names = extractScala([models, main, gateway]).filter((f) => f.kind === 'relation').map((f) => f.name);

    // The package brace does not nest the declarations away, and Models.scala
    // declares only the hidden Invoice — the wildcard skips it.
    expect(names).toEqual(['scala-decl:Invoice', 'scala-decl:Main', 'scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Main.scala']);
  });

  it('resolves an import of a member declared inside an object', () => {
    const domain = scalaFile('package com.demo\n\nobject Models {\n  case class Invoice(id: Int)\n}\n', 'src/main/scala/com/demo/Domain.scala');
    const main = scalaFile('package com.demo.app\n\nimport com.demo.Models.Invoice\n', 'src/main/scala/com/demo/app/Main.scala');

    const names = extractScala([domain, main]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-decl:Models', 'src/main/scala/com/demo/Domain.scala']);
  });

  it('reads a comma-separated import with a plain `as` rename', () => {
    const facts = extracted('import com.demo.A as Alias, com.demo.B');

    expect(facts).toEqual(['relation:com/demo/A', 'relation:com/demo/B']);
  });

  it('keeps a file whose hidden name shares it with live symbols', () => {
    const invoice = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\ncase class Order(id: Int)\n', 'src/main/scala/com/demo/core/Invoice.scala');
    const main = scalaFile('package com.demo.core\n\nobject Main\n', 'src/main/scala/com/demo/core/Main.scala');
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.{Invoice as _, *}\n', 'src/main/scala/com/demo/payments/Gateway.scala');

    const names = extractScala([invoice, main, gateway]).filter((f) => f.kind === 'relation').map((f) => f.name);

    // Hiding Invoice does not hide Order, which lives in the same file.
    expect(names).toEqual(['scala-decl:Invoice,Order', 'scala-decl:Main', 'scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Invoice.scala', 'src/main/scala/com/demo/core/Main.scala']);
  });

  it('reads declarations after a braced package closes', () => {
    const models = scalaFile(['package a.b {', '  class X', '}', '', 'package c.d {', '  class Y', '}'].join('\n'), 'src/main/scala/c/d/Models.scala');

    const names = extractScala([models]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-decl:X,Y']);
  });

  it('resolves a named import to the file that declares the symbol', () => {
    const models = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\ncase class Order(id: Int)\n', 'src/main/scala/com/demo/core/Models.scala');
    const gateway = scalaFile('package com.demo.payments\n\nimport com.demo.core.Order\n', 'src/main/scala/com/demo/payments/Gateway.scala');

    const names = extractScala([models, gateway]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-decl:Invoice,Order', 'src/main/scala/com/demo/core/Models.scala']);
  });

  it('excludes a subpackage from a wildcard import', () => {
    const main = scalaFile('package com.demo.app\n\nimport com.demo.core._\n', 'src/main/scala/com/demo/app/Main.scala');
    const invoice = scalaFile('package com.demo.core\n\ncase class Invoice(id: Int)\n', 'src/main/scala/com/demo/core/Invoice.scala');
    const admin = scalaFile('package com.demo.core.internal\n\nobject Admin\n', 'src/main/scala/com/demo/core/internal/Admin.scala');

    const names = extractScala([main, invoice, admin]).filter((f) => f.kind === 'relation').map((f) => f.name);

    expect(names).toEqual(['scala-wildcard:com/demo/core', 'src/main/scala/com/demo/core/Invoice.scala', 'scala-decl:Invoice', 'scala-decl:Admin']);
  });

  it('produces a dependency edge for an internal import', () => {
    const gateway = scalaFile(
      ['package com.demo.payments', '', 'import com.demo.core.Invoice', '', 'object Gateway {', '  def charge(i: Invoice): Boolean = true', '}'].join('\n'),
      'src/main/scala/com/demo/payments/Gateway.scala',
    );
    const invoice = scalaFile(
      ['package com.demo.core', '', 'case class Invoice(id: Int)'].join('\n'),
      'src/main/scala/com/demo/core/Invoice.scala',
    );

    const graph = buildCodeGraph([...extractScala([gateway]), ...extractScala([invoice])]);
    const edge = graph.edges.find((e) => e.relation === 'DEPENDS_ON');

    expect(edge?.from).toBe('src/main/scala/com/demo/payments/Gateway.scala');
    expect(edge?.to).toBe('src/main/scala/com/demo/core/Invoice.scala');
  });

  it('scopes a brace import to the selected symbol, not the whole package directory', () => {
    const gateway = scalaFile(
      ['package com.demo.payments', '', 'import com.demo.core.{Invoice}', '', 'object Gateway {', '  def charge(i: Invoice): Boolean = true', '}'].join('\n'),
      'src/main/scala/com/demo/payments/Gateway.scala',
    );
    const invoice = scalaFile(
      ['package com.demo.core', '', 'case class Invoice(id: Int)'].join('\n'),
      'src/main/scala/com/demo/core/Invoice.scala',
    );
    const admin = scalaFile(
      ['package com.demo.core', '', 'object InternalAdmin'].join('\n'),
      'src/main/scala/com/demo/core/InternalAdmin.scala',
    );

    const graph = buildCodeGraph([...extractScala([gateway]), ...extractScala([invoice]), ...extractScala([admin])]);
    const deps = graph.edges.filter((e) => e.relation === 'DEPENDS_ON');

    expect(deps).toHaveLength(1);
    expect(deps[0].from).toBe('src/main/scala/com/demo/payments/Gateway.scala');
    expect(deps[0].to).toBe('src/main/scala/com/demo/core/Invoice.scala');
  });

  it('resolves a brace import in the call-chain tracer', () => {
    const main = scalaFile(
      ['package com.demo.app', '', 'import com.demo.core.{Invoice}', '', 'object Main extends App {', '  val i: Invoice = null', '}'].join('\n'),
      'src/main/scala/com/demo/app/Main.scala',
    );
    const invoice = scalaFile(
      ['package com.demo.core', '', 'case class Invoice(id: Int)'].join('\n'),
      'src/main/scala/com/demo/core/Invoice.scala',
    );
    const admin = scalaFile(
      ['package com.demo.core', '', 'object InternalAdmin'].join('\n'),
      'src/main/scala/com/demo/core/InternalAdmin.scala',
    );
    const files = [main, invoice, admin];
    const facts = files.flatMap((f) => extractScala([f]));

    const chains = traceCallChains(facts, files);
    const mainChain = chains.find((c) => c.entryPoint.includes('Main.scala'));

    // The brace import resolves to Invoice.scala's component; the sibling
    // InternalAdmin.scala in the same package directory is not pulled in.
    expect(mainChain?.steps[0]?.callsTo).toContain('Invoice');
    expect(mainChain?.steps.some((s) => s.file.endsWith('InternalAdmin.scala'))).toBe(false);
  });

  it('infers error types from the Error/Exception suffix and reads environment config', () => {
    const facts = extracted(
      [
        'case class PaymentError(msg: String) extends RuntimeException("boom")',
        '',
        'sealed trait AppException extends Exception',
        '',
        'object Config {',
        '  val apiKey = sys.env("PAYMENTS_API_KEY")',
        '  val region = System.getenv("AWS_REGION")',
        '}',
      ].join('\n'),
    );

    expect(facts).toContain('error:PaymentError');
    expect(facts).toContain('error:AppException');
    expect(facts).toContain('config:PAYMENTS_API_KEY');
    expect(facts).toContain('config:AWS_REGION');
  });
});

describe('Scala source collection', () => {
  it('collects .scala files with the scala language and key-file marking', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'teamai-scala-collect-'));
    try {
      mkdirSync(path.join(root, 'src', 'main', 'scala'), { recursive: true });
      writeFileSync(path.join(root, 'src', 'main', 'scala', 'Main.scala'), 'object Main extends App\n');
      writeFileSync(path.join(root, 'src', 'main', 'scala', 'Helper.scala'), 'object Helper { }\n');

      const { manifest } = await collectCode({ root });
      const byPath = new Map(manifest.files.map((f) => [f.relativePath, f]));

      expect(byPath.get('src/main/scala/Main.scala')?.language).toBe('scala');
      expect(byPath.get('src/main/scala/Main.scala')?.isKeyFile).toBe(true);
      expect(byPath.get('src/main/scala/Helper.scala')?.language).toBe('scala');
      expect(byPath.get('src/main/scala/Helper.scala')?.isKeyFile).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
