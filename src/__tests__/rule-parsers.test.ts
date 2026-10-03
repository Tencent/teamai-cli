import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { teamRuleToCodebuddyRule } from '../resources/codebuddy-rule.js';
import { teamRuleToCursorMdc } from '../resources/cursor-mdc.js';
import { teamRuleToJoycodeRule } from '../resources/joycode-rule.js';
import {
  loadCodebuddyRuleParser, loadCursorRuleParser, loadJoycodeRuleParser, ruleParserBundle,
} from './helpers/rule-parsers.js';

/**
 * Each render read back by the tool's own parser, taken from its installed
 * bundle (`TEAMAI_RULE_PARSER_BUNDLES`, see helpers/rule-parsers.ts). Skipped
 * where the bundle is absent; the contract tests pin the bytes everywhere.
 */
const BODY = 'Use named exports.\n\n---\n\nA rule with a horizontal rule in it.';

const cursorBundle = ruleParserBundle('cursor');

describe.skipIf(!cursorBundle)('Cursor reads the .mdc render as intended', () => {
  const parser = cursorBundle ? loadCursorRuleParser(cursorBundle) : undefined;

  it.each([
    ['an unscoped rule', BODY, true, undefined],
    ['an inline list', `---\npaths: ["src/**/*.ts", "test/**"]\n---\n\n${BODY}`, false, ['src/**/*.ts', 'test/**']],
    ['a block list', `---\npaths:\n  - "src/**/*.ts"\n  - test/**\n---\n\n${BODY}`, false, ['src/**/*.ts', 'test/**']],
    ['a brace glob', `---\npaths:\n  - "src/{a,b}/**"\n  - "**/*.{ts,tsx}"\n---\n\n${BODY}`, false, ['src/{a,b}/**', '**/*.{ts,tsx}']],
    ['an unquoted alias-like glob', `---\npaths: **/*.ts\n---\n\n${BODY}`, false, ['**/*.ts']],
  ])('%s', (_label, source, alwaysApply, globs) => {
    const parsed = parser!.parse(teamRuleToCursorMdc(source));

    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.alwaysApply).toBe(alwaysApply);
    expect(parser!.globs(parsed!.frontmatter.globs)).toEqual(globs);
    expect(parsed!.body).toBe(BODY);
  });
});

const codebuddyBundle = ruleParserBundle('codebuddy');

describe.skipIf(!codebuddyBundle)('CodeBuddy (and WorkBuddy) read the CodeBuddy render as intended', () => {
  const parser = codebuddyBundle ? loadCodebuddyRuleParser(codebuddyBundle) : undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codebuddy-parser-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['an unscoped rule', BODY, 'ALWAYS', undefined],
    ['an inline list', `---\npaths: ["src/**/*.ts", "test/**"]\n---\n\n${BODY}`, 'MANUAL', ['src/**/*.ts', 'test/**']],
    ['a block list', `---\npaths:\n  - "src/**/*.ts"\n  - test/**\n---\n\n${BODY}`, 'MANUAL', ['src/**/*.ts', 'test/**']],
    ['a comma-separated string', `---\npaths: src/**/*.ts, test/**\n---\n\n${BODY}`, 'MANUAL', ['src/**/*.ts', 'test/**']],
    ['a brace glob', `---\npaths:\n  - "src/{a,b}/**"\n  - "**/*.{ts,tsx}"\n---\n\n${BODY}`, 'MANUAL', ['src/{a,b}/**', '**/*.{ts,tsx}']],
    ['an unquoted alias-like glob', `---\npaths: **/*.ts\n---\n\n${BODY}`, 'MANUAL', ['**/*.ts']],
  ])('%s', async (label, source, type, globs) => {
    const file = path.join(dir, `${label.replaceAll(' ', '-')}.md`);
    fs.writeFileSync(file, teamRuleToCodebuddyRule(source));

    const parsed = await parser!.parse(file);

    expect(parsed.type).toBe(type);
    expect(parsed.alwaysApply).toBe(type === 'ALWAYS');
    expect(parsed.globs).toEqual(globs);
    expect(parsed.content).toBe(BODY.trim());
  });

  // The verbatim copy teamai wrote before: CodeBuddy kept the brackets.
  it('reads the old verbatim copy of an inline list with brackets in its globs', async () => {
    const file = path.join(dir, 'verbatim.md');
    fs.writeFileSync(file, `---\npaths: ["src/**/*.ts", "test/**"]\n---\n\n${BODY}`);

    expect((await parser!.parse(file)).globs).toEqual(['["src/**/*.ts"', '"test/**"]']);
  });
});

const joycodeBundle = ruleParserBundle('joycode');

describe.skipIf(!joycodeBundle)('JoyCode reads its .mdc render as intended', () => {
  const parser = joycodeBundle ? loadJoycodeRuleParser(joycodeBundle) : undefined;
  const cwd = '/repo';
  const applied = (mdc: string, files: string[]): string[] =>
    files.filter((file) => parser!.applies(mdc, 'rule.mdc', path.join(cwd, file), cwd));
  const FILES = ['src/a/x.ts', 'src/b/y.tsx', 'src/c/z.ts', 'test/t.js', 'docs/d.md'];

  it.each([
    ['an unscoped rule', BODY, true, FILES],
    ['an inline list', `---\npaths: ["src/**/*.ts", "test/**"]\n---\n\n${BODY}`, false, ['src/a/x.ts', 'src/c/z.ts', 'test/t.js']],
    ['a block list', `---\npaths:\n  - "src/**/*.ts"\n  - test/**\n---\n\n${BODY}`, false, ['src/a/x.ts', 'src/c/z.ts', 'test/t.js']],
    ['a brace glob', `---\npaths:\n  - "src/{a,b}/**"\n  - "**/*.{md,js}"\n---\n\n${BODY}`, false, ['src/a/x.ts', 'src/b/y.tsx', 'test/t.js', 'docs/d.md']],
    ['an unquoted alias-like glob', `---\npaths: **/*.ts\n---\n\n${BODY}`, false, ['src/a/x.ts', 'src/c/z.ts']],
  ])('%s', (_label, source, alwaysApply, files) => {
    const mdc = teamRuleToJoycodeRule(source);
    const parsed = parser!.parse(mdc, 'rule.mdc');

    expect(parsed.alwaysApply).toBe(alwaysApply);
    expect(parsed.body).toBe(BODY);
    expect(applied(mdc, FILES)).toEqual(files);
  });

  // Cursor's render, which teamai wrote before: JoyCode keeps the quotes and
  // splits the brace group, so the rule applies to no file.
  it.each([
    ['an inline list', `---\npaths: ["src/**/*.ts", "test/**"]\n---\n\n${BODY}`],
    ['a brace glob', `---\npaths:\n  - "src/{a,b}/**"\n---\n\n${BODY}`],
  ])('applies the old Cursor render of %s to no file', (_label, source) => {
    expect(applied(teamRuleToCursorMdc(source), FILES)).toEqual([]);
  });
});
