/**
 * Read-only health checks for a branch `teamai push` created
 * (`teamai/push/<user>/<timestamp>`), surfaced as `teamai review --branch <name>`.
 *
 * Why this exists (#776): when the Git host cannot open a PR/MR (a plain
 * `ssh://` remote, for instance), `teamai push` still lands new resources on a
 * push branch, but nothing tells the human who merges by hand whether those
 * resources are usable. This command answers that, per branch, with three
 * levels: `fail` (must fix), `warn` (needs a human decision), `info` (context).
 *
 * It is strictly read-only: the branch tree is read out of git's object store
 * (`git ls-tree` / `git show`) into a temporary directory and never checked out
 * into the team repo, and nothing is written back.
 *
 * The checks reuse the code paths pull already trusts — the same resource
 * scanners (`scanTeamForPull`), the same manifest loaders, the same
 * `NAMESPACE_AXIS` mapping, the same agent parser and the same secret
 * scrubber — so a branch this command calls clean is one pull reads the same
 * way. Workflow files reuse `syncWorkflowDefinitions` with dry-run and an
 * empty data home, and that check does not update this machine's workflow
 * cache. It deliberately does not re-implement any of that.
 */
import os from 'node:os';
import path from 'node:path';

import chalk from 'chalk';
import fse from 'fs-extra';

import { resolveConfigForDir } from './config.js';
import { caseFoldKey, isSafeNamespaceSegment, NAMESPACE_RULE } from './manifest-schema.js';
import { ALL_PROJECT_RESOURCE_TYPES, loadProjectsManifest, type AllProjectResourceType, type ProjectsManifest } from './projects.js';
import {
  isNestedPlaceableType, NAMESPACE_AXIS, PLACEABLE_TYPES, rootSegmentsFor, type PlaceableType,
} from './push-namespaces.js';
import { parseAgentYaml } from './resources/agent-format.js';
import { hooksEntryReader } from './resources/hooks.js';
import { getHandler } from './resources/index.js';
import { listRepoFilesRecursive } from './resources/repo-resource.js';
import { loadRolesManifestIfPresent, type RolesManifest } from './roles.js';
import { LocalConfigSchema, type GlobalOptions, type LocalConfig, type ResourceItem, type TeamaiConfig } from './types.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import { listFilesRecursive, pathExists, readFileIfExists, writeFile, ensureDir } from './utils/fs.js';
import { getFileContentAtRev, getHeadCommit, listTreeAtRev } from './utils/git.js';
import { isSilent, log, setSilent } from './utils/logger.js';
import { redact } from './utils/redact.js';
import { syncWorkflowDefinitions } from './workflow/cache.js';
import { formatDiagnostic } from './workflow/parse.js';

// ─── Findings ────────────────────────────────────────────────────────────────

/** How bad a finding is: `fail` blocks a merge, `warn` needs a human, `info` is context. */
export type FindingLevel = 'fail' | 'warn' | 'info';

/** Which group of checks produced a finding. */
export type FindingCheck = 'structure' | 'naming' | 'duplicates' | 'format' | 'leaks' | 'workflows';

/** One thing worth reporting about the branch. */
export interface Finding {
  level: FindingLevel;
  check: FindingCheck;
  /** One English sentence naming what is wrong and, where useful, how to fix it. */
  message: string;
  /** Repo-relative path of the resource the finding is about. */
  path?: string;
}

/** The whole result for one branch, as `--json` prints it. */
export interface BranchReview {
  branch: string;
  /** False when any `fail` finding exists. */
  ok: boolean;
  counts: Record<FindingLevel, number>;
  findings: Finding[];
}

const AXES: readonly AllProjectResourceType[] = ALL_PROJECT_RESOURCE_TYPES;

// ─── Resource model ──────────────────────────────────────────────────────────

/** A resource on the branch, with its name/namespace read from its repo path. */
interface ReviewResource {
  type: PlaceableType;
  name: string;
  namespace?: string;
  /** Repo-relative path of the resource (a directory for skills, a file otherwise). */
  relativePath: string;
  /** Absolute path in the materialized tree: the skill directory, or the file. */
  absolutePath: string;
}

/** Strip a resource file extension from the last path segment. */
function stripExtension(segment: string): string {
  return segment.replace(/\.(md|markdown|yaml|yml|toml|json)$/i, '');
}

/**
 * Name and namespace from a repo-relative resource path, the same way pull reads
 * them (`<root>/<ns>/<name>` is namespaced, `<root>/<name>` is shared). The
 * handlers' own `name` is not used: for rules it carries the namespace segment.
 */
