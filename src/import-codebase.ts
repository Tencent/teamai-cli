import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import fs from 'fs-extra';
import { z } from 'zod';

import { extractCodebase, sourceRepositoryMetadata } from './codebase-extract.js';
import type { TeamaiInit } from './config.js';
import { log } from './utils/logger.js';
import { remotesMatch } from './utils/git.js';
import { assertSafeResourceName } from './utils/path-safety.js';
import { isOverrideInvalid } from './tool-launch/call.js';

/** The caches an incremental extraction reuses, kept with each codebase's evidence. */
const INCREMENTAL_CACHES = ['facts-cache.json', 'interfaces-cache.json'] as const;

export interface ImportCodebaseOptions {
  /** Source checkout to extract (a local dir, a clone-cache dir, or a CI checkout). */
  sourceDir: string;
  /** Evidence slug: `teamwiki/evidence/code/<slug>/`. */
  slug: string;
  /** A slug the same source was published under before; its evidence moves to `slug`. */
  legacySlug?: string;
  /** The teamwiki the evidence is published into. */
  wikiRoot: string;
  /** Re-extract only what changed since this codebase's published baseline. */
  incremental?: boolean;
  skipEnrich?: boolean;
  /** Cap on source files collected for this codebase (default 200). */
  maxFiles?: number;
  repoUrl?: string;
  branch?: string;
  /** MR/PR recorded as ingested in source-manifest.json. */
  sourceMrUrl?: string | readonly string[];
}

type EvidenceJson = Record<string, unknown>;

async function readJsonIfPresent(file: string): Promise<EvidenceJson | null> {
  try {
    return (await fs.readJson(file)) as EvidenceJson;
  } catch {
    return null;
  }
}

/** The component slugs a published or freshly extracted manifest declares. */
function componentSlugs(manifest: EvidenceJson | null): Set<string> {
  const components = manifest?.['components'];
  if (!Array.isArray(components)) return new Set();
  return new Set(components
    .map((component) => (component && typeof component === 'object'
      ? (component as Record<string, unknown>)['slug']
      : undefined))
    .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0));
}

/** The parts of `_manifest.json` a skipped-enrichment import merges; the rest passes through. */
const CodebaseManifestSchema = z.object({
  components: z.array(z.object({ slug: z.string() }).passthrough()),
  edges: z.array(z.object({ from: z.string(), to: z.string() }).passthrough()).default([]),
}).passthrough();

/**
 * `--skip-enrich` writes the static fallback manifest. Keep what AI enrichment
 * wrote for each component still in the code (its category, responsibilities,
 * and the edges between them), with the doc path and entrypoints just
 * extracted; a new component keeps its static entry.
 */
function keepEnrichedComponents(manifests: { published: unknown; staged: unknown }): Record<string, unknown> | null {
  const publishedManifest = CodebaseManifestSchema.safeParse(manifests.published);
  const stagedManifest = CodebaseManifestSchema.safeParse(manifests.staged);
  if (!publishedManifest.success || !stagedManifest.success) return null;
  const enriched = new Map(publishedManifest.data.components.map((component) => [component.slug, component]));
  const components = stagedManifest.data.components.map((component) => {
    const previous = enriched.get(component.slug);
    return previous ? { ...previous, docPath: component['docPath'], entrypoints: component['entrypoints'] } : component;
  });
  const slugs = new Set(components.map((component) => component.slug));
  return {
    ...stagedManifest.data,
    components,
    edges: publishedManifest.data.edges.filter((edge) => slugs.has(edge.from) && slugs.has(edge.to)),
  };
}

const PROVIDER_SLUG_PREFIXES = ['github__', 'gitlab__', 'tgit__'] as const;

/**
 * The source a `source-manifest.json` names: a repository, or for a checkout
 * with no remote the hashed root it was read from, and the directory in it
 * that was extracted.
 */
