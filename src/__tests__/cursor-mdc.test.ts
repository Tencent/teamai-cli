import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import {
  teamRuleToCursorMdc,
  mergeCursorBodyIntoTeamMd,
  cursorMdcBodyEqualsTeamMd,
} from '../resources/cursor-mdc.js';

describe('teamRuleToCursorMdc', () => {
  it('maps a team `paths:` array to Cursor `globs` with alwaysApply=false', () => {
    const team = `---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

Use named exports.`;
    const mdc = teamRuleToCursorMdc(team);
    expect(mdc).toContain('globs: "**/*.ts, **/*.tsx"');
    expect(mdc).toContain('alwaysApply: false');
    expect(mdc).toContain('Use named exports.');
  });

  it('treats a rule with no frontmatter as always-on (alwaysApply=true)', () => {
    const team = 'Always follow the MR submission process.';
    const mdc = teamRuleToCursorMdc(team);
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).not.toContain('globs:');
    expect(mdc).toContain('Always follow the MR submission process.');
  });

  it('treats a rule with unrelated frontmatter (no paths) as always-on', () => {
    const team = `---
title: Some Rule
---

Body here.`;
    const mdc = teamRuleToCursorMdc(team);
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).not.toContain('globs:');
    expect(mdc).toContain('Body here.');
  });

  it('accepts a comma-separated string `paths`', () => {
    const team = `---
paths: "src/**/*.py, tests/**/*.py"
---

Python rule.`;
    const mdc = teamRuleToCursorMdc(team);
    expect(mdc).toContain('globs: "src/**/*.py, tests/**/*.py"');
    expect(mdc).toContain('alwaysApply: false');
  });

  it('starts the output with a frontmatter block', () => {
    expect(teamRuleToCursorMdc('body').startsWith('---\n')).toBe(true);
  });
});

describe('teamRuleToCursorMdc — emitted frontmatter is valid YAML', () => {
  it('quotes globs so a leading-star glob does not break the YAML parse', () => {
    const team = `---
paths:
  - "**/*.ts"
---

Body.`;
    const mdc = teamRuleToCursorMdc(team);
    // Unquoted, `**/*.ts` is a YAML alias node and the whole block fails to
    // parse — which would leave Cursor ignoring the rule all over again.
    expect(() => matter(mdc)).not.toThrow();
    expect(matter(mdc).data).toEqual({ globs: '**/*.ts', alwaysApply: false });
  });

  it('honours a team rule authored with an unquoted `globs:` value', () => {
    const team = `---
globs: **/*.ts
---

Body.`;
    const mdc = teamRuleToCursorMdc(team);
    expect(matter(mdc).data).toEqual({ globs: '**/*.ts', alwaysApply: false });
  });
});

describe('mergeCursorBodyIntoTeamMd', () => {
  it('keeps the team rule frontmatter and replaces only the body', () => {
    const team = `---
paths:
  - "**/*.ts"
---

Original body.`;
    const mdc = `---
globs: "**/*.ts"
alwaysApply: false
---

Edited body.`;
    const merged = mergeCursorBodyIntoTeamMd(mdc, team);
    expect(merged).toContain('paths:');
    expect(merged).toContain('- "**/*.ts"');
    expect(merged).toContain('Edited body.');
    expect(merged).not.toContain('Original body.');
    expect(merged).not.toContain('alwaysApply');
    expect(merged).not.toContain('globs');
  });

  it('returns the team file untouched when the body did not change', () => {
    const team = `---
paths: ["**/*.ts"]
---

Same body.`;
    const mdc = teamRuleToCursorMdc(team);
    expect(mergeCursorBodyIntoTeamMd(mdc, team)).toBe(team);
  });

  it('writes body only for a rule that does not exist upstream yet', () => {
    const mdc = `---
alwaysApply: true
---

Brand new rule.`;
    expect(mergeCursorBodyIntoTeamMd(mdc, null)).toBe('Brand new rule.\n');
  });

  it('handles a team rule that has no frontmatter', () => {
    expect(mergeCursorBodyIntoTeamMd('just a body', 'old body')).toBe('just a body\n');
  });

  it('does not leak an empty `---/---` block into the body', () => {
    const mdc = '---\n---\nThe rule body.';
    expect(mergeCursorBodyIntoTeamMd(mdc, null)).toBe('The rule body.\n');
  });
});

describe('cursorMdcBodyEqualsTeamMd — round-trip stability', () => {
  it('a pulled .mdc compares equal to its source team .md (no spurious modified)', () => {
    const team = `---
paths:
  - "**/*.ts"
---

Rule text that must not drift.`;
    const mdc = teamRuleToCursorMdc(team);
    expect(cursorMdcBodyEqualsTeamMd(mdc, team)).toBe(true);
  });

  it('a mandatory (no-frontmatter) team rule round-trips equal', () => {
    const team = 'A mandatory rule with no frontmatter.';
    const mdc = teamRuleToCursorMdc(team);
    expect(cursorMdcBodyEqualsTeamMd(mdc, team)).toBe(true);
  });

  it('detects a genuine body edit as different', () => {
    const team = `---
paths: ["**/*.ts"]
---

Original body.`;
    const editedMdc = `---
globs: **/*.ts
alwaysApply: false
---

Edited body.`;
    expect(cursorMdcBodyEqualsTeamMd(editedMdc, team)).toBe(false);
  });

  it('ignores frontmatter-only differences', () => {
    const team = `---
paths: ["**/*.ts"]
---

Same body.`;
    const differentFrontmatter = `---
alwaysApply: true
---

Same body.`;
    expect(cursorMdcBodyEqualsTeamMd(differentFrontmatter, team)).toBe(true);
  });
});
