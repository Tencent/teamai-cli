/**
 * The asset-graph counts behind `teamai codebase --lint` (#1562 part 1).
 *
 * Lint reads the member's own recall indexes as they are — the same scopes
 * recall selects, never a fresh build — and counts, over the assets visible
 * there: resolved relations, assets without any relation, and declared
 * relations whose target names no asset on disk. The counts cover this
 * member's scope, not the whole team.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { classifyTreePath, normalizeTargetPath, teamwikiCodebaseSlug, type AssetKind, type AssetRelationType, type RelationVia } from './asset-relations.js';
import { caseFoldKey } from './manifest-schema.js';
import { detectProjectConfig, loadLocalConfigForScope, requireInit } from './config.js';
import { buildRelationContext, type RelationContext } from './recall.js';
import { getProjectSearchIndexPath, getUserSearchIndexPath, type LocalConfig, type SearchIndex } from './types.js';
import { readWorkspaceChildren } from './workspace-children.js';
import { indexableLearningsRoots } from './utils/learnings-roots.js';
import { pendingLearningsDir } from './utils/pending-learnings.js';
import { loadIndex } from './utils/search-index.js';

/** A declared relation whose target names no asset on disk. */
export interface LintUnresolvedRelation {
  /** The declaring asset's team-tree path. */
  from: string;
  relation: AssetRelationType;
  /** The target in canonical team-tree form. */
  target: string;
  /** Always 'no-asset' today: the target is in neither the team clone nor the learnings roots. */
  reason: 'no-asset';
}

/** The counts `--lint` prints and embeds in its JSON report as `assetGraph`. */
export interface LintAssetGraph {
  assetCount: number;
  relationCount: number;
  /** Team-tree paths of assets with no resolved relation in either direction. */
  withoutRelation: string[];
  unresolved: LintUnresolvedRelation[];
}

/** One scope's inputs to the count: recall's resolution state, plus the contribute-style existence check. */
export interface LintScopeGraph {
  ctx: RelationContext;
  targetExists: (kind: AssetKind, treePath: string) => boolean;
}

/**
 * Count the asset relations of the given scopes, with recall's rules: a
 * relation counts when it resolves — for an asset target, visibility in the
 * scope; for a teamwiki page, existence on disk and an unwithheld codebase —
 * and a local link to a target that also has a declared relation from the
 * same entry is prose, not a second edge. Existence, not visibility, decides
 * `unresolved`: a declared target that exists on disk but is not visible to
 * this member is neither counted nor unresolved, the same check `contribute`
 * makes (#1552).
 */
export function computeLintAssetGraph(scopes: readonly LintScopeGraph[]): LintAssetGraph {
  const assets = new Set<string>();
  // Declared beats link by target, as recall renders it, before the
  // unordered-pair dedup below; keyed by the ordered triple.
  const ordered = new Map<string, { from: string; relation: AssetRelationType; target: string; via: RelationVia }>();
  const unresolved = new Map<string, LintUnresolvedRelation>();

  for (const { ctx, targetExists } of scopes) {
    for (const [treePath, entry] of ctx.byTreePath) {
      // A teamwiki page can hold a treePath only in exotic index builds; it
      // is a target, never an asset.
      if (classifyTreePath(treePath) === 'teamwiki') continue;
      assets.add(treePath);
      const own = entry.related ?? [];
      // A local link to an asset that also has a declared relation from this
      // entry is prose, not a second edge — the same declared-beats-link rule
      // recall renders (#1562 review).
      const declaredTargets = new Set(own.filter((r) => r.via === 'declared').map((r) => r.target));
      for (const r of own) {
        const kind = classifyTreePath(r.target);
        if (r.via === 'declared' && kind !== null) {
          const normalized = normalizeTargetPath(r.target);
          if (normalized !== null && !targetExists(kind, normalized)) {
            unresolved.set(`${treePath}|${r.relation}|${normalized}`, {
              from: treePath, relation: r.relation, target: normalized, reason: 'no-asset',
            });
          }
        }
        if (r.via === 'link' && declaredTargets.has(r.target)) continue;
        // A relation to a teamwiki page counts when the page exists on disk
        // and its codebase is not withheld — the same visibility recall
        // renders. The page stays out of `assets` and `withoutRelation`: a
        // page is a target, not an asset (#1562).
        if (kind === 'teamwiki') {
          if (ctx.withheld === null) continue;
          const slug = teamwikiCodebaseSlug(r.target);
          if (slug !== null && ctx.withheld.has(caseFoldKey(slug))) continue;
          if (!targetExists('teamwiki', r.target)) continue;
          ordered.set(`${treePath}|${r.relation}|${r.target}`, { from: treePath, relation: r.relation, target: r.target, via: r.via });
          continue;
        }
        if (kind === null || !ctx.byTreePath.has(r.target)) continue;
        const key = `${treePath}|${r.relation}|${r.target}`;
        if (ordered.get(key)?.via === 'declared') continue;
        ordered.set(key, { from: treePath, relation: r.relation, target: r.target, via: r.via });
      }
    }
  }

  // Each relation counts once per unordered pair, relation and via: A→B and
  // the B←A view of the same edge are one relation, and recall's 5-line
  // output cap does not apply here (#1562).
  const relations = new Set<string>();
  const connected = new Set<string>();
  for (const edge of ordered.values()) {
    relations.add(`${edge.relation}|${[edge.from, edge.target].sort().join('|')}|${edge.via}`);
    connected.add(edge.from);
    connected.add(edge.target);
  }

  return {
    assetCount: assets.size,
    relationCount: relations.size,
    withoutRelation: [...assets].filter((a) => !connected.has(a)).sort(),
    unresolved: [...unresolved.values()].sort((a, b) =>
      `${a.from}|${a.relation}|${a.target}`.localeCompare(`${b.from}|${b.relation}|${b.target}`)),
  };
}

