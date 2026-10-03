import matter from 'gray-matter';

/**
 * The tool-neutral team rule: a `.md` whose optional frontmatter holds
 * `paths:` (the globs it is scoped to) and whose Markdown body is the rule.
 * Every per-tool render (`rule-format.ts`) reads a team rule through here, so
 * `paths:` is parsed one way, and every push merges a tool copy back through
 * here, so only the body crosses back.
 */

/**
 * A leading `---\n...\n---` frontmatter block, with an optional BOM. The inner
 * group is optional so an empty block (`---\n---`) matches too — otherwise its
 * delimiters would leak into the body and get pushed to the team repo verbatim.
 */
const FRONTMATTER_RE = /^﻿?---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/;

/**
 * Split a rule file into its leading frontmatter block (empty string when there
 * is none) and its body. Deliberately textual, NOT a YAML parse: a tool's glob
 * value may be invalid YAML, and a strict parse of it would fail and swallow
 * the frontmatter into the body. Delimiter-based splitting round-trips
 * regardless of YAML validity.
 */
function splitRuleFrontmatter(raw: string): { block: string; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  return m ? { block: m[0], body: raw.slice(m[0].length) } : { block: '', body: raw };
}

/**
 * Quote scalars that YAML would read as an alias (`*`) or anchor (`&`) node.
 * A glob is the common case: `paths: **\/*.ts` is not valid YAML, so a strict
 * parse of an otherwise fine frontmatter block throws on it.
 */
function quoteYamlUnsafeScalars(block: string): string {
  return block
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:-\s+|[A-Za-z0-9_.-]+:[ \t]+))([*&].*)$/);
      if (!m) return line;
      // YAML comments begin at a whitespace-separated #; a # inside a glob is literal.
      const commentAt = m[2].search(/[ \t]+#/);
      const scalar = (commentAt === -1 ? m[2] : m[2].slice(0, commentAt)).trimEnd();
      const comment = commentAt === -1 ? '' : m[2].slice(commentAt);
      return /["']/.test(scalar) ? line : `${m[1]}${JSON.stringify(scalar)}${comment}`;
    })
    .join('\n');
}

/**
 * A team rule's frontmatter data, parsed with gray-matter and retried once
 * with alias-unsafe scalars quoted, so a rule authored as `paths: **\/*.ts` is
 * still scoped rather than silently always on. Empty when both attempts fail.
 *
 * Options are passed to disable gray-matter's module-level cache: it keeps a
 * failed parse too, so a second render of the same rule skipped the retry and
 * came out unscoped.
 */
export function teamRuleData(raw: string): Record<string, unknown> {
  try {
    return matter(raw, {}).data;
  } catch {
    // Invalid YAML — retry below with unsafe scalars quoted.
  }

  const { block } = splitRuleFrontmatter(raw);
  if (!block) return {};
  const quoted = quoteYamlUnsafeScalars(block);
  try {
    return matter(quoted.endsWith('\n') ? quoted : `${quoted}\n`, {}).data;
  } catch {
    return {};
  }
}

/** The team rule as it is: what a tool with no rules format of its own gets, and what an older teamai gave the rest. */
export const verbatimRule = (rawTeamRule: string): string => rawTeamRule;

/** Normalize a markdown body for comparison (ignore leading/trailing whitespace). */
function normalizeBody(body: string): string {
  return body.replace(/^\s+/, '').replace(/\s+$/, '');
}

/** The Markdown body of a rule file, frontmatter dropped and outer whitespace trimmed. */
export function teamRuleBody(raw: string): string {
  return normalizeBody(splitRuleFrontmatter(raw).body);
}

/** `value` split on the commas outside `{...}`, so `src/{a,b}/**` stays one glob. */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/**
 * The globs a team rule's `paths:` frontmatter scopes it to; empty when
 * unscoped. A string is split on its top-level commas.
 */
export function rulePaths(data: Record<string, unknown>): string[] {
  const value = data.paths;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return splitTopLevelCommas(value).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

/**
 * `glob` with every `{a,b}` alternation expanded, for a tool that splits a
 * glob list on every comma: `src/{a,b}/**` becomes `src/a/**`, `src/b/**`.
 * A group without a comma stays literal.
 */
export function expandBraces(glob: string): string[] {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth > 0) continue;
      const alternatives = splitTopLevelCommas(glob.slice(open + 1, i));
      if (alternatives.length < 2) continue;
      const prefix = glob.slice(0, open);
      const suffix = glob.slice(i + 1);
      return alternatives.flatMap((alternative) => expandBraces(`${prefix}${alternative}${suffix}`));
    }
  }
  return [glob];
}

/**
 * Write a tool copy's Markdown body back into the team repo `.md`, keeping the
 * team file's own frontmatter.
 *
 * Only the body crosses back: the tool's frontmatter is machine-derived on
 * pull and is dropped, while the team rule's tool-neutral frontmatter
 * (`paths:`, …) is preserved from `existingTeamMd`. Dropping it instead would
 * silently un-scope the rule for the whole team on the next pull.
 *
 * `existingTeamMd` is null for a rule that does not exist upstream yet, in which
 * case the body alone becomes the new team file.
 */
export function mergeRuleBodyIntoTeamMd(rawToolRule: string, existingTeamMd: string | null): string {
  const body = teamRuleBody(rawToolRule);
  if (existingTeamMd === null) return `${body}\n`;

  // Body unchanged — hand back the team file byte-for-byte so a no-op push
  // never shows up as a diff.
  if (teamRuleBody(existingTeamMd) === body) return existingTeamMd;

  const { block } = splitRuleFrontmatter(existingTeamMd);
  if (!block) return `${body}\n`;
  return `${block.endsWith('\n') ? block : `${block}\n`}\n${body}\n`;
}

/**
 * Compare the Markdown body of a tool copy against a team repo `.md`, ignoring
 * frontmatter on both sides. Used by push scanning so that a pull-then-push
 * round trip (which rewrites frontmatter) is not seen as a content change.
 */
export function ruleBodyEqualsTeamMd(rawToolRule: string, rawTeamRule: string): boolean {
  return teamRuleBody(rawToolRule) === teamRuleBody(rawTeamRule);
}