const CodebaseSourceSchema = z.union([
  z.object({ repoUrl: z.string().min(1), sourceSubdir: z.string().optional() })
    .transform((source) => ({ kind: 'remote' as const, ...source })),
  z.object({ localRootHash: z.string().min(1), sourceSubdir: z.string().optional() })
    .transform((source) => ({ kind: 'local' as const, ...source })),
]);
type CodebaseSource = z.infer<typeof CodebaseSourceSchema>;
type RemoteSource = Extract<CodebaseSource, { kind: 'remote' }>;

async function readCodebaseSource(evidenceDir: string): Promise<CodebaseSource | null> {
  const parsed = CodebaseSourceSchema.safeParse(await readJsonIfPresent(path.join(evidenceDir, 'source-manifest.json')));
  return parsed.success ? parsed.data : null;
}

/** Two checkouts without a remote are one source when they hashed the same root and extracted the same directory in it. */
function sameLocalSource(a: { localRootHash: string; sourceSubdir?: string }, b: { localRootHash: string; sourceSubdir?: string }): boolean {
  return a.localRootHash === b.localRootHash && (a.sourceSubdir ?? '') === (b.sourceSubdir ?? '');
}

/** Whether the published evidence of a slug came from the source being imported over it. */
type PublishedSource =
  | { kind: 'same' }
  | { kind: 'different'; published: RemoteSource; staged: CodebaseSource | null }
  | { kind: 'unknown' };

/**
 * A `--dir` checkout without a remote, or a subdirectory, is named after its
 * directory, so two such checkouts named `svc` share one evidence directory.
 *
 * The evidence came from the same source when both manifests name the same
 * repository and directory in it, and from a different one when only the
 * published manifest names a repository or the two differ. Two checkouts with
 * no remote are the same source when they hashed the same root and extracted
 * the same directory in it; otherwise nothing is known, since a checkout moved
 * to another path hashes differently. Evidence with this checkout's own hashed
 * root and directory is its own even after the checkout gained a remote.
 * Teamwikis written before the per-codebase `source-manifest.json` existed have no published identity;
 * there a provider-namespaced slug (`gitlab__group__repo`) still names the
 * remote repository, so the slug itself is the identity. A bare `--dir`
 * basename is not, and nothing is known.
 */
async function publishedSource(dirs: {
  publishedDir: string;
  stagedDir: string;
  slug: string;
  /** The checkout being imported, whose hashed root is read whether or not it has a remote. */
  sourceDir: string;
}): Promise<PublishedSource> {
  const [published, staged] = await Promise.all([readCodebaseSource(dirs.publishedDir), readCodebaseSource(dirs.stagedDir)]);
  if (published?.kind === 'local' && sameLocalSource(published, await sourceRepositoryMetadata(dirs.sourceDir))) {
    return { kind: 'same' };
  }
  if (published?.kind === 'remote') {
    const sameRepo = staged?.kind === 'remote' && remotesMatch(published.repoUrl, staged.repoUrl);
    const sameDir = published.sourceSubdir === undefined || staged?.sourceSubdir === undefined
      || published.sourceSubdir === staged.sourceSubdir;
    return sameRepo && sameDir ? { kind: 'same' } : { kind: 'different', published, staged };
  }
  if (published?.kind === 'local' && staged?.kind === 'local') return { kind: 'unknown' };
  return staged?.kind === 'remote' && PROVIDER_SLUG_PREFIXES.some((prefix) => dirs.slug.startsWith(prefix))
    ? { kind: 'same' }
    : { kind: 'unknown' };
}

function describeSource(source: RemoteSource): string {
  return source.sourceSubdir ? `${source.sourceSubdir} in ${source.repoUrl}` : source.repoUrl;
}

function differentSourceError(slug: string, source: { published: RemoteSource; staged: CodebaseSource | null }): Error {
  const evidence = `teamwiki/evidence/code/${slug}/`;
  const published = describeSource(source.published);
  return new Error(source.staged?.kind === 'remote'
    ? `${evidence} holds the evidence of ${published}, and this checkout is ${describeSource(source.staged)}. Not replacing it. `
      + `Import the checkout from a directory with another name, or remove ${evidence} if that codebase is gone.`
    : `${evidence} holds the evidence of ${published}, and this checkout has no origin remote. Not replacing it. `
      + 'If this checkout is that repository, add its origin remote back and import it again; '
      + `otherwise import it from a directory with another name, or remove ${evidence} if that codebase is gone.`);
}

