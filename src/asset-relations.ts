/**
 * Asset relations (#1552 first slice): relations a team declares between its
 * assets — rules, docs, learnings — and the relations a local Markdown link to
 * another asset implies.
 *
 * The vocabulary is four of the seven code-graph `RelationType` names; an edge
 * reads "from RELATION to", the same direction the code graph uses. Only a
 * rule, a doc or a learning declares a relation; a skill and a teamwiki page
 * are targets only. A declaration outside the table never becomes a relation,
 * wherever the file came from — `contribute`, `import` and `import --from-mr`
 * included.
 *
 * One parser serves both readers of a declaration:
 * - `teamai review --branch` reports each structural violation at `fail` level;
 * - `teamai contribute` reports the same findings at `warn` and still publishes;
 * - the search-index build silently keeps only what parses, so recall never
 *   shows a relation the checks would reject.
 */

import path from 'node:path';

/** The relations an asset may declare. The other three code-graph relations (`DEPENDS_ON`, `CONTAINS`, `IMPLEMENTS`) relate code to code and can never be declared on an asset. */
export const ASSET_RELATIONS = ['MAPS_TO', 'REFERENCES', 'SUPERSEDES', 'CONFLICTS_WITH'] as const;
export type AssetRelationType = (typeof ASSET_RELATIONS)[number];

/** Every code-graph relation name, so a code-only key gets its own message instead of "unknown". */
const CODE_ONLY_RELATIONS = ['DEPENDS_ON', 'CONTAINS', 'IMPLEMENTS'] as const;

/** The kind of asset a relation endpoint names. */
export type AssetKind = 'rule' | 'doc' | 'learning' | 'skill' | 'teamwiki';

/** How a relation came about: declared in `related:` frontmatter, or derived from a local Markdown link. */
export type RelationVia = 'declared' | 'link';

/** One outgoing relation stored on a search-index entry; `target` is a team-tree path (see {@link normalizeTargetPath}). */
export interface StoredRelation {
  relation: AssetRelationType;
  target: string;
  via: RelationVia;
}

export type RelationSeverity = 'fail' | 'warn';

/**
 * Which targets each source kind may declare each relation to. `REFERENCES`
 * accepts any asset; the concrete rows follow the triage table on #1552.
 * A learning never `SUPERSEDES` a rule: `contribute` publishes learnings with
 * no review, so a learning that disagrees with a rule declares `CONFLICTS_WITH`.
 */
const DECLARABLE: Record<'rule' | 'doc' | 'learning', Record<AssetRelationType, readonly AssetKind[]>> = {
  rule: {
    MAPS_TO: ['teamwiki'],
    REFERENCES: ['rule', 'doc', 'learning', 'skill', 'teamwiki'],
    SUPERSEDES: ['rule', 'doc', 'learning'],
    CONFLICTS_WITH: ['rule', 'doc', 'learning'],
  },
  doc: {
    MAPS_TO: ['teamwiki'],
    REFERENCES: ['rule', 'doc', 'learning', 'skill', 'teamwiki'],
    SUPERSEDES: ['doc', 'learning'],
    CONFLICTS_WITH: ['rule', 'doc', 'learning'],
  },
  learning: {
    MAPS_TO: ['teamwiki'],
    REFERENCES: ['rule', 'doc', 'learning', 'skill', 'teamwiki'],
    SUPERSEDES: ['doc', 'learning'],
    CONFLICTS_WITH: ['rule', 'doc', 'learning'],
  },
};

/** The team-tree prefix of each asset kind, longest first so `teamwiki/` wins over nothing shorter. */
const KIND_PREFIXES: Array<[AssetKind, string]> = [
  ['rule', 'rules/'],
  ['doc', 'docs/'],
  ['learning', 'learnings/'],
  ['skill', 'skills/'],
  ['teamwiki', 'teamwiki/'],
];

/** The `AssetKind` a team-tree path starts with, or null when the prefix names no asset. */
export function classifyTreePath(treePath: string): AssetKind | null {
  for (const [kind, prefix] of KIND_PREFIXES) {
    if (treePath.startsWith(prefix)) return kind;
  }
  return null;
}

/**
 * A target path as written in `related:` or in a link, brought to its
 * canonical team-tree form: posix separators, `.md` present for the file kinds
 * (`rules/`, `docs/`, `teamwiki/`) and absent for `learnings/<id>` and
 * `skills/<dir>` — a link to a skill's `SKILL.md` canonicalizes to the skill
 * directory, the form the index keys skills by. Returns null when the path is
 * absolute, climbs out with `..` after normalising, or has no known prefix —
 * such a path never becomes a relation.
 */
export function normalizeTargetPath(raw: string): string | null {
  if (!raw || path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return null;
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) return null;
  const kind = classifyTreePath(normalized);
  if (!kind) return null;
  if (kind === 'rule' || kind === 'doc' || kind === 'teamwiki') {
    return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  }
  if (kind === 'skill') {
    return normalized.replace(/\/SKILL\.md$/i, '');
  }
  return normalized.replace(/\.md$/i, '');
}

