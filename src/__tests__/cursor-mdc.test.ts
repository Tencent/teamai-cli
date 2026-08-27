import { describe, it, expect } from 'vitest';
import {
  teamRuleToCursorMdc,
  cursorMdcToTeamMd,
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
    expect(mdc).toContain('globs: **/*.ts, **/*.tsx');
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
    expect(mdc).toContain('globs: src/**/*.py, tests/**/*.py');
    expect(mdc).toContain('alwaysApply: false');
  });

  it('starts the output with a frontmatter block', () => {
    expect(teamRuleToCursorMdc('body').startsWith('---\n')).toBe(true);
  });
});

describe('cursorMdcToTeamMd', () => {
  it('strips Cursor frontmatter and keeps the body', () => {
    const mdc = `---
globs: **/*.ts
alwaysApply: false
---

The rule body.`;
    expect(cursorMdcToTeamMd(mdc)).toBe('The rule body.\n');
  });

  it('handles content with no frontmatter', () => {
    expect(cursorMdcToTeamMd('just a body')).toBe('just a body\n');
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