/**
 * A `--dir` checkout without an origin remote is named after its directory, so
 * `/a/svc` and `/b/svc` share the slug `svc` and the second import would
 * replace the first's evidence (#1422). Decided once, before anything is
 * seeded or extracted, so the import prints the slug it publishes under.
 *
 * Such a checkout publishes where its own evidence already is (the same hashed
 * root and directory in it, see #1427), or at the slug when nothing is there.
 * Over evidence that names another source, or none, it moves to
 * `<slug>-<hash8>` of its real path, then the full digest, and never reuses a
 * suffix that holds another source's evidence. One over a remote's evidence
 * keeps the slug, and `publishedSource` decides whether the import may
 * replace it. A checkout with a remote keeps its slug, or the suffix it
 * published under before it had an origin, and is refused over the evidence
 * of another checkout without one; evidence with its own hashed root and
 * directory is its own from before it had an origin.
 */
export async function localCheckoutSlug(opts: { sourceDir: string; slug: string; wikiRoot: string }): Promise<string> {
  const { slug, wikiRoot } = opts;
  const source = await sourceRepositoryMetadata(opts.sourceDir);
  if (source.repoUrl) {
    // A subdirectory keeps its directory name once it has an origin, so a
    // suffix it was given before is still its own: found by its hashed root
    // on the first import, and by the repository it names after that.
    const { repoUrl } = source;
    const isThisSource = (codebase: CodebaseSource | null) => codebase?.kind === 'remote'
      && remotesMatch(codebase.repoUrl, repoUrl)
      && (codebase.sourceSubdir ?? '') === (source.sourceSubdir ?? '');
    const published = await readCodebaseSource(path.join(wikiRoot, 'evidence', 'code', slug));
    for (const candidate of await suffixedSlugs(opts.sourceDir, slug)) {
      const suffixed = await readCodebaseSource(path.join(wikiRoot, 'evidence', 'code', candidate));
      const isOwn = suffixed?.kind === 'local' ? sameLocalSource(suffixed, source) : isThisSource(suffixed);
      if (!isOwn) continue;
      // A release without suffixes may have imported it under its directory name since.
      if (isThisSource(published)) {
        log.warn(`teamwiki/evidence/code/${slug}/ is an older copy of teamwiki/evidence/code/${candidate}/. `
          + 'Move any curated docs you want to keep from it, then remove it.');
      }
      return candidate;
    }
    const evidence = `teamwiki/evidence/code/${slug}/`;
    if (published?.kind === 'local' && !sameLocalSource(published, source)) {
      throw new Error(`${evidence} holds the evidence of a checkout without an origin remote, and this checkout is `
        + `${describeSource({ kind: 'remote', repoUrl: source.repoUrl, sourceSubdir: source.sourceSubdir })}. Not replacing it. `
        + `If it is this checkout's from before it moved, move any curated docs you want to keep from ${evidence}, `
        + 'remove it and import again; otherwise import this checkout from a directory with another name.');
    }
    return slug;
  }

  const [occupant, ...suffixed] = await Promise.all([slug, ...await suffixedSlugs(opts.sourceDir, slug)]
    .map(async (candidate) => {
      const evidenceDir = path.join(wikiRoot, 'evidence', 'code', candidate);
      return { slug: candidate, isEmpty: !(await fs.pathExists(evidenceDir)), source: await readCodebaseSource(evidenceDir) };
    }));
  const own = [occupant, ...suffixed].find((candidate) => candidate.source?.kind === 'local'
    && sameLocalSource(candidate.source, source));
  if (own) return own.slug;
  if (occupant.isEmpty || occupant.source?.kind === 'remote') return slug;

  const free = suffixed.find((candidate) => candidate.isEmpty);
  if (!free) {
    throw new Error(`teamwiki/evidence/code/${slug}/ and both of its suffixed slugs hold evidence of other sources. `
      + 'Not replacing them. Import this checkout from a directory with another name.');
  }
  log.warn(`teamwiki/evidence/code/${slug}/ holds evidence that names another source, or no source, so this checkout, `
    + `which has no origin remote, is published under teamwiki/evidence/code/${free.slug}/. `
    + `If teamwiki/evidence/code/${slug}/ is an older copy of this checkout, move any curated docs you want to keep from it, `
    + `remove it, and change any resources.wiki entry that means this checkout from "${slug}" to "${free.slug}".`);
  return free.slug;
}