/** The codebase slug of a `teamwiki/evidence/code/<slug>/…` path; null for any other path. */
export function teamwikiCodebaseSlug(treePath: string): string | null {
  const parts = treePath.split('/');
  return parts.length > 3 && parts[0] === 'teamwiki' && parts[1] === 'evidence' && parts[2] === 'code'
    ? parts[3] ?? null
    : null;
}

/**
 * Parse one `related:` frontmatter block as declared outgoing relations.
 *
 * `structuralSeverity` is the level the caller wants for structural problems
 * (`fail` in `review --branch`, `warn` in `contribute`); "names no asset" and
 * "relation to itself" are always `warn`. `targetExists` decides whether a
 * syntactically valid path names an asset; the caller supplies the scope it
 * resolves in (the search index at recall time, the branch tree in
 * `review --branch`, the team clone in `contribute`).
 *
 * The returned relations are deduplicated (same relation and target shown
 * once) and keep the file's order; two different relations to the same target
 * both stay.
 */
export function parseRelatedBlock(
  rawRelated: unknown,
  sourceKind: 'rule' | 'doc' | 'learning',
  ownTreePath: string,
  structuralSeverity: RelationSeverity,
  targetExists: (kind: AssetKind, treePath: string) => boolean,
  report: (severity: RelationSeverity, message: string) => void,
  noAssetNote = 'names no team asset',
): StoredRelation[] {
  if (rawRelated === undefined || rawRelated === null) return [];
  if (typeof rawRelated !== 'object' || Array.isArray(rawRelated)) {
    report(structuralSeverity, '`related` is not a mapping; all of it is ignored.');
    return [];
  }
  const block = rawRelated as Record<string, unknown>;
  const out: StoredRelation[] = [];
  const seen = new Set<string>();
  const useList = `Use ${ASSET_RELATIONS.join(', ').replace(/, ([^,]*)$/, ' or $1')}.`;
  for (const [rawKey, rawValue] of Object.entries(block)) {
    const key = rawKey.toUpperCase();
    if ((CODE_ONLY_RELATIONS as readonly string[]).includes(key)) {
      report(structuralSeverity, `${key} relates code to code and cannot be declared on a ${sourceKind}. ${useList}`);
      continue;
    }
    if (!(ASSET_RELATIONS as readonly string[]).includes(key)) {
      report(structuralSeverity, `"${rawKey}" is not a relation. ${useList}`);
      continue;
    }
    const relation = key as AssetRelationType;
    const values: unknown[] | null = typeof rawValue === 'string' ? [rawValue] : Array.isArray(rawValue) ? rawValue : null;
    if (values === null) {
      report(structuralSeverity, `${key} is not a string or a list; that key is ignored.`);
      continue;
    }
    const strings = values.filter((v): v is string => typeof v === 'string');
    if (strings.length !== values.length) {
      report(structuralSeverity, `${key} mixes strings with other values; the strings are kept, the rest ignored.`);
    }
    for (const written of strings) {
      const target = normalizeTargetPath(written);
      if (target === null) {
        report(structuralSeverity, `${key} ${written} is absolute, climbs out with '..', or has no known prefix; this relation is ignored.`);
        continue;
      }
      if (target === ownTreePath) {
        report('warn', `${key} ${written} names this ${sourceKind} itself; this relation is ignored.`);
        continue;
      }
      const kind = classifyTreePath(target)!;
      if (!DECLARABLE[sourceKind][relation].includes(kind)) {
        const alternative = relation === 'SUPERSEDES' && kind === 'rule' && sourceKind === 'learning'
          ? ' Use CONFLICTS_WITH;'
          : '';
        report(structuralSeverity, `a ${sourceKind} cannot ${relation} a ${kind} (${target}).${alternative} this relation is ignored.`);
        continue;
      }
      if (!targetExists(kind, target)) {
        report('warn', `${key} ${written} ${noAssetNote}; this relation is ignored.`);
        continue;
      }
      const dedupe = `${relation}${target}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ relation, target, via: 'declared' });
    }
  }
  return out;
}

/** The team-tree prefixes a link target may name absolutely; anything else is resolved against the linking file's own directory. */
const TEAM_ROOT_PREFIXES = ['rules/', 'docs/', 'learnings/', 'skills/', 'teamwiki/'];

/**
 * The relations implied by the local links of a file: a link that lands on an
 * asset becomes `REFERENCES`. A target written as a team-root path
 * (`docs/x.md`) is taken as written; a bare relative destination
 * (`payments-overview.md`) resolves against the file's own directory, so
 * `[overview](payments-overview.md)` in `docs/payments.md` names
 * `docs/payments-overview.md` — the file's place in the team's tree, never
 * its location on disk.
 */
export function relationsFromLinks(
  markdown: string,
  ownTreePath: string,
  linkTargets: (markdown: string) => string[],
): StoredRelation[] {
  const out: StoredRelation[] = [];
  const seen = new Set<string>();
  for (const raw of linkTargets(markdown)) {
    const rooted = TEAM_ROOT_PREFIXES.some((prefix) => raw.startsWith(prefix));
    const resolved = rooted
      ? raw
      : path.posix.normalize(path.posix.join(path.posix.dirname(ownTreePath), raw));
    const target = normalizeTargetPath(resolved);
    if (target === null || target === ownTreePath) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push({ relation: 'REFERENCES', target, via: 'link' });
  }
  return out;
}
