import { describe, expect, it } from 'vitest';
import { teamRuleToCodebuddyRule } from '../resources/codebuddy-rule.js';
import { teamRuleToCopilotInstructions } from '../resources/copilot-instructions.js';
import { teamRuleToJoycodeRule } from '../resources/joycode-rule.js';
import { teamRuleToKiroSteering } from '../resources/kiro-steering.js';
import { teamRuleToOmpRule } from '../resources/omp-rule.js';
import { teamRuleToQoderRule } from '../resources/qoder-rule.js';

/**
 * The exact bytes each tool's rule render writes (#946). Kiro and Qoder ship
 * no parser to run, so these pin the documented form. This file is the test
 * of kiro-steering.ts, qoder-rule.ts, omp-rule.ts, codebuddy-rule.ts,
 * joycode-rule.ts, copilot-instructions.ts and team-rule.ts's `paths:` parse.
 */
const UNSCOPED = 'Use named exports.\n';
const INLINE = '---\npaths: ["src/**/*.ts", "test/**"]\n---\n\nUse named exports.\n';
const BLOCK = '---\npaths:\n  - "src/**/*.ts"\n  - test/**\n---\n\nUse named exports.\n';
const BRACE = '---\npaths:\n  - "src/{a,b}/**"\n---\n\nUse named exports.\n';

describe('Kiro steering render', () => {
  it('makes an unscoped rule always included', () => {
    expect(teamRuleToKiroSteering(UNSCOPED)).toBe('---\ninclusion: always\n---\n\nUse named exports.\n');
  });

  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
  ])('scopes %s with fileMatch and a fileMatchPattern list', (_label, source) => {
    expect(teamRuleToKiroSteering(source)).toBe(
      '---\ninclusion: fileMatch\nfileMatchPattern: ["src/**/*.ts", "test/**"]\n---\n\nUse named exports.\n',
    );
  });

  it('keeps a brace glob whole, since the pattern list does not split on commas', () => {
    expect(teamRuleToKiroSteering(BRACE)).toBe(
      '---\ninclusion: fileMatch\nfileMatchPattern: ["src/{a,b}/**"]\n---\n\nUse named exports.\n',
    );
  });
});

describe('Qoder rule render', () => {
  it('makes an unscoped rule always on', () => {
    expect(teamRuleToQoderRule(UNSCOPED)).toBe('---\ntrigger: always_on\n---\n\nUse named exports.\n');
  });

  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
  ])('scopes %s with trigger glob and one comma-joined glob line, as Qoder Desktop writes it', (_label, source) => {
    expect(teamRuleToQoderRule(source)).toBe(
      '---\ntrigger: glob\nglob: src/**/*.ts, test/**\n---\n\nUse named exports.\n',
    );
  });

  it('expands a brace glob, since the glob line is split on every comma', () => {
    expect(teamRuleToQoderRule(BRACE)).toBe(
      '---\ntrigger: glob\nglob: src/a/**, src/b/**\n---\n\nUse named exports.\n',
    );
  });

  it('expands a brace glob given as a comma-separated paths string', () => {
    const source = '---\npaths: "src/{a,b}/**, test/**"\n---\n\nUse named exports.\n';
    expect(teamRuleToQoderRule(source)).toBe(
      '---\ntrigger: glob\nglob: src/a/**, src/b/**, test/**\n---\n\nUse named exports.\n',
    );
  });
});

describe('Oh My Pi rule render', () => {
  it('makes an unscoped rule always applied', () => {
    expect(teamRuleToOmpRule(UNSCOPED)).toBe('---\nalwaysApply: true\n---\n\nUse named exports.\n');
  });

  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
  ])('scopes %s with globs and a description, as OMP drops a rule with neither', (_label, source) => {
    expect(teamRuleToOmpRule(source)).toBe(
      '---\ndescription: "Team rule for files matching src/**/*.ts, test/**"\nglobs: ["src/**/*.ts", "test/**"]\n---\n\n'
      + 'Use named exports.\n',
    );
  });

  it('keeps a brace glob whole', () => {
    expect(teamRuleToOmpRule(BRACE)).toBe(
      '---\ndescription: "Team rule for files matching src/{a,b}/**"\nglobs: ["src/{a,b}/**"]\n---\n\nUse named exports.\n',
    );
  });

  it('describes a scoped rule by its first heading, wherever it is', () => {
    const source = '---\npaths: ["src/**"]\n---\n\nIntro line.\n\n## API "client" rules\n\nUse the shared client.\n';
    expect(teamRuleToOmpRule(source)).toBe(
      '---\ndescription: "API \\"client\\" rules"\nglobs: ["src/**"]\n---\n\nIntro line.\n\n## API "client" rules\n\nUse the shared client.\n',
    );
  });
});

