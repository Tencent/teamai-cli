import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import { collectCode } from '../wiki-engine/code-knowledge/code-collector.js';
import { buildCodeGraph } from '../wiki-engine/code-knowledge/code-graph.js';
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
      ].join('\n'),
    );

    // Relation names are slash-separated paths: buildCodeGraph and the
    // call-chain tracer both match against file paths, not dotted packages.
    expect(facts).toEqual([
      'relation:com/payments/gateway',
      'relation:java/util/concurrent/TimeUnit',
      'relation:scala/collection/mutable',
      'relation:com/payments/events',
      'relation:com/payments/core',
    ]);
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
