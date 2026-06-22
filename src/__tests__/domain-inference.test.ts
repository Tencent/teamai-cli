import { describe, it, expect } from 'vitest';
import { inferDomain } from '../utils/search-index.js';

// ---------------------------------------------------------------------------
// P1.4: inferDomain() unit tests
//
// Verifies the four-layer priority:
//   1. frontmatter > 2. tags > 3. path > 4. type fallback
// ---------------------------------------------------------------------------

describe('inferDomain()', () => {
  // ── 1. Frontmatter override ─────────────────────────────────────────────

  it('frontmatter "technical" overrides ops tags', () => {
    expect(
      inferDomain('technical', ['k8s', 'deploy'], '/path/learnings/foo.md', 'learnings'),
    ).toBe('technical');
  });

  it('frontmatter "ops" overrides technical tags', () => {
    expect(
      inferDomain('ops', ['api', 'debug'], '/path/docs/bar.md', 'docs'),
    ).toBe('ops');
  });

  it('frontmatter "support" overrides type fallback', () => {
    expect(
      inferDomain('support', [], '/path/skills/helper.md', 'skills'),
    ).toBe('support');
  });

  it('frontmatter "neutral" is respected', () => {
    expect(
      inferDomain('neutral', ['api', 'debug'], '/path/learnings/foo.md', 'learnings'),
    ).toBe('neutral');
  });

  it('unknown frontmatter value falls through to tag inference', () => {
    // 'infra' is not a valid KnowledgeDomain — should fall through to tags
    expect(
      inferDomain('infra', ['k8s', 'deploy'], '/path/learnings/foo.md', 'learnings'),
    ).toBe('ops');
  });

  // ── 2. Tag-based inference ───────────────────────────────────────────────

  it('detects technical from "api" and "debug" tags', () => {
    expect(
      inferDomain(undefined, ['api', 'debug'], '/path/learnings/foo.md', 'learnings'),
    ).toBe('technical');
  });

  it('detects ops from "k8s" and "deploy" tags', () => {
    expect(
      inferDomain(undefined, ['k8s', 'deploy'], '/path/learnings/bar.md', 'learnings'),
    ).toBe('ops');
  });

  it('detects support from "faq" and "user" tags', () => {
    expect(
      inferDomain(undefined, ['faq', 'user'], '/path/docs/guide.md', 'docs'),
    ).toBe('support');
  });

  it('tie-break: technical beats ops when both score equally', () => {
    // One tag from each domain → technical wins
    expect(
      inferDomain(undefined, ['api', 'k8s'], '/path/learnings/mixed.md', 'learnings'),
    ).toBe('technical');
  });

  it('tie-break: ops beats support when both score equally', () => {
    expect(
      inferDomain(undefined, ['deploy', 'user'], '/path/learnings/mixed.md', 'learnings'),
    ).toBe('ops');
  });

  // ── 3. Path-based inference ──────────────────────────────────────────────

  it('infers technical from docs/architecture/ path', () => {
    expect(
      inferDomain(undefined, [], '/home/user/.teamai/docs/architecture/design.md', 'docs'),
    ).toBe('technical');
  });

  it('infers ops from learnings/ops/ path', () => {
    expect(
      inferDomain(undefined, [], '/home/user/.teamai/learnings/ops/k8s-upgrade.md', 'learnings'),
    ).toBe('ops');
  });

  it('infers support from docs/support/ path', () => {
    expect(
      inferDomain(undefined, [], '/home/user/.teamai/docs/support/onboarding.md', 'docs'),
    ).toBe('support');
  });

  // ── 4. Type fallback ─────────────────────────────────────────────────────

  it('skills with no tags/path → technical', () => {
    expect(
      inferDomain(undefined, [], '/home/user/.claude/agents/skill.md', 'skills'),
    ).toBe('technical');
  });

  it('rules with no tags/path → technical', () => {
    expect(
      inferDomain(undefined, [], '/home/user/.claude/rules/coding-style.md', 'rules'),
    ).toBe('technical');
  });

  it('learnings with no tags/path → neutral', () => {
    expect(
      inferDomain(undefined, [], '/home/user/.teamai/learnings/misc.md', 'learnings'),
    ).toBe('neutral');
  });

  it('docs with no tags/path → neutral', () => {
    expect(
      inferDomain(undefined, [], '/home/user/.teamai/docs/misc.md', 'docs'),
    ).toBe('neutral');
  });
});