/**
 * The contribute-style existence predicate for one scope: a target is in the
 * team clone on disk (rules, docs, skills, teamwiki pages) or in the learnings
 * roots (pending queue included), mirroring `relationWarningsForLearning`
 * (`src/contribute.ts`) so lint and contribute never disagree about what
 * names an asset (#1552).
 */
async function scopeTargetExists(config: LocalConfig): Promise<(kind: AssetKind, treePath: string) => boolean> {
  let learningRoots: string[] = [];
  try {
    learningRoots = [pendingLearningsDir(config), ...await indexableLearningsRoots(config, [])];
  } catch {
    learningRoots = [pendingLearningsDir(config)];
  }
  const repoRoot = config.repo.localPath;
  return (kind, treePath) => {
    const rel = kind === 'learning'
      ? `${treePath.slice('learnings/'.length)}.md`
      : treePath;
    const roots = kind === 'learning' ? learningRoots : [repoRoot];
    return roots.some((root) => existsSync(path.join(root, ...rel.split('/'))));
  };
}

/**
 * Count the asset relations of the member's own recall indexes, mirroring
 * recall's scope selection: the project scope when a project config exists,
 * plus the inherited user scope when `inheritUserScope` is true, else the
 * user scope. Returns null when there is no member at all — standalone
 * `--output` — and lint behaves as it did before #1562.
 *
 * A missing or unreadable index means the member pulled nothing recall
 * indexes; that scope contributes no assets, never a rebuild: lint only
 * reads.
 */
export async function lintAssetGraph(opts: { dryRun?: boolean } = {}): Promise<LintAssetGraph | null> {
  const loadOpts = { dryRun: opts.dryRun ?? true };
  let projectConfig: LocalConfig | null = null;
  try {
    projectConfig = await detectProjectConfig(undefined, undefined, loadOpts);
    // A workspace searches what its children select too (#913), as recall.
    if (projectConfig) projectConfig = await readWorkspaceChildren(projectConfig);
  } catch {
    projectConfig = null;
  }

  const scopeConfigs: Array<{ config: LocalConfig; scope: 'user' | 'project' }> = [];
  if (projectConfig) {
    scopeConfigs.push({ config: projectConfig, scope: 'project' });
    if (projectConfig.inheritUserScope === true) {
      try {
        const userConfig = await loadLocalConfigForScope('user', undefined, loadOpts);
        if (userConfig) scopeConfigs.push({ config: userConfig, scope: 'user' });
      } catch {
        // The inherited user scope is unavailable; the project scope still counts.
      }
    }
  } else {
    try {
      const { localConfig } = await requireInit(loadOpts);
      scopeConfigs.push({ config: localConfig, scope: 'user' });
    } catch {
      return null;
    }
  }

  const loaded: Array<{ config: LocalConfig; scope: 'user' | 'project'; index: SearchIndex }> = [];
  for (const { config, scope } of scopeConfigs) {
    try {
      // The project index is partition-aware (per checkout in self mode);
      // without a project root a historical project config reads the user's.
      const indexPath = config.scope === 'project' && config.projectRoot
        ? getProjectSearchIndexPath(config)
        : getUserSearchIndexPath();
      const index = await loadIndex(indexPath);
      if (index) loaded.push({ config, scope, index });
    } catch {
      // An unreadable index excludes its scope, as an unavailable one does in recall.
    }
  }

  // A user-scope entry the project shadows contributes nothing, as in recall.
  const projectEntryKeys = new Set(
    loaded
      .filter((s) => s.scope === 'project')
      .flatMap((s) => s.index.entries.map((e) => `${e.type}:${e.filename}`)),
  );

  const graphs: LintScopeGraph[] = [];
  for (const { config, scope, index } of loaded) {
    try {
      const ctx = await buildRelationContext({
        index,
        config,
        hidden: scope === 'user' ? projectEntryKeys : undefined,
      });
      graphs.push({ ctx, targetExists: await scopeTargetExists(config) });
    } catch {
      // Relations are unavailable for this scope, as a failed build is in recall.
    }
  }
  return computeLintAssetGraph(graphs);
}
