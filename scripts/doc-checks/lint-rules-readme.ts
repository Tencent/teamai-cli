import assert from 'node:assert/strict';
import path from 'node:path';
import { check } from '../doc-check.js';
import { readMarkdown } from './read-markdown.js';

const ROOT = process.cwd();
const PLUGIN = 'oxlint-plugin-teamai/index.js';
const README = 'oxlint-plugin-teamai/README.md';

// The shapes this check reads. Another shape fails it rather than passing with rules it did not see.
const RULES_BLOCK = /^ {2}rules: \{\n(.*?)^ {2}\},$/msu;
const RULE_ENTRY = /^ {4}'([a-z][a-z-]*)': [A-Za-z]+,$/u;

// The vendored anti-slop rules, which the README describes together rather than one row each.
const ANTI_SLOP_SPREAD = '    ...antiSlopRules,';
const ROW = /^\| `teamai\/([a-z][a-z-]*)` \|/gmu;

/** The rules `index.js` registers itself, by name. */
function registeredRules(): string[] {
  const block = RULES_BLOCK.exec(readMarkdown(path.join(ROOT, PLUGIN)))?.[1];
  assert.ok(block !== undefined, `${PLUGIN}: no \`  rules: { ... },\` block`);

  return block.split('\n').filter((line) => line !== '' && line !== ANTI_SLOP_SPREAD).map((line) => {
    const name = RULE_ENTRY.exec(line)?.[1];
    assert.ok(name !== undefined, `${PLUGIN}: the rules block holds a line this check cannot read: ${line.trim()}`);

    return `teamai/${name}`;
  });
}

await check(`${README} has a row for every rule index.js registers, and none for another`, () => {
  const rules = new Set(registeredRules());
  const rows = new Set([...readMarkdown(path.join(ROOT, README)).matchAll(ROW)].map(([, name]) => `teamai/${name}`));
  const unlisted = [...rules].filter((rule) => !rows.has(rule)).sort();
  const unregistered = [...rows].filter((row) => !rules.has(row)).sort();

  assert.ok(
    unlisted.length === 0 && unregistered.length === 0,
    [
      ...(unlisted.length > 0 ? [`no row: ${unlisted.join(', ')}. Add a row that says what each rule stops.`] : []),
      ...(unregistered.length > 0 ? [`no rule: ${unregistered.join(', ')}. Register the rule in ${PLUGIN}, or remove its row.`] : []),
    ].join('\n'),
  );
});
