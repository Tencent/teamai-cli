import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamRuleToOmpRule } from '../resources/omp-rule.js';
import { bucketRules, loadRulesDir } from './fixtures/rule-parsers/omp/rules.js';

/**
 * The OMP render read back by Oh My Pi's own rule parser, vendored from 18.2.1
 * (fixtures/rule-parsers/omp), so this runs everywhere, CI included (#946).
 */
describe('Oh My Pi reads the rule render as intended', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-parser-'));
  });

  afterEach(async () => {
    await fse.remove(dir);
  });

  const BODY = 'Use named exports.\n\n---\n\nA rule with a horizontal rule in it.';

  it.each([
    ['an inline list', `---\npaths: ["src/**/*.ts", "test/**"]\n---\n\n${BODY}`, ['src/**/*.ts', 'test/**']],
    ['a block list', `---\npaths:\n  - "src/**/*.ts"\n  - test/**\n---\n\n${BODY}`, ['src/**/*.ts', 'test/**']],
    ['a brace glob', `---\npaths:\n  - "src/{a,b}/**"\n---\n\n${BODY}`, ['src/{a,b}/**']],
    ['an unquoted alias-like glob', `---\npaths: **/*.ts\n---\n\n${BODY}`, ['**/*.ts']],
  ])('offers a rule scoped by %s in the rulebook with its globs', async (_label, source, globs) => {
    await fse.writeFile(path.join(dir, 'scoped.md'), teamRuleToOmpRule(source));

    const { alwaysApplyRules, rulebookRules } = bucketRules(loadRulesDir(dir));

    expect(alwaysApplyRules).toEqual([]);
    expect(rulebookRules).toMatchObject([
      { name: 'scoped', globs, description: `Team rule for files matching ${globs.join(', ')}`, content: BODY },
    ]);
  });

  it('always applies an unscoped rule', async () => {
    await fse.writeFile(path.join(dir, 'plain.md'), teamRuleToOmpRule(`${BODY}\n`));

    const { alwaysApplyRules, rulebookRules } = bucketRules(loadRulesDir(dir));

    expect(alwaysApplyRules).toMatchObject([{ name: 'plain', content: BODY }]);
    expect(rulebookRules).toEqual([]);
  });

  it('loads only the top level of its rules directory', async () => {
    await fse.outputFile(path.join(dir, 'fe.style.md'), teamRuleToOmpRule('Flat.\n'));
    await fse.outputFile(path.join(dir, 'fe', 'style.md'), teamRuleToOmpRule('Nested.\n'));

    expect(loadRulesDir(dir).map((rule) => rule.name)).toEqual(['fe.style']);
  });

  it('drops a rule with neither alwaysApply nor a description, which a verbatim scoped copy is', async () => {
    await fse.writeFile(path.join(dir, 'verbatim.md'), `---\npaths: ["src/**"]\n---\n\n${BODY}`);

    const { alwaysApplyRules, rulebookRules } = bucketRules(loadRulesDir(dir));

    expect([...alwaysApplyRules, ...rulebookRules]).toEqual([]);
  });
});
