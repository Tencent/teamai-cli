import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { extractCodebase } from './codebase-extract.js';
import type { TeamaiInit } from './config.js';
import { log } from './utils/logger.js';
import { repoIdentity } from './utils/git.js';
import { assertSafeResourceName } from './utils/path-safety.js';

/** The caches an incremental extraction reuses, kept with each codebase's evidence. */
const INCREMENTAL_CACHES = ['facts-cache.json', 'interfaces-cache.json'] as const;

export interface ImportCodebaseOptions {
  /** Source checkout to extract (a local dir, a clone-cache dir, or a CI checkout). */
  sourceDir: string;
  /** Evidence slug: `teamwiki/evidence/code/<slug>/`. */
  slug: string;
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

const PROVIDER_SLUG_PREFIXES = ['github__', 'gitlab__', 'tgit__'] as const;

/**
 * `--dir` imports derive the slug from the directory basename, so two checkouts
 * named `svc` share one evidence directory. Carrying curated artifacts across
 * such an import would attach the first repo's docs and domain to the second.
 *
 * Keep them only when the two manifests name the same repository and the same
 * directory in it. A checkout with a remote names it by `repoUrl`. One with no
 * remote has no canonical identity (#1422), so the hashed git root it was read
 * from is the only stable statement of "this source": the same checkout carries
 * its docs over, while a different checkout with the same basename does not.
 * The directory matters as much as the root there — two subdirectories of one
 * origin-less repo hash to the same root and are still two codebases.
 * Teamwikis written before the per-codebase `source-manifest.json` existed have
 * no published identity; there a provider-namespaced slug
 * (`gitlab__group__repo`) still names the remote repository, so the slug itself
 * is the identity. A bare `--dir` basename is not, and replaces the evidence
 * like base.
 */
async function sameRepository(publishedDir: string, stagedDir: string, slug: string): Promise<boolean> {
  const [published, staged] = await Promise.all([
    readJsonIfPresent(path.join(publishedDir, 'source-manifest.json')),
    readJsonIfPresent(path.join(stagedDir, 'source-manifest.json')),
  ]);
  const publishedUrl = typeof published?.['repoUrl'] === 'string' ? published['repoUrl'] : '';
  const stagedUrl = typeof staged?.['repoUrl'] === 'string' ? staged['repoUrl'] : '';
  if (publishedUrl && stagedUrl) return repoIdentity(publishedUrl) === repoIdentity(stagedUrl);
  if (publishedUrl || stagedUrl) {
    return !publishedUrl
      && PROVIDER_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix));
  }
  // Neither side names a remote. Two origin-less runs are the same source only
  // when both recorded the same verified git root *and* the same directory in
  // it: `service-a/svc` and `service-b/svc` of one repo share one git root but
  // are different codebases, so the root alone would carry docs across them.
  // A manifest written before `localRootHash` existed is not evidence of the
  // same source.
  const publishedRoot = typeof published?.['localRootHash'] === 'string' ? published['localRootHash'] : '';
  const stagedRoot = typeof staged?.['localRootHash'] === 'string' ? staged['localRootHash'] : '';
  if (publishedRoot === '' || publishedRoot !== stagedRoot) return false;
  const publishedSubdir = typeof published?.['sourceSubdir'] === 'string' ? published['sourceSubdir'] : '';
  const stagedSubdir = typeof staged?.['sourceSubdir'] === 'string' ? staged['sourceSubdir'] : '';
  return publishedSubdir === stagedSubdir;
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

    if (await sameRepository(evidenceDest, stagingEvidence, slug)) {
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
