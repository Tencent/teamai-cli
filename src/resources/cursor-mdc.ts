import matter from 'gray-matter';

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
 *   team `.md`  ──teamRuleToCursorMdc──▶  Cursor `.mdc`   (pull)
 *   Cursor `.mdc`  ──cursorMdcToTeamMd──▶  team `.md`      (push)
 *
 * Mapping:
 *   - team `paths: [glob, ...]`  → Cursor `globs: <comma-joined>` + `alwaysApply: false`
 *   - no `paths` (a mandatory team rule) → Cursor `alwaysApply: true`
 *     (Cursor applies such rules to every chat session; globs/description ignored)
 *
 * The markdown body is preserved verbatim in both directions. Only the frontmatter
 * is machine-derived, which is what lets pull→push round-trip without spurious
 * "modified" diffs (see cursorMdcBodyEqualsTeamMd).
 */

/** The Cursor frontmatter fields we emit. */
interface CursorFrontmatter {
  globs?: string;
  alwaysApply: boolean;
}

/**
 * Extract the markdown body of a rule file by textually removing a leading
 * `---\n...\n---` frontmatter block. Deliberately does NOT parse YAML: the
 * Cursor `globs` value we emit (a glob starting with a star) is valid to Cursor
 * but not to a strict YAML parser, so parsing would fail and swallow the
 * frontmatter into the body. Delimiter-based stripping round-trips regardless
 * of YAML validity.
 */
function extractBody(raw: string): string {
  const m = raw.match(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? raw.slice(m[0].length) : raw;
}

/**
 * Parse a team rule's frontmatter data with gray-matter. Team repo `.md` files
 * are human-authored valid YAML, so this is safe here. Returns empty data on any
 * parse failure.
 */
function parseFrontmatterData(raw: string): Record<string, unknown> {
  try {
    return matter(raw).data;
  } catch {
    return {};
  }
}

/** Normalize a markdown body for comparison (ignore leading/trailing whitespace). */
function normalizeBody(body: string): string {
  return body.replace(/^\s+/, '').replace(/\s+$/, '');
}

/**
 * Derive Cursor frontmatter from a team rule's frontmatter data.
 *
 * A team rule scoped with `paths:` becomes an auto-attached Cursor rule
 * (`globs` + `alwaysApply: false`). A rule with no `paths` is treated as a
 * mandatory team rule and made always-on (`alwaysApply: true`).
 */
function deriveCursorFrontmatter(data: Record<string, unknown>): CursorFrontmatter {
  const rawPaths = data.paths ?? data.globs;
  const patterns = Array.isArray(rawPaths)
    ? rawPaths.map((p) => String(p).trim()).filter(Boolean)
    : typeof rawPaths === 'string' && rawPaths.trim() !== ''
      ? rawPaths.split(',').map((p) => p.trim()).filter(Boolean)
      : [];

  if (patterns.length > 0) {
    return { globs: patterns.join(', '), alwaysApply: false };
  }
  return { alwaysApply: true };
}

/** Serialize Cursor frontmatter into a `.mdc` file string. */
function renderCursorMdc(fm: CursorFrontmatter, body: string): string {
  const lines = ['---'];
  if (fm.globs !== undefined) lines.push(`globs: ${fm.globs}`);
  lines.push(`alwaysApply: ${fm.alwaysApply}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n${normalizeBody(body)}\n`;
}

/**
 * Convert a team repo rule file (`.md`) into Cursor `.mdc` content.
 */
export function teamRuleToCursorMdc(rawTeamRule: string): string {
  const data = parseFrontmatterData(rawTeamRule);
  return renderCursorMdc(deriveCursorFrontmatter(data), extractBody(rawTeamRule));
}

/**
 * Convert a Cursor `.mdc` file back into team repo `.md` content.
 *
 * The Cursor-specific frontmatter (globs/alwaysApply) is dropped; only the
 * markdown body is written back to the team repo. This keeps the team repo as
 * the tool-neutral source of truth — a user editing the body of a `.cursor`
 * rule pushes just that body change upstream.
 */
export function cursorMdcToTeamMd(rawCursorMdc: string): string {
  return `${normalizeBody(extractBody(rawCursorMdc))}\n`;
}

/**
 * Compare the markdown body of a Cursor `.mdc` file against a team repo `.md`
 * file, ignoring frontmatter on both sides. Used by push scanning so that a
 * pull-then-push round-trip (which rewrites frontmatter) is not seen as a
 * content modification.
 */
export function cursorMdcBodyEqualsTeamMd(rawCursorMdc: string, rawTeamRule: string): boolean {
  return normalizeBody(extractBody(rawCursorMdc)) === normalizeBody(extractBody(rawTeamRule));
}
