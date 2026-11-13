import assert from 'node:assert/strict';
import { check } from '../doc-check.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCE = 'src/workflow/requirements.ts';
const PAGE = 'docs/dev/workflow-engine.md';

// The shape this check reads. Another shape fails it rather than passing with keys it did not see.
const DECLARATION = /^export type DriverCan = Omit<Can, ([^>]+)> & \{([^}]*)\};$/mu;
const SENTENCE = /The engine-only `DriverCan` keys are ([^.]+)\./gu;

/** The keys `DriverCan` adds to the protocol's `Can`: those of its type literal that its `Omit<Can, ...>` does not take away. */
function addedKeys(): string[] {
  const declared = DECLARATION.exec(fs.readFileSync(path.join(ROOT, SOURCE), 'utf8'));
  assert.ok(declared, `${SOURCE}: DriverCan is no longer \`export type DriverCan = Omit<Can, ...> & { ... };\``);
  const [, omittedKeys = '', members = ''] = declared;
  const omitted = new Set([...omittedKeys.matchAll(/'([A-Za-z]+)'/gu)].map(([, key]) => key));

  return [...members.matchAll(/(?:^|[;,])\s*([A-Za-z]+)\??:/gu)].flatMap(([, key = '']) => (omitted.has(key) ? [] : [key])).sort();
}

await check(`${PAGE} names every key DriverCan adds to the protocol's can`, () => {
  const sentences = [...fs.readFileSync(path.join(ROOT, PAGE), 'utf8').matchAll(SENTENCE)];
  assert.equal(sentences.length, 1, `${PAGE}: expected one sentence "The engine-only \`DriverCan\` keys are ...", found ${sentences.length}`);
  const named = [...(sentences[0]?.[1] ?? '').matchAll(/`([A-Za-z]+)[^`]*`/gu)].map(([, key]) => key).sort();

  assert.deepEqual(named, addedKeys(), `${PAGE}: the engine-only DriverCan keys differ from ${SOURCE}`);
});
