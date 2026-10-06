import type { RuleFormat } from './rule-format.js';
import { mergeRuleBodyIntoTeamMd, ruleBodyEqualsTeamMd, rulePaths, teamRuleBody, teamRuleData } from './team-rule.js';

/**
 * Cursor project rules must live in `.cursor/rules/*.mdc` with YAML frontmatter
 * (`description` / `globs` / `alwaysApply`). A plain `.md` file placed there is
 * silently ignored by Cursor because it has no recognizable frontmatter, so the
 * team rules never enter a Cursor session.
 *
 * The team repo, in contrast, stores rules as `.md` with an optional, tool-neutral
 * frontmatter (currently a `paths:` array used to scope a rule to file globs).
 * This module converts between the two representations:
 *
 *   team `.md`  ──teamRuleToCursorMdc──────▶  Cursor `.mdc`   (pull)
 *   Cursor `.mdc`  ──mergeRuleBodyIntoTeamMd──▶  team `.md`  (push)
 *
 * Mapping:
 *   - team `paths: [glob, ...]`  → Cursor `globs: "<comma-joined>"` + `alwaysApply: false`
 *   - no `paths` (a mandatory team rule) → Cursor `alwaysApply: true`
 *     (Cursor applies such rules to every chat session; globs/description ignored)
 *
 * The markdown body is the only thing that crosses in both directions; the
 * frontmatter on each side stays owned by that side. On pull the Cursor
 * frontmatter is machine-derived, and on push the team file keeps its own
 * frontmatter and only its body is replaced. That is what lets a pull→push
 * round-trip avoid both spurious "modified" diffs (see
 * ruleBodyEqualsTeamMd) and silent loss of the team rule's `paths:` scope.
 */

/** The Cursor frontmatter fields we emit. */
interface CursorFrontmatter {
  globs?: string;
  alwaysApply: boolean;
}

/**
 * Derive Cursor frontmatter from a team rule's frontmatter data.
 *
 * A team rule scoped with `paths:` becomes an auto-attached Cursor rule
 * (`globs` + `alwaysApply: false`). A rule with no `paths` is treated as a
 * mandatory team rule and made always-on (`alwaysApply: true`).
 */
function deriveCursorFrontmatter(data: Record<string, unknown>): CursorFrontmatter {
  // `globs` is read too: a rule authored in Cursor's own spelling stays scoped.
  const patterns = rulePaths({ paths: data.paths ?? data.globs });
  if (patterns.length > 0) {
    return { globs: patterns.join(', '), alwaysApply: false };
  }
  return { alwaysApply: true };
}

/** Serialize Cursor frontmatter into a `.mdc` file string. */
function renderCursorMdc(fm: CursorFrontmatter, body: string): string {
  const lines = ['---'];
  // Quoted deliberately: a glob starting with `*` is an alias node in YAML, so
  // an unquoted value makes the whole block unparseable — which would put us
  // back where we started, with Cursor ignoring the rule.
  if (fm.globs !== undefined) lines.push(`globs: ${JSON.stringify(fm.globs)}`);
  lines.push(`alwaysApply: ${fm.alwaysApply}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n${body}\n`;
}

/**
 * Convert a team repo rule file (`.md`) into Cursor `.mdc` content.
 */
export function teamRuleToCursorMdc(rawTeamRule: string): string {
  return renderCursorMdc(deriveCursorFrontmatter(teamRuleData(rawTeamRule)), teamRuleBody(rawTeamRule));
}

/** Cursor's rules format (`.mdc`). */
export const CURSOR_MDC_FORMAT: RuleFormat = {
  extension: '.mdc',
  render: teamRuleToCursorMdc,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['globs', 'alwaysApply'],
};