function parseRelativePath(
  type: PlaceableType,
  relativePath: string,
  index: ManifestIndex,
): { name: string; namespace?: string } {
  const rootSegs = rootSegmentsFor(type);
  const all = relativePath.split('/');
  const rest = all.slice(rootSegs);
  if (rest.length <= 1) {
    const only = rest[0] ?? '';
    return { name: isNestedPlaceableType(type) ? only : stripExtension(only) };
  }
  const namespace = rest[0];
  // Nested types keep the whole bundle-relative sub-path as the identity, never
  // the bare basename: co-active docs/a/api/guide.md and docs/b/ui/guide.md are
  // two resources, not a duplicate "guide", and the extension stays because
  // docs/a/api/guide.md and docs/b/api/guide.png are distinct files. The name
  // may contain '/', which namingFindings validates one segment at a time.
  if (isNestedPlaceableType(type)) {
    if (index.declares(NAMESPACE_AXIS[type], namespace!)) {
      return { name: rest.slice(1).join('/'), namespace };
    }
    return { name: rest.join('/') };
  }
  // A first segment under the other roots is a namespace by construction
  // (`skills/<ns>/<name>`), so the name is the basename below it.
  return { name: stripExtension(rest[rest.length - 1] ?? ''), namespace };
}

/** Enumerate the resources on the branch through the same scanners pull uses. */
async function scanResources(repoDir: string, index: ManifestIndex): Promise<ReviewResource[]> {
  const localConfig = { repo: { localPath: repoDir } } as LocalConfig;
  const teamConfig = {} as TeamaiConfig;
  const handlerTypes = ['skills', 'rules', 'agents', 'mcp'] as const;
  const items: Array<{ type: PlaceableType; item: ResourceItem }> = [];
  for (const type of handlerTypes) {
    items.push(...(await getHandler(type).scanTeamForPull(teamConfig, localConfig))
      .map((item) => ({ type, item })));
  }
  for (const type of PLACEABLE_TYPES) {
    if ((handlerTypes as readonly PlaceableType[]).includes(type)) continue;
    const rootRel = repoRootFor(type);
    const root = path.join(repoDir, ...rootRel.split('/'));
    for (const file of await listRepoFilesRecursive(root)) {
      if (type === 'workflows' && !file.endsWith('.yaml')) continue;
      if (type === 'hooks') {
        // Hooks are reviewed by entry, the same identity pull's hooks reader
        // delivers by: hooks/a/hooks.yaml and hooks/b/hooks.yaml are two files
        // that may define disjoint ids, so the file name is not the identity.
        const absolutePath = path.join(root, ...file.split('/'));
        const relativePath = `${rootRel}/${file}`;
        const segments = file.split('/');
        const namespace = segments.length > 1 ? segments[0] : undefined;
        const fileEntry = (name: string) => ({
          type,
          item: { type, name, namespace, sourcePath: absolutePath, relativePath },
        });
        if (path.posix.basename(file) === 'hooks.yaml') {
          const read = await hooksEntryReader.read(absolutePath, relativePath);
          if (read !== null && read.ok && read.entries.length > 0) {
            for (const hook of read.entries) {
              items.push(fileEntry(hook.id));
            }
            continue;
          }
        }
        // Unreadable, entry-free, or non-canonical files keep a file identity,
        // so the naming and leak checks still see them.
        items.push(fileEntry(stripExtension(segments[segments.length - 1] ?? '')));
        continue;
      }
      items.push({
        type,
        item: {
          type,
          name: file,
          sourcePath: path.join(root, ...file.split('/')),
          relativePath: `${rootRel}/${file}`,
        },
      });
    }
  }
  return items.map(({ type, item }) => {
    // Handler-provided names (MCP server names, skill names) are authoritative;
    // parseRelativePath would overwrite them with the filename stem (e.g. 'mcp'
    // from mcp/<ns>/mcp.yaml), collapsing distinct servers into one identity.
    // Rules are an exception: the handler's name carries the namespace prefix
    // (e.g. 'ops/foo' for rules/ops/foo.md), so we parse name/namespace from
    // the path instead. Hook entry ids are authoritative too — they are what
    // pull delivers by (the scan above already set them with the namespace).
    if (((handlerTypes as readonly PlaceableType[]).includes(type) && type !== 'rules') || type === 'hooks') {
      return {
        type,
        name: item.name,
        namespace: item.namespace,
        relativePath: item.relativePath,
        absolutePath: item.sourcePath,
      };
    }
    const { name, namespace } = parseRelativePath(type, item.relativePath, index);
    return { type, name, namespace, relativePath: item.relativePath, absolutePath: item.sourcePath };
  });
}