/** The slugs a checkout without an origin moves to when its directory name holds another source's evidence. */
async function suffixedSlugs(sourceDir: string, slug: string): Promise<string[]> {
  const digest = createHash('sha256').update(await fs.realpath(sourceDir)).digest('hex');
  return [`${slug}-${digest.slice(0, 8)}`, `${slug}-${digest}`];
}

/**
 * Where a checkout that gained an origin published before it had one: the
 * suffixed slug `localCheckoutSlug` gave it, else its directory name (#1422).
 */
export async function ownLegacySlug(opts: { sourceDir: string; slug: string; wikiRoot: string }): Promise<string> {
  const source = await sourceRepositoryMetadata(opts.sourceDir);
  for (const candidate of await suffixedSlugs(opts.sourceDir, opts.slug)) {
    const published = await readCodebaseSource(path.join(opts.wikiRoot, 'evidence', 'code', candidate));
    if (published?.kind === 'local' && sameLocalSource(published, source)) return candidate;
  }
  return opts.slug;
}

/**
 * Seed the staging teamwiki with the baseline this codebase was last published
 * with, so an incremental extraction compares against it. A codebase's own
 * caches live in `evidence/code/<slug>/.indices/`; a teamwiki written before
 * that keeps them only in the shared `teamwiki/.indices/`, which describe
 * whichever codebase was extracted last, so they are used only when the shared
 * manifest says it was this one. Returns whether a baseline was seeded.
 */
async function seedBaseline(wikiRoot: string, stagingWiki: string, slug: string): Promise<boolean> {
  const evidenceDir = path.join(wikiRoot, 'evidence', 'code', slug);
  const sidecar = path.join(evidenceDir, 'source-manifest.json');
  const rootManifest = path.join(wikiRoot, 'source-manifest.json');
  const ownIndices = path.join(evidenceDir, '.indices');
  const readManifest = (file: string) =>
    fs.readJson(file).catch(() => null) as Promise<{ project?: string; headSha?: string } | null>;

  let manifest: string | undefined;
  let indices: string | undefined;
  const sidecarJson = await readManifest(sidecar);
  if (sidecarJson && await fs.pathExists(path.join(ownIndices, INCREMENTAL_CACHES[0]))) {
    manifest = sidecar;
    indices = ownIndices;
  } else {
    const rootJson = await readManifest(rootManifest);
    if (rootJson?.project === slug && (!sidecarJson || sidecarJson.headSha === rootJson.headSha)) {
      manifest = rootManifest;
      indices = path.join(wikiRoot, '.indices');
    }
  }
  if (!manifest || !indices) return false;

  const stagingEvidence = path.join(stagingWiki, 'evidence', 'code', slug);
  await fs.ensureDir(stagingEvidence);
  await fs.copy(manifest, path.join(stagingWiki, 'source-manifest.json'));
  await fs.copy(manifest, path.join(stagingEvidence, 'source-manifest.json'));
  for (const cache of INCREMENTAL_CACHES) {
    const src = path.join(indices, cache);
    if (await fs.pathExists(src)) await fs.copy(src, path.join(stagingWiki, '.indices', cache));
  }
  // dependency-paths.md is not seeded: the extractor would keep it as is, and
  // its chains would still name symbols the changed files removed.
  return true;
}

