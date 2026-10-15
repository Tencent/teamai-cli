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
 * way. It deliberately does not re-implement any of that.
 */
import os from 'node:os';
import path from 'node:path';

import chalk from 'chalk';
import fse from 'fs-extra';

import { resolveConfigForDir } from './config.js';
import { caseFoldKey, isSafeNamespaceSegment, NAMESPACE_RULE } from './manifest-schema.js';
import { loadProjectsManifest, type ProjectResourceType, type ProjectsManifest } from './projects.js';
import { NAMESPACE_AXIS, type PlaceableType } from './push-namespaces.js';
import { parseAgentYaml } from './resources/agent-format.js';
import { AgentsHandler } from './resources/agents.js';
import { RulesHandler } from './resources/rules.js';
import { SkillsHandler } from './resources/skills.js';
import { loadRolesManifestIfPresent, type RolesManifest } from './roles.js';
import type { GlobalOptions, LocalConfig, ResourceItem, TeamaiConfig } from './types.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import { listFilesRecursive, pathExists, readFileIfExists, writeFile, ensureDir } from './utils/fs.js';
import { getFileContentAtRev, getHeadCommit, listFilesAtRev } from './utils/git.js';
import { log } from './utils/logger.js';
import { redact } from './utils/redact.js';

// ─── Findings ────────────────────────────────────────────────────────────────

/** How bad a finding is: `fail` blocks a merge, `warn` needs a human, `info` is context. */
export type FindingLevel = 'fail' | 'warn' | 'info';

/** Which group of checks produced a finding. */
export type FindingCheck = 'structure' | 'naming' | 'duplicates' | 'format' | 'leaks';

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

const AXES: readonly ProjectResourceType[] = ['knowledge', 'skills', 'learnings', 'agents'];

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
function parseRelativePath(relativePath: string): { name: string; namespace?: string } {
  const rest = relativePath.split('/').slice(1);
  if (rest.length <= 1) {
    return { name: stripExtension(rest[0] ?? '') };
  }
  return {
    name: stripExtension(rest[rest.length - 1] ?? ''),
    namespace: rest[0],
  };
}

/** Enumerate the resources on the branch through the same scanners pull uses. */
async function scanResources(repoDir: string): Promise<ReviewResource[]> {
  // `scanTeamForPull` reads only `repo.localPath` for skills, rules and agents;
  // the rest of the configs are placeholders, as in the handlers' own tests.
  const localConfig = { repo: { localPath: repoDir } } as LocalConfig;
  const teamConfig = {} as TeamaiConfig;
  const items: Array<{ type: PlaceableType; item: ResourceItem }> = [
    ...(await new SkillsHandler().scanTeamForPull(teamConfig, localConfig)).map((item) => ({ type: 'skills' as const, item })),
    ...(await new RulesHandler().scanTeamForPull(teamConfig, localConfig)).map((item) => ({ type: 'rules' as const, item })),
    ...(await new AgentsHandler().scanTeamForPull(teamConfig, localConfig)).map((item) => ({ type: 'agents' as const, item })),
  ];
  return items.map(({ type, item }) => {
    const { name, namespace } = parseRelativePath(item.relativePath);
    return { type, name, namespace, relativePath: item.relativePath, absolutePath: item.sourcePath };
  });
}

// ─── Manifest index ──────────────────────────────────────────────────────────

/** The namespace lists a branch's roles and projects declare, per axis. */
interface ManifestIndex {
  /** True when any role or project declares `namespace` on `axis`. */
  declares(axis: ProjectResourceType, namespace: string): boolean;
  /** True when any single role or project declares both namespaces on `axis`. */
  coActive(axis: ProjectResourceType, a: string, b: string): boolean;
  /** True when any role or project declares any namespace on `axis`. */
  anyOn(axis: ProjectResourceType): boolean;
}

function buildManifestIndex(roles: RolesManifest | null, projects: ProjectsManifest | null): ManifestIndex {
  const listsByAxis = new Map<ProjectResourceType, string[][]>();
  for (const axis of AXES) listsByAxis.set(axis, []);

  const collect = (resources: Partial<Record<ProjectResourceType, string[]>>): void => {
    for (const axis of AXES) {
      const list = resources[axis];
      if (list && list.length > 0) listsByAxis.get(axis)!.push(list);
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
      if (!index.declares(axis, resource.namespace)) {
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
    if (!isSafeNamespaceSegment(resource.name)) {
      findings.push({
        level: 'fail',
        check: 'naming',
        path: resource.relativePath,
        message: `Resource name "${resource.name}" in ${resource.relativePath} is not a usable path segment: ${NAMESPACE_RULE}.`,
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
  for (const resource of resources) {
    const files = resource.type === 'skills'
      ? (await listFilesRecursive(resource.absolutePath)).map((rel) => ({
        relativePath: `${resource.relativePath}/${rel}`,
        absolutePath: path.join(resource.absolutePath, ...rel.split('/')),
      }))
      : [{ relativePath: resource.relativePath, absolutePath: resource.absolutePath }];

    for (const file of files) {
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

// ─── Engine ──────────────────────────────────────────────────────────────────

/** Every check, in the order the reporter listed them. */
export async function reviewBranchDir(branch: string, repoDir: string): Promise<BranchReview> {
  const [roles, projects] = await Promise.all([
    loadRolesManifestIfPresent(repoDir),
    loadProjectsManifest(repoDir),
  ]);
  const index = buildManifestIndex(roles, projects);
  const resources = await scanResources(repoDir);
  const readText = makeTextReader();

  const findings: Finding[] = [
    ...await structureFindings(resources, index),
    ...await namingFindings(resources, readText),
    ...await duplicateFindings(resources, index),
    ...await formatFindings(resources, readText),
    ...await leakFindings(resources, readText),
  ];

  const counts: Record<FindingLevel, number> = { fail: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.level]++;

  return { branch, ok: counts.fail === 0, counts, findings };
}

// ─── Read-only branch reader ─────────────────────────────────────────────────

/** The repo roots read out of the branch; everything else is irrelevant here. */
const READ_ROOTS = ['skills', 'rules', 'agents', 'manifest'];

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
    for (const file of await listFilesAtRev(repoPath, ref, root)) {
      const content = await getFileContentAtRev(repoPath, ref, file);
      if (content === null) continue;
      const dest = path.join(destDir, ...file.split('/'));
      await ensureDir(path.dirname(dest));
      await writeFile(dest, content);
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