/**
 * The repo-relative directory a resource type lives under. It is the type name
 * everywhere except wiki, whose authoritative root is `teamwiki/evidence/code`
 * (three segments, as `rootSegmentsFor` counts), not `wiki/`.
 */
function repoRootFor(type: PlaceableType): string {
  return type === 'wiki' ? 'teamwiki/evidence/code' : type;
}

// ─── Manifest index ──────────────────────────────────────────────────────────

/** The namespace lists a branch's roles and projects declare, per axis. */
interface ManifestIndex {
  /** True when any role or project declares `namespace` on `axis`. */
  declares(axis: AllProjectResourceType, namespace: string): boolean;
  /** True when any single role or project declares both namespaces on `axis`. */
  coActive(axis: AllProjectResourceType, a: string, b: string): boolean;
  /** True when any role or project declares any namespace on `axis`. */
  anyOn(axis: AllProjectResourceType): boolean;
  /** True when no manifest exists at all — every on-disk namespace is valid. */
  manifestFree: boolean;
}

function buildManifestIndex(roles: RolesManifest | null, projects: ProjectsManifest | null): ManifestIndex {
  const listsByAxis = new Map<AllProjectResourceType, string[][]>();
  for (const axis of AXES) listsByAxis.set(axis, []);

  const collect = (resources: Record<string, unknown> | undefined): void => {
    if (!resources) return;
    for (const axis of AXES) {
      const list = resources[axis];
      if (Array.isArray(list) && list.length > 0) {
        listsByAxis.get(axis)!.push(list as string[]);
      }
    }
  };
  for (const role of roles?.roles ?? []) collect(role.resources);
  for (const project of projects?.projects ?? []) collect(project.resources);

  const fold = (list: string[]): Set<string> => new Set(list.map(caseFoldKey));
  return {
    declares: (axis, namespace) => {
      const key = caseFoldKey(namespace);
      return listsByAxis.get(axis)!.some((list) => fold(list).has(key));
    },
    coActive: (axis, a, b) => {
      const ka = caseFoldKey(a);
      const kb = caseFoldKey(b);
      return listsByAxis.get(axis)!.some((list) => {
        const folded = fold(list);
        return folded.has(ka) && folded.has(kb);
      });
    },
    anyOn: (axis) => listsByAxis.get(axis)!.length > 0,
    manifestFree: !roles && !projects,
  };
}

// ─── Leak patterns ───────────────────────────────────────────────────────────

/**
 * Addresses that should not ride along in a shared resource: RFC 1918 ranges
 * and internal-only TLDs. `redact` covers credential *shapes*; this covers the
 * other half of the reporter's `leaks` check.
 */
const INTERNAL_ADDRESS =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|corp|lan)\b/gi;

/** The labels `redact` writes for the secret shapes it found. */
function redactedLabels(redactedText: string): string[] {
  return [...new Set([...redactedText.matchAll(/<REDACTED:([a-z_]+)>/g)].map((match) => match[1]!))];
}

// ─── The checks ──────────────────────────────────────────────────────────────

/** Read a text file once, memoized; null when absent or unreadable. */
function makeTextReader(): (absolutePath: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (absolutePath) => {
    let hit = cache.get(absolutePath);
    if (!hit) {
      hit = readFileIfExists(absolutePath).catch(() => null);
      cache.set(absolutePath, hit);
    }
    return hit;
  };
}

async function structureFindings(resources: ReviewResource[], index: ManifestIndex): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const resource of resources) {
    if (resource.type === 'skills' && !await pathExists(path.join(resource.absolutePath, 'SKILL.md'))) {
      findings.push({
        level: 'fail',
        check: 'structure',
        path: resource.relativePath,
        message: `${resource.relativePath}/ has no SKILL.md directly inside it; a skill must be skills/<namespace>/<name>/SKILL.md.`,
      });
    }
    if (resource.namespace) {
      const axis = NAMESPACE_AXIS[resource.type];
      // A manifest-free team has no declarations to check against — every
      // on-disk namespace is a valid pull source.
      if (!index.manifestFree && !index.declares(axis, resource.namespace)) {
        findings.push({
          level: 'fail',
          check: 'structure',
          path: resource.relativePath,
          message: `${resource.relativePath} sits in namespace "${resource.namespace}", which no role or project declares `
            + `under resources.${axis}, so it reaches nobody. Add the namespace to manifest/roles.yaml or manifest/projects.yaml, `
            + 'or move the resource.',
        });
      }
    } else if (index.anyOn(NAMESPACE_AXIS[resource.type])) {
      findings.push({
        level: 'info',
        check: 'structure',
        path: resource.relativePath,
        message: `${resource.relativePath} sits at the shared root, so it is delivered to every member.`,
      });
    }
  }
  return findings;
}