/**
 * Extract a source checkout into `<wikiRoot>/evidence/code/<slug>/`, the one
 * code path every import source shares (`--dir`, `--from-repo`, `ci extract-mr`).
 *
 * Extraction runs in a temporary directory, never in the source checkout, so a
 * teamwiki already there is left alone. The published evidence, the per-repo
 * graph, the incremental caches and source-manifest.json land in the
 * codebase's evidence directory; the root source-manifest.json keeps the most
 * recent baseline for `teamai codebase --status`.
 *
 * @returns false when an incremental run found nothing changed (nothing is
 *          written), true when the evidence was published
 */
export async function importCodebase(opts: ImportCodebaseOptions): Promise<boolean> {
  const { sourceDir, slug, wikiRoot } = opts;
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-extract-'));
  try {
    const stagingWiki = path.join(staging, 'teamwiki');
    const seeded = opts.incremental ? await seedBaseline(wikiRoot, stagingWiki, slug) : false;
    if (opts.incremental && !seeded) log.debug(`[import] ${slug}: no published baseline, running a full extraction`);
    const wrote = await extractCodebase({
      path: sourceDir,
      project: slug,
      outputRoot: staging,
      json: false,
      incremental: seeded,
      skipEnrich: opts.skipEnrich,
      maxFiles: opts.maxFiles,
      repoUrl: opts.repoUrl,
      branch: opts.branch,
      sourceMrUrl: opts.sourceMrUrl,
    });
    // An up-to-date or empty source writes nothing: keep the published evidence.
    if (!wrote) return false;

    const stagingEvidence = path.join(stagingWiki, 'evidence', 'code', slug);
    const evidenceDest = path.join(wikiRoot, 'evidence', 'code', slug);

    // `--dir` named a checkout with an origin after its directory before it took
    // the remote's slug: adopt that evidence rather than leave a duplicate.
    const { legacySlug } = opts;
    const legacyDest = legacySlug && legacySlug !== slug ? path.join(wikiRoot, 'evidence', 'code', legacySlug) : null;
    if (legacySlug && legacyDest && await fs.pathExists(legacyDest)) {
      const legacy = await publishedSource({ publishedDir: legacyDest, stagedDir: stagingEvidence, slug: legacySlug, sourceDir });
      switch (legacy.kind) {
        case 'same':
          if (await fs.pathExists(evidenceDest)) {
            log.warn(`teamwiki/evidence/code/${legacySlug}/ is an older copy of teamwiki/evidence/code/${slug}/. `
              + 'Move any curated docs you want to keep from it, then remove it.');
          } else {
            await fs.move(legacyDest, evidenceDest);
            log.info(`Moved teamwiki/evidence/code/${legacySlug}/ to teamwiki/evidence/code/${slug}/`);
          }
          break;
        case 'unknown':
          // Evidence older than its source manifest, or another checkout's
          // without an origin, cannot be shown to be this repo's, so it is not moved.
          log.warn(`teamwiki/evidence/code/${legacySlug}/ names no repository, so it was left in place. `
            + `If it is an older copy of teamwiki/evidence/code/${slug}/, move any curated docs you want to keep from it, then remove it.`);
          break;
        case 'different':
          // Another repository's evidence keeps its own name.
          break;
        default: {
          const unhandled: never = legacy;
          throw new Error(`Unhandled published source: ${JSON.stringify(unhandled)}`);
        }
      }
    }

    const [publishedManifest, stagedManifest] = await Promise.all([
      readJsonIfPresent(path.join(evidenceDest, '_manifest.json')),
      readJsonIfPresent(path.join(stagingEvidence, '_manifest.json')),
    ]);
    const publishedComponents = componentSlugs(publishedManifest);
    const currentComponents = componentSlugs(stagedManifest);
    const removedComponents = new Set([...publishedComponents].filter((component) => !currentComponents.has(component)));
    const stagedDocs = new Set(
      await fs.readdir(path.join(stagingEvidence, 'docs')).catch(() => [] as string[]),
    );
    const stagedDomains = await fs.pathExists(path.join(stagingEvidence, '_domains.json'));
    // A missing manifest is the only case where nothing can be pruned.
    const hasManifest = Boolean(stagedManifest);

    const source = await publishedSource({ publishedDir: evidenceDest, stagedDir: stagingEvidence, slug, sourceDir });
    switch (source.kind) {
      case 'different':
        throw differentSourceError(slug, source);
      case 'same':
      case 'unknown':
        break;
      default: {
        const unhandled: never = source;
        throw new Error(`Unhandled published source: ${JSON.stringify(unhandled)}`);
      }
    }
    if (source.kind === 'same') {
      // Carry over the artifacts that only AI enrichment and deep enrich write.
      // Extraction never regenerates them, so replacing the published evidence
      // would silently drop curated docs and domain metadata. Existing staged
      // files win: a fresh extraction or a new AI classification is newer than
      // what the teamwiki holds. `_review/` is deliberately not carried over: it
      // records which components deep enrich already documented, and a repo that
      // changed must regenerate those docs instead of skipping them.
      for (const artifact of ['docs', '_domains.json']) {
        const published = path.join(evidenceDest, artifact);
        if (!(await fs.pathExists(published))) continue;
        await fs.copy(published, path.join(stagingEvidence, artifact), { overwrite: false, errorOnExist: false });
      }
      const enrichedManifest = opts.skipEnrich ? keepEnrichedComponents({ published: publishedManifest, staged: stagedManifest }) : null;
      if (enrichedManifest) {
        await fs.writeJson(path.join(stagingEvidence, '_manifest.json'), enrichedManifest, { spaces: 2 });
      }

      const stagedDocsDir = path.join(stagingEvidence, 'docs');
      if (await fs.pathExists(stagedDocsDir)) {
        // Deep enrich's graph pages describe the previous extraction; never
        // carry them forward. The freshly extracted graph replaces them, and
        // the generated README routes to the new pages.
        for (const entry of await fs.readdir(stagedDocsDir)) {
          if (stagedDocs.has(entry)) continue;
          if (entry === 'README.md' || /^graph-g\d+-/.test(entry)) {
            await fs.remove(path.join(stagedDocsDir, entry));
          }
        }
        // A component that disappeared from the new manifest must not keep a doc.
        if (hasManifest) {
          for (const component of removedComponents) {
            try {
              assertSafeResourceName(component);
            } catch {
              continue;
            }
            await fs.remove(path.join(stagedDocsDir, `${component}.md`));
          }
        }
      }

      // Keep the carried domain metadata in step with the new manifest: drop
      // removed components and the keywords that named them.
      if (hasManifest && !stagedDomains) {
        const domainsPath = path.join(stagingEvidence, '_domains.json');
        const domains = await readJsonIfPresent(domainsPath);
        if (domains) {
          if (Array.isArray(domains['components']) && stagedManifest) {
            domains['components'] = domains['components']
              .filter((component): component is string => typeof component === 'string' && currentComponents.has(component));
          }
          if (Array.isArray(domains['keywords']) && removedComponents.size > 0) {
            domains['keywords'] = domains['keywords']
              .filter((keyword) => typeof keyword !== 'string' || !removedComponents.has(keyword));
          }
          await fs.writeJson(domainsPath, domains, { spaces: 2 });
        }
      }
    }

    // Replace the old pages so a removed module's page does not linger.
    if (await fs.pathExists(evidenceDest)) {
      for (const entry of await fs.readdir(evidenceDest)) {
        if (entry !== '.indices') await fs.remove(path.join(evidenceDest, entry));
      }
    }
    await fs.ensureDir(evidenceDest);
    await fs.copy(stagingEvidence, evidenceDest, { overwrite: true });

    const destIndices = path.join(evidenceDest, '.indices');
    await fs.ensureDir(destIndices);
    for (const file of ['graph-index.json', ...INCREMENTAL_CACHES]) {
      const src = path.join(stagingWiki, '.indices', file);
      if (await fs.pathExists(src)) await fs.copy(src, path.join(destIndices, file), { overwrite: true });
    }
    const stagingManifest = path.join(stagingWiki, 'source-manifest.json');
    if (await fs.pathExists(stagingManifest)) {
      await fs.copy(stagingManifest, path.join(wikiRoot, 'source-manifest.json'), { overwrite: true });
    }
    return true;
  } finally {
    await fs.remove(staging).catch(() => {});
  }
}