describe('CodeBuddy rule render (CodeBuddy and WorkBuddy)', () => {
  const SCOPED = '---\nalwaysApply: false\npaths:\n  - "src/**/*.ts"\n  - "test/**"\n---\n\nUse named exports.\n';

  it('makes an unscoped rule always applied', () => {
    expect(teamRuleToCodebuddyRule(UNSCOPED)).toBe('---\nalwaysApply: true\n---\n\nUse named exports.\n');
  });

  // Its frontmatter parser reads lines, not YAML: an inline list keeps its
  // brackets in the globs, so the render always writes a block list.
  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
    ['a comma-separated string', '---\npaths: src/**/*.ts, test/**\n---\n\nUse named exports.\n'],
  ])('scopes %s with alwaysApply false and paths as a block list', (_label, source) => {
    expect(teamRuleToCodebuddyRule(source)).toBe(SCOPED);
  });

  it('keeps a brace glob whole, since a list item is not split on commas', () => {
    expect(teamRuleToCodebuddyRule(BRACE)).toBe(
      '---\nalwaysApply: false\npaths:\n  - "src/{a,b}/**"\n---\n\nUse named exports.\n',
    );
  });
});

describe('JoyCode rule render', () => {
  it('makes an unscoped rule always applied', () => {
    expect(teamRuleToJoycodeRule(UNSCOPED)).toBe('---\nalwaysApply: true\n---\n\nUse named exports.\n');
  });

  // JoyCode reads the globs line as it stands, quotes included, and splits it
  // on every comma: the globs are written unquoted and `{a,b}` is expanded.
  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
  ])('scopes %s with unquoted, comma-joined globs and alwaysApply false', (_label, source) => {
    expect(teamRuleToJoycodeRule(source)).toBe(
      '---\nglobs: src/**/*.ts, test/**\nalwaysApply: false\n---\n\nUse named exports.\n',
    );
  });

  it('expands a brace glob, since the globs line is split on every comma', () => {
    const source = '---\npaths: ["src/{a,b}/**", "test/**"]\n---\n\nUse named exports.\n';
    expect(teamRuleToJoycodeRule(source)).toBe(
      '---\nglobs: src/a/**, src/b/**, test/**\nalwaysApply: false\n---\n\nUse named exports.\n',
    );
  });
});

describe('Copilot instructions render', () => {
  it('applies an unscoped rule to every file', () => {
    expect(teamRuleToCopilotInstructions(UNSCOPED)).toBe("---\napplyTo: '**'\n---\n\nUse named exports.\n");
  });

  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
  ])('scopes %s with one comma-joined applyTo', (_label, source) => {
    expect(teamRuleToCopilotInstructions(source)).toBe(
      "---\napplyTo: 'src/**/*.ts, test/**'\n---\n\nUse named exports.\n",
    );
  });

  it('scopes an unquoted alias-like glob, as every other render does', () => {
    const source = '---\npaths: **/*.ts\n---\n\nUse named exports.\n';
    expect(teamRuleToCopilotInstructions(source)).toBe("---\napplyTo: '**/*.ts'\n---\n\nUse named exports.\n");
  });
});

describe('team rule paths, shared by every render', () => {
  it.each([
    'paths: **/*.ts # TypeScript files',
    'paths: **/*.ts # TypeScript\'s "source" files',
    'paths:\n  - **/*.ts  # TypeScript files',
    'paths: **/*#draft.ts # TypeScript files',
  ])('keeps a YAML comment outside the repaired glob: %s', (frontmatter) => {
    const source = `---\n${frontmatter}\n---\n\nUse named exports.\n`;
    const glob = frontmatter.includes('#draft') ? '**/*#draft.ts' : '**/*.ts';
    const quoted = `---\npaths: ${JSON.stringify(glob)}\n---\n\nUse named exports.\n`;
    expect(teamRuleToKiroSteering(source)).toBe(teamRuleToKiroSteering(quoted));
    expect(teamRuleToOmpRule(source)).toBe(teamRuleToOmpRule(quoted));
  });

  // gray-matter caches a parse by content, failures included: the retry that
  // quotes `**/*.ts` must not lose to a cached failure on the next render.
  it('scopes an unquoted alias-like glob on every render, not just the first', () => {
    const source = '---\npaths: **/*.ts\n---\n\nUse named exports.\n';
    const scoped = '---\ninclusion: fileMatch\nfileMatchPattern: ["**/*.ts"]\n---\n\nUse named exports.\n';
    expect(teamRuleToKiroSteering(source)).toBe(scoped);
    expect(teamRuleToKiroSteering(source)).toBe(scoped);
  });
});