async function namingFindings(resources: ReviewResource[], readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const resource of resources) {
    if (resource.namespace && !isSafeNamespaceSegment(resource.namespace)) {
      findings.push({
        level: 'fail',
        check: 'naming',
        path: resource.relativePath,
        message: `Namespace "${resource.namespace}" in ${resource.relativePath} is not a usable path segment: ${NAMESPACE_RULE}.`,
      });
    }
    // A name may be a multi-segment sub-path (docs and wiki keep their
    // bundle-relative path below the root or namespace, e.g. 'api/guide'), so
    // each segment is validated on its own rather than the joined string.
    const badSegment = resource.name.split('/').find((segment) => !isSafeNamespaceSegment(segment));
    if (badSegment !== undefined) {
      findings.push({
        level: 'fail',
        check: 'naming',
        path: resource.relativePath,
        message: `Resource name "${resource.name}" in ${resource.relativePath} has a segment ("${badSegment}") that is not usable: ${NAMESPACE_RULE}.`,
      });
    }
    const declaredName = await frontmatterName(resource, readText);
    if (declaredName !== null && declaredName !== resource.name) {
      findings.push({
        level: 'fail',
        check: 'naming',
        path: resource.relativePath,
        message: `${resource.relativePath} declares the name "${declaredName}" but its directory/file is "${resource.name}"; make them match.`,
      });
    }
  }
  return findings;
}

/** The `name` a resource declares in its frontmatter/YAML, or null when it declares none. */
async function frontmatterName(resource: ReviewResource, readText: (p: string) => Promise<string | null>): Promise<string | null> {
  if (resource.type === 'skills') {
    const content = await readText(path.join(resource.absolutePath, 'SKILL.md'));
    if (content === null) return null;
    const name = splitFrontmatter(content).data['name'];
    return typeof name === 'string' && name.trim() !== '' ? name : null;
  }
  if (resource.type === 'agents') {
    const content = await readText(resource.absolutePath);
    if (content === null) return null;
    if (/\.(yaml|yml)$/i.test(resource.absolutePath)) {
      const parsed = parseAgentYaml(content, path.basename(resource.relativePath));
      return parsed.ok ? parsed.spec.name : null;
    }
    const name = splitFrontmatter(content).data['name'];
    return typeof name === 'string' && name.trim() !== '' ? name : null;
  }
  return null;
}