/**
 * Reconcile product docs with code knowledge, then deep-enrich the codebase.
 * Both are non-blocking; deep enrich runs only when `_manifest.json` exists.
 */
export async function reconcileAndDeepEnrich(params: {
  slug: string;
  wikiRoot: string;
  sourceDir: string;
  skipEnrich: boolean;
}): Promise<void> {
  const { slug, wikiRoot, sourceDir, skipEnrich } = params;
  try {
    const { reconcileKnowledge } = await import('./wiki-engine/adapters/index.js');
    const result = await reconcileKnowledge({ wikiRoot, dryRun: false });
    if (result.mappings > 0 || result.gaps.length > 0) {
      log.info(`  reconcile: ${result.mappings} mappings, ${result.gaps.length} gaps, ${result.graphEdges.length} MAPS_TO edges`);
    }
  } catch (err) {
    log.debug(`reconcile skipped: ${(err as Error).message}`);
  }

  const evidenceDir = path.join(wikiRoot, 'evidence', 'code', slug);
  if (skipEnrich || !(await fs.pathExists(path.join(evidenceDir, '_manifest.json')))) return;
  try {
    const { deepEnrich } = await import('./deep-enrich.js');
    await deepEnrich({ project: slug, evidenceDir, wikiRoot, cacheDir: sourceDir });
    log.info(`Deep enrich complete: ${slug}`);
  } catch (err) {
    if (isOverrideInvalid(err)) throw err;
    log.debug(`deep-enrich failed for ${slug} (non-blocking): ${(err as Error).message}`);
  }
}

