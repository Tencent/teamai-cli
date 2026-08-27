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
 *   team `.md`  ──teamRuleToCursorMdc───────▶  Cursor `.mdc`   (pull)
 *   Cursor `.mdc`  ──mergeCursorBodyIntoTeamMd──▶  team `.md`  (push)
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
 * cursorMdcBodyEqualsTeamMd) and silent loss of the team rule's `paths:` scope.
 */

/** The Cursor frontmatter fields we emit. */
interface CursorFrontmatter {
  globs?: string;
  alwaysApply: boolean;
}

/**
 * A leading `---\n...\n---` frontmatter block, with an optional BOM. The inner
 * group is optional so an empty block (`---\n---`) matches too — otherwise its
 * delimiters would leak into the body and get pushed to the team repo verbatim.
 */
const FRONTMATTER_RE = /^﻿?---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/;

/**
 * Split a rule file into its leading frontmatter block (empty string when there
 * is none) and its body. Deliberately textual, NOT a YAML parse: the Cursor
 * `globs` value is a glob, and a strict parse of a malformed one would fail and
 * swallow the frontmatter into the body. Delimiter-based splitting round-trips
 * regardless of YAML validity.
 */
function splitFrontmatter(raw: string): { block: string; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  return m ? { block: m[0], body: raw.slice(m[0].length) } : { block: '', body: raw };
}

/** Extract the markdown body of a rule file, dropping any frontmatter block. */
function extractBody(raw: string): string {
  return splitFrontmatter(raw).body;
}

/**
 * Quote scalars that YAML would read as an alias (`*`) or anchor (`&`) node.
 * A glob is the common case: `globs: **\/*.ts` is not valid YAML, so a strict
 * parse of an otherwise fine frontmatter block throws on it.
 */
function quoteYamlUnsafeScalars(block: string): string {
  return block
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:-\s+|[A-Za-z0-9_.-]+:[ \t]+))([*&][^"']*)$/);
      return m ? `${m[1]}"${m[2].trimEnd()}"` : line;
    })
    .join('\n');
}

/**
 * Parse a team rule's frontmatter data with gray-matter, retrying once with
 * alias-unsafe scalars quoted so a rule authored as `globs: **\/*.ts` is still
 * honoured rather than silently falling back to always-on. Returns empty data
 * when both attempts fail.
 */
function parseFrontmatterData(raw: string): Record<string, unknown> {
  try {
    return matter(raw).data;
  } catch {
    // Invalid YAML — retry below with unsafe scalars quoted.
  }

  const { block } = splitFrontmatter(raw);
  if (!block) return {};
  const quoted = quoteYamlUnsafeScalars(block);
  try {
    return matter(quoted.endsWith('\n') ? quoted : `${quoted}\n`).data;
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
  // Quoted deliberately: a glob starting with `*` is an alias node in YAML, so
  // an unquoted value makes the whole block unparseable — which would put us
  // back where we started, with Cursor ignoring the rule.
  if (fm.globs !== undefined) lines.push(`globs: ${JSON.stringify(fm.globs)}`);
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
 * Write a Cursor `.mdc` file's markdown body back into the team repo `.md`,
 * keeping the team file's own frontmatter.
 *
 * Only the body crosses back: the Cursor-specific frontmatter (globs/alwaysApply)
 * is machine-derived on pull and is dropped, while the team rule's tool-neutral
 * frontmatter (`paths:`, …) is preserved from `existingTeamMd`. Dropping it
 * instead would silently un-scope the rule for the whole team on the next pull.
 *
 * `existingTeamMd` is null for a rule that does not exist upstream yet, in which
 * case the body alone becomes the new team file.
 */
export function mergeCursorBodyIntoTeamMd(
  rawCursorMdc: string,
  existingTeamMd: string | null,
): string {
  const body = normalizeBody(extractBody(rawCursorMdc));
  if (existingTeamMd === null) return `${body}\n`;

  // Body unchanged — hand back the team file byte-for-byte so a no-op push
  // never shows up as a diff.
  if (normalizeBody(extractBody(existingTeamMd)) === body) return existingTeamMd;

  const { block } = splitFrontmatter(existingTeamMd);
  if (!block) return `${body}\n`;
  return `${block.endsWith('\n') ? block : `${block}\n`}\n${body}\n`;
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