async function formatFindings(resources: ReviewResource[], readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const resource of resources) {
    if (resource.type === 'skills') {
      const content = await readText(path.join(resource.absolutePath, 'SKILL.md'));
      if (content === null) continue;
      const { data, valid, raw } = splitFrontmatter(content);
      if (raw === '') {
        findings.push({
          level: 'fail',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has no YAML frontmatter; pull relies on it for the skill's name and description.`,
        });
        continue;
      }
      if (!valid) {
        findings.push({
          level: 'warn',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has a frontmatter block that does not parse as a YAML mapping.`,
        });
      }
      const description = data['description'];
      if (typeof description !== 'string' || description.trim() === '') {
        findings.push({
          level: 'warn',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has no frontmatter "description"; say when the skill should be used.`,
        });
      } else if (description.trim().length < 15) {
        findings.push({
          level: 'warn',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has a "description" too short to explain when to use the skill.`,
        });
      }
    }
    if (resource.type === 'agents' && /\.(yaml|yml)$/i.test(resource.absolutePath)) {
      const content = await readText(resource.absolutePath);
      if (content === null) continue;
      const parsed = parseAgentYaml(content, path.basename(resource.relativePath));
      if (!parsed.ok) {
        findings.push({ level: 'fail', check: 'format', path: resource.relativePath, message: parsed.reason });
      }
    }
  }
  return findings;
}

function duplicateFindings(resources: ReviewResource[], index: ManifestIndex): Finding[] {
  const byTypeAndName = new Map<string, ReviewResource[]>();
  for (const resource of resources) {
    if (!resource.namespace) continue;
    const key = `${resource.type}\0${caseFoldKey(resource.name)}`;
    byKey(byTypeAndName, key).push(resource);
  }

  const findings: Finding[] = [];
  for (const group of byTypeAndName.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.namespace === b.namespace) continue;
        const axis = NAMESPACE_AXIS[a.type];
        if (!index.coActive(axis, a.namespace!, b.namespace!)) continue;
        findings.push({
          level: 'fail',
          check: 'duplicates',
          path: b.relativePath,
          message: `"${a.name}" is defined in both ${a.relativePath} and ${b.relativePath}, and their namespaces can be active `
            + 'together, so pull cannot decide which one a member receives. Rename or remove one of them.',
        });
      }
    }
  }
  return findings;
}

function byKey<K, V>(map: Map<K, V[]>, key: K): V[] {
  const existing = map.get(key);
  if (existing) return existing;
  const created: V[] = [];
  map.set(key, created);
  return created;
}

const MAX_SCANNED_FILE_BYTES = 512 * 1024;

async function leakFindings(resources: ReviewResource[], readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const findings: Finding[] = [];
  // Several resources can share one file (every hook entry in a hooks.yaml is
  // its own resource); its contents are checked once, not once per entry.
  const seenFiles = new Set<string>();
  for (const resource of resources) {
    const files = resource.type === 'skills'
      ? (await listFilesRecursive(resource.absolutePath)).map((rel) => ({
        relativePath: `${resource.relativePath}/${rel}`,
        absolutePath: path.join(resource.absolutePath, ...rel.split('/')),
      }))
      : [{ relativePath: resource.relativePath, absolutePath: resource.absolutePath }];

    for (const file of files) {
      if (seenFiles.has(file.absolutePath)) continue;
      seenFiles.add(file.absolutePath);
      const content = await readText(file.absolutePath);
      if (content === null || content.length > MAX_SCANNED_FILE_BYTES || content.includes('\0')) continue;

      const redacted = redact(content);
      if (redacted !== content) {
        const labels = redactedLabels(redacted);
        findings.push({
          level: 'fail',
          check: 'leaks',
          path: file.relativePath,
          message: `${file.relativePath} looks like it carries a credential (${labels.join(', ') || 'redacted'}); `
            + 'remove it before this branch is merged.',
        });
      }

      const addresses = [...new Set([...content.matchAll(INTERNAL_ADDRESS)].map((match) => match[0]))];
      if (addresses.length > 0) {
        findings.push({
          level: 'fail',
          check: 'leaks',
          path: file.relativePath,
          message: `${file.relativePath} contains an internal address (${addresses.join(', ')}); confirm it is safe to share before merging.`,
        });
      }
    }
  }
  return findings;
}

/**
 * Config for checking the materialized branch. `kind` stays omitted, so this
 * is not self mode, and `dataHome` is an empty directory rather than this
 * machine's workflow cache.
 */
function reviewTreeConfig(repoDir: string, dataHome: string): LocalConfig {
  const parsed = LocalConfigSchema.parse({
    repo: { localPath: repoDir, remote: 'local' },
    username: 'review',
  });
  return { ...parsed, dataHome };
}

/** Invalid workflow files. Dry-run, so the call does not write a cache. */
async function workflowFindings(repoDir: string): Promise<Finding[]> {
  const dataHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-workflows-'));
  const wasSilent = isSilent();
  setSilent(true);
  try {
    // Note: When #1085 adds scorers/, their validation diagnostics will join here.
    const result = await syncWorkflowDefinitions(reviewTreeConfig(repoDir, dataHome), {
      dryRun: true,
      scopeLabel: 'review',
    });
    return result.invalid.map((diagnostic) => ({
      level: 'fail',
      check: 'workflows',
      path: diagnostic.file,
      message: formatDiagnostic(diagnostic),
    }));
  } finally {
    setSilent(wasSilent);
    await fse.remove(dataHome);
  }
}

// ─── Engine ──────────────────────────────────────────────────────────────────

/** Every check, in the order the reporter listed them. */
export async function reviewBranchDir(branch: string, repoDir: string): Promise<BranchReview> {
  const [roles, projects] = await Promise.all([
    loadRolesManifestIfPresent(repoDir),
    loadProjectsManifest(repoDir),
  ]);
  const index = buildManifestIndex(roles, projects);
  const resources = await scanResources(repoDir, index);
  const readText = makeTextReader();

  const findings: Finding[] = [
    ...await structureFindings(resources, index),
    ...await namingFindings(resources, readText),
    ...await duplicateFindings(resources, index),
    ...await formatFindings(resources, readText),
    ...await leakFindings(resources, readText),
    ...await workflowFindings(repoDir),
  ];

  const counts: Record<FindingLevel, number> = { fail: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.level]++;

  return { branch, ok: counts.fail === 0, counts, findings };
}

// ─── Read-only branch reader ─────────────────────────────────────────────────

/**
 * The repo roots read out of the branch; everything else is irrelevant here.
 * Wiki is read from its authoritative root `teamwiki/evidence/code`, matching
 * where the resource handler and pull actually read it — reading `wiki/` would
 * let everything under the real root bypass review.
 */
const READ_ROOTS = [...PLACEABLE_TYPES.map(repoRootFor), 'manifest'];

/**
 * The ref to read `branch` from: the name itself when it resolves locally, else
 * its remote-tracking form. Null when neither exists. Read-only — this never
 * fetches.
 */
export async function resolveBranchRef(repoPath: string, branch: string): Promise<string | null> {
  if (await getHeadCommit(repoPath, branch)) return branch;
  if (await getHeadCommit(repoPath, `origin/${branch}`)) return `origin/${branch}`;
  return null;
}

/**
 * Copy the branch's resource roots out of git's object store into `destDir`.
 * Nothing is checked out into the team repo, so this leaves it untouched.
 */
export async function materializeRef(repoPath: string, ref: string, destDir: string): Promise<number> {
  let written = 0;
  for (const root of READ_ROOTS) {
    for (const entry of await listTreeAtRev(repoPath, ref, root)) {
      const content = await getFileContentAtRev(repoPath, ref, entry.path);
      if (content === null) continue;
      const dest = path.join(destDir, ...entry.path.split('/'));
      await ensureDir(path.dirname(dest));
      if (entry.mode === '120000') {
        const target = content.toString('utf8');
        await fse.symlink(target, dest);
      } else {
        await writeFile(dest, content);
      }
      written++;
    }
  }
  return written;
}

// ─── Command ─────────────────────────────────────────────────────────────────

export interface ReviewBranchOptions extends GlobalOptions {
  branch: string;
  json?: boolean;
}

const LEVEL_COLOR: Record<FindingLevel, (text: string) => string> = {
  fail: chalk.red,
  warn: chalk.yellow,
  info: chalk.dim,
};

const LEVEL_GLYPH: Record<FindingLevel, string> = { fail: '✖', warn: '!', info: 'i' };

function renderReview(review: BranchReview): void {
  const { counts } = review;
  console.log(chalk.bold(`[review] branch ${review.branch}: ${counts.fail} fail, ${counts.warn} warn, ${counts.info} info`));
  if (review.findings.length === 0) {
    console.log(chalk.green('  No findings.'));
    return;
  }
  for (const finding of review.findings) {
    const head = `${LEVEL_GLYPH[finding.level]} [${finding.check}] ${finding.message}`;
    console.log(`  ${LEVEL_COLOR[finding.level](head)}`);
  }
}

/**
 * `teamai review --branch <name>`: check a pushed branch read-only and report
 * findings. Exits non-zero when a `fail` finding exists, so CI can gate on it.
 */
export async function reviewBranchCmd(options: ReviewBranchOptions): Promise<void> {
  const jsonMode = options.json === true;
  const localConfig = await resolveConfigForDir(undefined, undefined, { dryRun: true });
  if (!localConfig) {
    log.error('TeamAI is not initialized here. Run `teamai init` first.');
    process.exitCode = 1;
    return;
  }

  const repoPath = localConfig.repo.localPath;
  const ref = await resolveBranchRef(repoPath, options.branch);
  if (ref === null) {
    log.error(`Branch "${options.branch}" was not found in ${repoPath} (tried "${options.branch}" and "origin/${options.branch}").`);
    process.exitCode = 1;
    return;
  }

  const destDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-'));
  let review: BranchReview;
  try {
    await materializeRef(repoPath, ref, destDir);
    review = await reviewBranchDir(options.branch, destDir);
  } finally {
    await fse.remove(destDir).catch(() => undefined);
  }

  if (jsonMode) {
    console.log(JSON.stringify(review, null, 2));
  } else {
    renderReview(review);
  }
  if (!review.ok) process.exitCode = 1;
}