/** Rebuild the global graph and router.md / index.md after evidence changed. */
export async function refreshTeamwikiIndexes(wikiRoot: string): Promise<void> {
  try {
    const { aggregateGlobalGraph } = await import('./graph-aggregate.js');
    await aggregateGlobalGraph(wikiRoot);
  } catch (e) {
    log.warn(`[graph] global aggregation failed (non-blocking): ${(e as Error).message}`);
  }
  try {
    const { rebuildWikiIndex } = await import('./rebuild-wiki-index.js');
    await rebuildWikiIndex(wikiRoot);
  } catch (e) {
    log.warn(`[wiki] global index rebuild failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Push the team repo's teamwiki changes on a branch and open an MR/PR. */
export async function publishTeamwikiViaMR(team: TeamaiInit, message: string): Promise<void> {
  const { localConfig: lc, teamConfig: tc } = team;
  const { autoPushViaMR } = await import('./utils/git.js');
  const prUrl = await autoPushViaMR(
    lc.repo.localPath,
    message,
    ['.'],
    { repo: tc.repo, provider: tc.provider, reviewers: tc.reviewers },
    { repo: lc.repo, username: lc.username, provider: lc.provider },
  );
  if (prUrl) log.success(`MR created: ${prUrl}`);
  else log.success(`Branch pushed to team knowledge repo (${lc.repo.remote})`);
}

/**
 * `teamai import --dir`, and the teamwiki update of `teamai ci extract-mr`:
 * import a checkout, reconcile and deep-enrich it, and refresh the indexes.
 *
 * @returns whether the teamwiki changed
 */
export async function importLocalCheckout(opts: ImportCodebaseOptions): Promise<boolean> {
  const updated = await importCodebase(opts);
  if (!updated) {
    log.info(`${opts.slug}: no source changes since the last import, teamwiki unchanged`);
    return false;
  }
  log.info(`teamwiki/ knowledge graph updated: ${opts.slug}`);
  await reconcileAndDeepEnrich({
    slug: opts.slug, wikiRoot: opts.wikiRoot, sourceDir: opts.sourceDir, skipEnrich: opts.skipEnrich ?? false,
  });
  await refreshTeamwikiIndexes(opts.wikiRoot);
  return true;
}
