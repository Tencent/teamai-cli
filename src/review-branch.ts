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
 * way. Workflow and scorer files reuse `syncWorkflowDefinitions` with dry-run
 * and an empty data home, and that check does not update this machine's
 * caches. It deliberately does not re-implement any of that.
 */
import os from 'node:os';
import path from 'node:path';

import chalk from 'chalk';
import fse from 'fs-extra';
import YAML from 'yaml';
import { z } from 'zod';

import { resolveConfigForDir } from './config.js';
import { caseFoldKey, isSafeNamespaceSegment, NAMESPACE_RULE } from './manifest-schema.js';
import { ALL_PROJECT_RESOURCE_TYPES, loadProjectsManifest, type AllProjectResourceType, type ProjectsManifest } from './projects.js';
import {
  isNestedPlaceableType, NAMESPACE_AXIS, PLACEABLE_TYPES, rootSegmentsFor, type PlaceableType,
} from './push-namespaces.js';
import { loadFailure } from './doctor-agent-models.js';
import { isModelAlias, loadTeamModelAliases, noModelCause, resolveAgentModel, resolveModelValue, TEAM_ALIASES_FILE, type ModelAliases } from './models/aliases.js';
import { parseAgentYaml, type AgentSpec, type ToolName } from './resources/agent-format.js';
import { hooksEntryReader } from './resources/hooks.js';
import { getHandler } from './resources/index.js';
import { listRepoFilesRecursive } from './resources/repo-resource.js';
import { isNamespaceDir, resolveResourceNamespaces } from './resource-namespaces.js';
import { loadRolesManifestIfPresent, type RolesManifest } from './roles.js';
import { AGENT_TOOLS } from './tools.js';
import { LocalConfigSchema, type GlobalOptions, type LocalConfig, type ResourceItem, type TeamaiConfig } from './types.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import { isIgnored, listFilesRecursive, pathExists, readFileIfExists, writeFile, ensureDir } from './utils/fs.js';
import { getFileContentAtRev, getHeadCommit, listTreeAtRev } from './utils/git.js';
import { isSilent, log, setSilent } from './utils/logger.js';
import { redact } from './utils/redact.js';
import { formatUnknownScorer, loadCachedWorkflow, loadWorkflowTree, syncWorkflowDefinitions } from './workflow/cache.js';
import { formatDiagnostic, INVOKE_ALIAS_SINCE, parseWorkflow } from './workflow/parse.js';
import { stepModelUnavailableText } from './workflow/step-model.js';
import type { WorkflowDefinition, WorkflowStep } from './workflow/types.js';
import { formatScorerDiagnostic } from './scorers/definition.js';
import { scorerModelUnavailableText } from './scorers/judge-model.js';
import { loadCachedScorer, SCORING_FILE, syncScorerDefinitions, type CachedScorer } from './scorers/cache.js';
import { requiredIsolation, unknownIsolationText } from './scorers/isolation.js';
import { parseScoringFile } from './scorers/settings.js';
import { SessionPolicy } from './session-flow/session-policy.js';

// ─── Findings ────────────────────────────────────────────────────────────────

/** How bad a finding is: `fail` blocks a merge, `warn` needs a human, `info` is context. */
export type FindingLevel = 'fail' | 'warn' | 'info';

/** Which group of checks produced a finding. */
export type FindingCheck = 'structure' | 'naming' | 'duplicates' | 'format' | 'leaks' | 'safety' | 'workflows' | 'scorers' | 'sessions' | 'models';

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
  const namespace = rest[0] ?? '';
  // Nested types keep the whole bundle-relative sub-path as the identity, never
  // the bare basename: co-active docs/a/api/guide.md and docs/b/ui/guide.md are
  // two resources, not a duplicate "guide", and the extension stays because
  // docs/a/api/guide.md and docs/b/api/guide.png are distinct files. The name
  // may contain '/', which namingFindings validates one segment at a time.
  if (isNestedPlaceableType(type)) {
    if (isNamespaceDir(type, namespace, index)) {
      return { name: rest.slice(1).join('/'), namespace };
    }
    return { name: rest.join('/') };
  }
  const name = stripExtension(rest[rest.length - 1] ?? '');
  return isNamespaceDir(type, namespace, index) ? { name, namespace } : { name };
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
      if (type === 'scorers' && path.posix.basename(file) === SCORING_FILE) continue;
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

/** Limits of the Agent Skills format (agentskills.io) for a SKILL.md `name` and `description`. */
const AGENT_SKILLS_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_SKILLS_DESCRIPTION_MAX = 1024;

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
      const name = data['name'];
      if (typeof name === 'string' && !AGENT_SKILLS_NAME.test(name)) {
        findings.push({
          level: 'warn',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has the name "${name}"; the Agent Skills format allows 1 to 64 lowercase letters, `
            + 'digits and hyphens, with no leading, trailing or doubled hyphen. Rename the skill directory and its name together.',
        });
      }
      const description = data['description'];
      const descriptionLength = typeof description === 'string' ? Array.from(description.trim()).length : 0;
      if (descriptionLength > AGENT_SKILLS_DESCRIPTION_MAX) {
        findings.push({
          level: 'warn',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has a "description" of ${descriptionLength} characters; `
            + `the Agent Skills format allows ${AGENT_SKILLS_DESCRIPTION_MAX}.`,
        });
      }
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
  const sharedScorers = new Map<string, ReviewResource[]>();
  for (const resource of resources) {
    if (resource.type === 'scorers' && !resource.namespace) byKey(sharedScorers, caseFoldKey(resource.name)).push(resource);
  }
  for (const group of sharedScorers.values()) {
    const [first, ...rest] = group.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
    for (const other of first ? rest : []) {
      findings.push({
        level: 'fail',
        check: 'duplicates',
        path: other.relativePath,
        message: `"${first.name}" is a shared scorer in both ${first.relativePath} and ${other.relativePath}, so pull caches neither. Rename or remove one of them.`,
      });
    }
  }
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

async function filesUnder(relativeDir: string, absoluteDir: string): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  return (await listFilesRecursive(absoluteDir)).map((rel) => ({
    relativePath: `${relativeDir}/${rel}`,
    absolutePath: path.join(absoluteDir, ...rel.split('/')),
  }));
}

async function leakFindings(repoDir: string, resources: ReviewResource[], readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const files = [
    ...(await Promise.all(resources.map((resource) => resource.type === 'skills'
      ? filesUnder(resource.relativePath, resource.absolutePath)
      : [{ relativePath: resource.relativePath, absolutePath: resource.absolutePath }]))).flat(),
    ...await filesUnder('scorers', path.join(repoDir, 'scorers')),
  ];
  const findings: Finding[] = [];
  // Several resources can share one file (every hook entry in a hooks.yaml is
  // its own resource); its contents are checked once, not once per entry.
  const seenFiles = new Set<string>();
  for (const file of files) {
    if (seenFiles.has(file.absolutePath)) continue;
    seenFiles.add(file.absolutePath);
    const content = await readText(file.absolutePath);
    if (!isScannable(content)) continue;

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
  return findings;
}

/** A skill file whose text the checks read: the same files, size cap and binary skip as `leaks`. */
interface SkillFile {
  skill: ReviewResource;
  relativePath: string;
  content: string;
}

function isScannable(content: string | null): content is string {
  return content !== null && content.length <= MAX_SCANNED_FILE_BYTES && !content.includes('\0');
}

async function scannableSkillFiles(resources: ReviewResource[], readText: (p: string) => Promise<string | null>): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  for (const skill of resources) {
    if (skill.type !== 'skills') continue;
    const listed = (await filesUnder(skill.relativePath, skill.absolutePath))
      .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
    for (const file of listed) {
      const content = await readText(file.absolutePath);
      if (isScannable(content)) files.push({ skill, relativePath: file.relativePath, content });
    }
  }
  return files;
}

/** The inside of `[text]` with up to `depth` levels of brackets, as Markdown link text allows. */
function bracketContent(depth: number): string {
  const nested = depth === 0 ? '' : String.raw`|\[${bracketContent(depth - 1)}\]`;
  return String.raw`(?:[^\[\]\\]|\\.${nested})*`;
}
// A bracket escaped by an odd run of backslashes is literal text, not a link.
// The check follows the bracket so it only runs where a bracket is.
const UNESCAPED_OPEN_BRACKET = String.raw`\[(?<=(?:^|[^\\])(?:\\\\)*\[)`;
const LINK_DESTINATION = String.raw`(<[^<>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)`;
const LINK_TITLE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))`;
/** Inline links and images `[text](target "title")`, and reference definitions `[id]: target`. */
const INLINE_LINK = new RegExp(String.raw`${UNESCAPED_OPEN_BRACKET}${bracketContent(3)}\]\(\s*${LINK_DESTINATION}(?:\s+${LINK_TITLE})?\s*\)`, 'g');
const REFERENCE_DEFINITION = new RegExp(
  String.raw`^[ \t]*\[(?!\^)(?:[^\[\]\\]|\\.)+\]:[ \t]*${LINK_DESTINATION}(?:[ \t]+${LINK_TITLE})?[ \t]*$`,
  'gm',
);
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;
/** A line that starts a block of its own, so a code span cannot continue into it; a blockquote starts one only after a line outside it. */
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
const BLOCKQUOTE = /^ {0,3}>/;

/** The indentation of a line in columns, a tab counting as four. */
function indentOf(line: string): number {
  let columns = 0;
  for (const char of /^[ \t]*/.exec(line)?.[0] ?? '') columns += char === '\t' ? 4 - (columns % 4) : 1;
  return columns;
}

/**
 * Markdown with fenced and indented code blocks, inline code and HTML comments
 * blanked, so links shown as code are not read as links. Inside a list item an
 * indented line continues the item unless it is indented four columns past the
 * item's content, and a fence may sit at the item's indentation.
 */
function withoutCode(markdown: string): string {
  let fence: string | null = null;
  let previousBlank = true;
  let inCode = false;
  let inList = false;
  // Where the current list item's content starts, and that of the item holding the open fence.
  let listIndent = 0;
  let fenceListIndent: number | null = null;
  let previousQuoted = false;
  let inCommentBlock = false;
  const blocks: string[][] = [[]];
  const startBlock = (): void => {
    if ((blocks[blocks.length - 1] ?? []).length > 0) blocks.push([]);
  };
  const keep = (line: string): void => {
    blocks[blocks.length - 1]?.push(line);
  };
  for (const line of markdown.split(/\r?\n/)) {
    // A line that starts with `<!--` opens an HTML block that runs to its `-->`;
    // what it holds, a fence included, is comment text the final pass removes.
    if (fence === null && (inCommentBlock || /^ {0,3}<!--/.test(line))) {
      inCommentBlock = !line.includes('-->', inCommentBlock ? 0 : line.indexOf('<!--') + 4);
      keep(line);
      continue;
    }
    if (fence !== null) {
      // A fence inside a list item also ends where a line outdents past the item.
      if (fenceListIndent !== null && line.trim() !== '' && indentOf(line) < fenceListIndent) {
        fence = null;
        inList = false;
      } else {
        const closing = (inList ? /^\s*(`{3,}|~{3,})[ \t]*$/ : /^ {0,3}(`{3,}|~{3,})[ \t]*$/).exec(line)?.[1];
        if (closing?.[0] === fence[0] && closing.length >= fence.length) fence = null;
        continue;
      }
    }
    const isListItem = LIST_ITEM.test(line);
    if (isListItem) listIndent = LIST_MARKER.exec(line)?.[0].length ?? line.trimEnd().length + 1;
    const fenceLine = isListItem ? line.replace(LIST_MARKER, '') : line;
    const fenceMarker = (inList || isListItem ? /^\s*(`{3,}|~{3,})/ : /^ {0,3}(`{3,}|~{3,})/).exec(fenceLine)?.[1];
    if (fenceMarker) {
      fence = fenceMarker;
      if (isListItem) inList = true;
      fenceListIndent = inList ? listIndent : null;
      startBlock();
      previousBlank = false;
      continue;
    }
    const isBlank = line.trim() === '';
    if (isBlank) {
      startBlock();
      previousQuoted = false;
    } else {
      if (isListItem) inList = true;
      else if (previousBlank && !/^\s/.test(line)) inList = false;
      // Indented code starts four columns past the content of the list item it sits in.
      if (!isListItem && (inCode || previousBlank) && indentOf(line) >= (inList ? listIndent : 0) + 4) {
        inCode = true;
        previousBlank = false;
        continue;
      }
      inCode = false;
      const isQuoted = BLOCKQUOTE.test(line);
      // Inside a blockquote, a blank quoted line or a quoted heading or list item starts a block too.
      const quoted = isQuoted ? line.replace(/^(?: {0,3}> ?)+/, '') : line;
      if (BLOCK_START.test(quoted) || quoted.trim() === '' || (isQuoted && !previousQuoted)) startBlock();
      previousQuoted = isQuoted;
      keep(line);
      if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) startBlock();
    }
    previousBlank = isBlank;
  }
  return withoutSpansAndComments(blocks.map((block) => block.join('\n')).join('\n\n'));
}

/**
 * `text` without code spans and HTML comments, read left to right as Markdown
 * does, so `<!--` shown as code opens no comment and a backtick inside a comment
 * opens no code span. A code span ends within its block (blocks are joined by a
 * blank line); a comment runs to its `-->`, or to the end when it never closes.
 */
function withoutSpansAndComments(text: string): string {
  // Backtick runs by length, each list in text order; the scan only moves forward,
  // so one pointer per length finds every closing run in linear time.
  const runsByLength = new Map<number, number[]>();
  for (const run of text.matchAll(/`+/g)) byKey(runsByLength, run[0].length).push(run.index);
  const nextRun = new Map<number, number>();
  const closingRun = (length: number, from: number, before: number): number => {
    const starts = runsByLength.get(length) ?? [];
    let next = nextRun.get(length) ?? 0;
    while ((starts[next] ?? Infinity) < from) next++;
    nextRun.set(length, next);
    const start = starts[next] ?? Infinity;
    return start < before ? start : -1;
  };

  const opener = /`+|<!--/g;
  let kept = '';
  let at = 0;
  let blockEnd = -1;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    // A backslash escapes the first backtick of a run; the rest may still open a span.
    let escapedBackslashes = 0;
    while (text.charAt(match.index - 1 - escapedBackslashes) === '\\') escapedBackslashes++;
    const escaped = match[0] !== '<!--' && escapedBackslashes % 2 === 1;
    if (match[0] === '<!--') {
      const close = text.indexOf('-->', match.index + 4);
      kept += text.slice(at, match.index);
      at = close < 0 ? text.length : close + 3;
    } else {
      if (match.index > blockEnd) {
        blockEnd = text.indexOf('\n\n', match.index);
        if (blockEnd < 0) blockEnd = text.length;
      }
      const start = match.index + (escaped ? 1 : 0);
      const run = match[0].length - (escaped ? 1 : 0);
      const close = run === 0 ? -1 : closingRun(run, start + run, blockEnd);
      if (close < 0) continue;
      kept += text.slice(at, start);
      at = close + run;
    }
    opener.lastIndex = at;
  }
  return kept + text.slice(at);
}

const NAMED_CHARACTER_REFERENCES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** `text` with numeric character references and the common named ones (`&amp;`, `&lt;`, …) decoded, as Markdown reads a destination. */
function decodeCharacterReferences(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z]+));/g, (reference, decimal?: string, hex?: string, name?: string) => {
    const codePoint = decimal !== undefined ? Number(decimal) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
    if (codePoint !== undefined) return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
    return (name !== undefined ? NAMED_CHARACTER_REFERENCES[name] : undefined) ?? reference;
  });
}

/** The local link targets of a Markdown file, without `#anchor` or `?query`; links with a scheme or a leading `/` are left out. */
function localLinkTargets(markdown: string): string[] {
  const text = withoutCode(markdown);
  const targets = new Set<string>();
  for (const match of [...text.matchAll(INLINE_LINK), ...text.matchAll(REFERENCE_DEFINITION)]) {
    const written = decodeCharacterReferences((match[1] ?? '').replace(/^<(.*)>$/, '$1').replace(/\\([!-/:-@[-`{-~])/g, '$1'));
    if (/^[a-z][a-z0-9+.-]*:/i.test(written) || written.startsWith('/')) continue;
    const target = written.replace(/[#?].*$/, '');
    if (target === '') continue;
    try {
      targets.add(decodeURIComponent(target));
    } catch {
      targets.add(target);
    }
  }
  return [...targets];
}

/**
 * Whether `segments` name an entry under `root` that pull copies with the skill.
 * Case must match exactly, as on the case-sensitive file systems members sync
 * to, and pull's copy skips a symlink or an ignored name on the way.
 */
async function linkTargetState(root: string, segments: string[], mustBeDirectory: boolean): Promise<'copied' | 'missing' | 'skipped'> {
  let dir = root;
  for (const [index, segment] of segments.entries()) {
    const entries = await fse.readdir(dir, { withFileTypes: true }).catch(() => []);
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) return 'missing';
    if (entry.isSymbolicLink() || isIgnored(segment)) return 'skipped';
    const isLast = index === segments.length - 1;
    if ((!isLast || mustBeDirectory) && !entry.isDirectory()) return 'missing';
    dir = path.join(dir, segment);
  }
  return 'copied';
}

/**
 * Links between the files of a skill, read where pull delivers it: each skill on
 * its own as `<skills>/<name>/`, namespaces flattened. A link that leaves the
 * skill resolves only into another skill delivered beside it, and only for a
 * member who also receives that skill; anything else never resolves.
 */
async function skillLinkFindings(files: SkillFile[], resources: ReviewResource[]): Promise<Finding[]> {
  const skillsByName = new Map<string, ReviewResource[]>();
  for (const resource of resources) if (resource.type === 'skills') byKey(skillsByName, resource.name).push(resource);
  const findings: Finding[] = [];
  for (const file of files) {
    if (!/\.(md|markdown)$/i.test(file.relativePath)) continue;
    const fromDir = path.posix.dirname(path.posix.relative(file.skill.relativePath, file.relativePath));
    for (const target of localLinkTargets(file.content)) {
      const mustBeDirectory = target.endsWith('/');
      const resolved = path.posix.normalize(path.posix.join(fromDir, target)).replace(/\/$/, '');
      const finding = (level: FindingLevel, message: string): void => {
        findings.push({ level, check: 'format', path: file.relativePath, message: `${file.relativePath} links to ${target}${message}` });
      };
      const segments = resolved === '.' ? [] : resolved.split('/');
      if (segments[0] !== '..') {
        reportLinkTarget(await linkTargetState(file.skill.absolutePath, segments, mustBeDirectory), ', which is not in the skill.', finding);
        continue;
      }
      const [, skillName = '', ...inSkill] = segments;
      const siblings = skillName === '..' ? [] : skillsByName.get(skillName) ?? [];
      if (siblings.length === 0) {
        finding('warn', ', which pull never delivers there: it delivers each skill as <skills>/<name>/, '
          + 'so link another skill as ../<name>/… and move any other file into the skill.');
        continue;
      }
      const states = await Promise.all(siblings.map((sibling) => linkTargetState(sibling.absolutePath, inSkill, mustBeDirectory)));
      const state = states.includes('copied') ? 'copied' : states.includes('skipped') ? 'skipped' : 'missing';
      if (state === 'copied' && skillName !== file.skill.name) {
        finding('info', `, in skill "${skillName}"; it resolves only for a member who also receives that skill.`);
        continue;
      }
      reportLinkTarget(state, `, which is not in skill "${skillName}".`, finding);
    }
  }
  return findings;
}

/** The finding for a link target inside a skill, if any: `missing` says `missingText`. */
function reportLinkTarget(
  state: 'copied' | 'missing' | 'skipped',
  missingText: string,
  finding: (level: FindingLevel, message: string) => void,
): void {
  switch (state) {
    case 'copied':
      return;
    case 'missing':
      finding('warn', missingText);
      return;
    case 'skipped':
      finding('warn', ', which pull does not copy (a symlink or an ignored name); replace it with the file itself.');
      return;
    default: {
      const unhandled: never = state;
      throw new Error(`Unhandled link target state: ${String(unhandled)}`);
    }
  }
}

/** What may precede the shell word of a stage: assignments, `sudo` with its options and assignments, `env` with options and assignments, and a directory. */
const COMMAND_PREFIX = String.raw`^\s*(?:\w+=\S*\s+)*(?:sudo\s+(?:-\S+(?:\s+(?!-)\S+)?\s+)*(?:\w+=\S*\s+)*)?`
  + String.raw`(?:env\s+(?:(?:-[uCS]\s*\S+|--(?:unset|chdir|split-string)(?:=|\s+)\S+|-\S+|\w+=\S*)\s+)*)?(?:\S*\/)?`;
// The shell word ends where the stage, a code span, a quoted string or a subshell does.
const SHELL_STAGE = new RegExp(String.raw`${COMMAND_PREFIX}((?:ba|da|k|z)?sh|fish)(?=[\s\`'")]|$)`);

/**
 * Whether the shell whose arguments start at `args` reads its script from stdin:
 * not when `-c` gives it one, unless `-s` says so. Reading stops at the first word
 * that is not an option, and at a code span, a quote or a subshell, since prose
 * may follow the command.
 */
function shellReadsStdin(args: string): boolean {
  let readsStdin = true;
  for (const word of (args.split(/[`'")]/)[0] ?? '').trim().split(/\s+/)) {
    if (!/^-[a-zA-Z]+$/.test(word)) break;
    if (word.includes('s')) return true;
    if (word.includes('c')) readsStdin = false;
  }
  return readsStdin;
}

/** The `curl` or `wget` a stage runs: a whole word, as a command or in prose, but not text `echo` or `printf` prints. */
function downloaderOf(stage: string): { word: 'curl' | 'wget'; argsAt: number } | undefined {
  const found = /(?<![\w.-])(curl|wget)(?=\s|$)/.exec(stage);
  const word = found?.[1];
  if (!found || (word !== 'curl' && word !== 'wget') || /\b(?:echo|printf)(?:\s+-\S+)*\s+['"]?$/.test(stage.slice(0, found.index))) return undefined;
  return { word, argsAt: found.index + word.length };
}

/** The words of a command as the shell splits them, quotes still in place. */
function commandWords(command: string): string[] {
  return command.match(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])+/g) ?? [];
}

/** A word with its quotes removed, as the command receives it. */
function unquote(word: string): string {
  return word.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_quoted, double?: string, single?: string) => double ?? single ?? '');
}

/** A download URL without a scheme, such as `example.com/i.sh`; a bare number such as a `--retry` count is not one. */
const SCHEMELESS_URL = /^(?!\d+(?:\.\d+)*$)[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:\/\S*)?$/;

/** Short options that take a value, attached or as the next word; the rest of a bundle after one is that value. */
const SHORT_OPTIONS_WITH_VALUE: Record<'curl' | 'wget', ReadonlySet<string>> = {
  curl: new Set('AbcCdDeEFhHKmoPQrtTuUwxXyYz'),
  wget: new Set('aABDeiIlLoOPQRtTUwX'),
};
/** curl long options that take the next word as their value, so a URL there is not a download. */
const CURL_LONG_OPTION_WITH_VALUE = new RegExp(String.raw`^--(?:data(?:-[a-z]+)?|form(?:-string)?|json|header|proxy(?:-(?:user|header|cacert|capath|cert|key|pass|ciphers|service-name|tlsuser|tlspassword))?|preproxy|referer|doh-url`
  + String.raw`|user(?:-agent)?|cookie(?:-jar)?|upload-file|url-query|request|resolve|connect-to|config|cacert|capath|cert|key|output-dir`
  + String.raw`|retry(?:-delay|-max-time)?|max-time|connect-timeout|max-filesize|limit-rate|range|time-cond|write-out|dump-header|trace(?:-ascii)?)$`);

/** Whether a shell word sends standard output to a file or another descriptor: `>file`, `1>file`, `&>file`, `>&2`, attached or not. */
function redirectsStdout(rawWord: string): boolean {
  const unquoted = rawWord.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '');
  const at = unquoted.indexOf('>');
  if (at < 0) return false;
  const descriptor = unquoted.slice(0, at);
  return !/^\d+$/.test(descriptor) || descriptor === '1';
}

/**
 * Whether the `curl` or `wget` whose arguments are `args` writes a download to
 * standard output rather than to a file. curl writes each URL to stdout unless an
 * output option (`-o FILE`, `-O`, `--output FILE`, `--remote-name`) is paired with
 * it; wget writes to stdout only when its last `-O` is `-`. A redirection of the
 * command's stdout feeds nothing to the pipe.
 */
function writesToStdout(downloader: 'curl' | 'wget', args: string): boolean {
  const rawWords = commandWords(args);
  if (rawWords.some(redirectsStdout)) return false;
  const words = rawWords.map(unquote);
  const withValue = SHORT_OPTIONS_WITH_VALUE[downloader];
  let urls = 0;
  let savedOutputs = 0;
  let stdoutOutputs = 0;
  let remoteNameAll = false;
  // wget writes where its last -O points.
  let wgetOutput: string | undefined;
  // `-`, `/dev/stdout` and `/dev/fd/1` all name standard output.
  const isStdout = (value: string | undefined): boolean => value === '-' || value === '/dev/stdout' || value === '/dev/fd/1';
  const countOutput = (value: string): void => {
    if (isStdout(value)) stdoutOutputs++;
    else savedOutputs++;
  };
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? '';
    const valueOf = (attached: string): string => (attached !== '' ? attached : words[++index] ?? '');
    if (/^-[^-]/.test(word)) {
      for (let at = 1; at < word.length; at++) {
        const letter = word.charAt(at);
        if (downloader === 'curl' && letter === 'O') savedOutputs++;
        if (!withValue.has(letter)) continue;
        const value = valueOf(word.slice(at + 1));
        if (downloader === 'wget' && letter === 'O') wgetOutput = value;
        if (downloader === 'curl' && letter === 'o') countOutput(value);
        break;
      }
      continue;
    }
    // A `$` expansion stands for a URL, as in `curl "$INSTALL_URL"`.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word) || SCHEMELESS_URL.test(word) || word.startsWith('--url=') || word.startsWith('$')) urls++;
    if (downloader === 'wget') {
      const long = /^--output-document(?:=(.*))?$/.exec(word);
      if (long) wgetOutput = valueOf(long[1] ?? '');
      continue;
    }
    if (word === '--remote-name-all') remoteNameAll = true;
    if (word === '--remote-name') savedOutputs++;
    const long = /^--output(?:=(.*))?$/.exec(word);
    if (long) countOutput(valueOf(long[1] ?? ''));
    if (CURL_LONG_OPTION_WITH_VALUE.test(word)) index++;
  }
  // Without a URL it is text that names the command, such as "we avoid curl | sh".
  if (urls === 0) return false;
  if (downloader === 'wget') return isStdout(wgetOutput);
  // curl pairs output options with URLs in order: `-o -` sends its URL to stdout,
  // and a URL left without an output goes there too unless --remote-name-all saves it.
  return stdoutOutputs > 0 || (!remoteNameAll && urls > savedOutputs + stdoutOutputs);
}

/**
 * `line` with `;`, `&` and `|` inside a closed quote blanked, since there they are
 * part of an argument rather than the end of a command. A quote with no closing match
 * on the line is literal, and so is every later one of that kind, which keeps the
 * scan linear.
 */
function blankQuotedSeparators(line: string): string {
  let blanked = '';
  let at = 0;
  const unclosed = new Set<string>();
  while (at < line.length) {
    const char = line.charAt(at);
    const close = (char === "'" || char === '"') && !unclosed.has(char) ? closingQuote(line, at) : -1;
    if (close < 0) {
      if (char === "'" || char === '"') unclosed.add(char);
      blanked += char;
      at++;
      continue;
    }
    // A quote whose text runs a download, such as a package.json or YAML script, is
    // still read as a command; a download word elsewhere in it, as in a header, is not.
    const quoted = line.slice(at, close + 1);
    const holdsCommand = /(?:^["']|[;&|])\s*(?:sudo\s+)?(?:curl|wget)\b/.test(quoted);
    blanked += quoted.replace(holdsCommand ? /[;&]/g : /[;&|]/g, ' ');
    at = close + 1;
  }
  return blanked;
}

/** The index of the quote that closes the one at `open`, or -1; inside double quotes a backslash escapes it. */
function closingQuote(line: string, open: number): number {
  const quote = line.charAt(open);
  for (let at = line.indexOf(quote, open + 1); at >= 0; at = line.indexOf(quote, at + 1)) {
    let backslashes = 0;
    while (quote === '"' && line.charAt(at - 1 - backslashes) === '\\') backslashes++;
    if (backslashes % 2 === 0) return at;
  }
  return -1;
}

/** A shell that runs a download through process or command substitution: `bash <(curl …)`, `sh -c "$(curl …)"`. */
const SUBSTITUTED_INSTALL = /(?<![\w.-])((?:ba|da|k|z)?sh)\s+((?:-\S+\s+)*)(<\(|["']?\$\()\s*(curl|wget)(?=\s)/;

/**
 * The first `curl` or `wget` whose output a shell runs, written as the install
 * reads (`curl … | sh`): a later stage of the same pipeline, or a shell around a
 * substitution. Commands are split on newlines, `;`, `&&` and `||` and then into
 * stages on `|`, so the scan stays linear in the file size.
 */
function findPipedInstall(text: string): string | null {
  const commands = text
    // A trailing backslash or pipe continues the command on the next line.
    .replace(/\\\r?\n/g, ' ')
    .replace(/\|[ \t]*\r?\n/g, '| ')
    .split('\n')
    .flatMap((line) => blankQuotedSeparators(line).split(/;|&&|\|\|/));
  for (const command of commands) {
    const substituted = SUBSTITUTED_INSTALL.exec(command);
    const [, substitutingShell, options = '', opener, substitutedDownloader] = substituted ?? [];
    // A command substitution is a script only after `-c`; without it the shell opens a file of that name.
    const runsSubstitution = opener === '<(' || /(?:^|\s)-[a-zA-Z]*c/.test(options);
    if (substituted && substitutingShell !== undefined && runsSubstitution && (substitutedDownloader === 'curl' || substitutedDownloader === 'wget')) {
      const args = command.slice(substituted.index + substituted[0].length).split(')')[0] ?? '';
      if (writesToStdout(substitutedDownloader, args)) {
        return opener === '<(' ? `${substitutingShell} <(${substitutedDownloader} …)` : `${substitutingShell} -c "$(${substitutedDownloader} …)"`;
      }
    }
    let downloader: string | undefined;
    for (const stage of command.split('|')) {
      const shellStage = downloader === undefined ? null : SHELL_STAGE.exec(stage);
      const shell = shellStage?.[1];
      if (downloader !== undefined && shellStage && shell !== undefined && shellReadsStdin(stage.slice(shellStage[0].length))) {
        return `${downloader} … | ${shell}`;
      }
      const download = downloaderOf(stage);
      if (downloader === undefined && download !== undefined && writesToStdout(download.word, stage.slice(download.argsAt))) downloader = download.word;
    }
  }
  return null;
}

function pipedInstallFindings(files: SkillFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    // A script's comment lines are not run; a Markdown `#` line is a heading.
    const runnable = /\.(md|markdown)$/i.test(file.relativePath) ? file.content : file.content.replace(/^[ \t]*#.*$/gm, '');
    const pipedInstall = findPipedInstall(runnable);
    if (!pipedInstall) continue;
    findings.push({
      level: 'warn',
      check: 'safety',
      path: file.relativePath,
      message: `${file.relativePath} runs a download in a shell (${pipedInstall}); `
        + 'ship the script in the skill or pin what it runs.',
    });
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

/** Invalid workflow and scorer files, and scorers a step lists that do not exist. Dry-run, so the call does not write a cache. */
async function workflowFindings(repoDir: string): Promise<Finding[]> {
  const dataHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-workflows-'));
  const wasSilent = isSilent();
  setSilent(true);
  try {
    const result = await syncWorkflowDefinitions(reviewTreeConfig(repoDir, dataHome), {
      dryRun: true,
      everyNamespace: true,
      scopeLabel: 'review',
    });
    return [
      ...result.scorers.invalid.map((diagnostic): Finding => ({
        level: 'fail',
        check: 'scorers',
        path: diagnostic.file,
        message: formatScorerDiagnostic(diagnostic),
      })),
      ...result.invalid.map((diagnostic): Finding => ({
        level: 'fail',
        check: 'workflows',
        path: diagnostic.file,
        message: formatDiagnostic(diagnostic),
      })),
      // Pull runs such a step without the scorer; a branch under review should not ship the gap.
      ...result.unknownScorers.map((unknown): Finding => ({
        level: 'fail',
        check: 'workflows',
        path: unknown.file,
        message: formatUnknownScorer(unknown),
      })),
      // Each still starts by name; the alias starts nothing, or another workflow.
      ...result.aliasConflicts.map((diagnostic): Finding => ({
        level: 'fail',
        check: 'workflows',
        path: diagnostic.file,
        message: formatDiagnostic(diagnostic),
      })),
      ...await invokeAliasFindings(repoDir),
    ];
  } finally {
    setSilent(wasSilent);
    await fse.remove(dataHome);
  }
}

/**
 * A warning on each valid workflow file that sets `invoke` or `alias`: a member or CI job on an older CLI drops the
 * whole workflow, and nothing refuses that older CLI.
 */
async function invokeAliasFindings(repoDir: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const files = (await listRepoFilesRecursive(path.join(repoDir, 'workflows'))).filter((file) => file.endsWith('.yaml')).sort();
  for (const file of files) {
    const relativePath = `workflows/${file}`;
    const content = await readFileIfExists(path.join(repoDir, 'workflows', ...file.split('/')));
    const parsed = content === null ? null : parseWorkflow(relativePath, content);
    if (!parsed?.ok) continue;
    const keys = [parsed.definition.invoke !== undefined && 'invoke', parsed.definition.alias !== undefined && 'alias'].filter((key) => key !== false);
    if (keys.length === 0) continue;
    findings.push({
      level: 'warn',
      check: 'workflows',
      path: relativePath,
      message: `${relativePath} sets ${keys.join(' and ')}: teamai before ${INVOKE_ALIAS_SINCE} drops a workflow that sets invoke or alias, so members and CI jobs must run at least ${INVOKE_ALIAS_SINCE}.`,
    });
  }
  return findings;
}

/** Every `scorers/scoring.yaml` and `scorers/<dir>/scoring.yaml` of the branch, active for anyone or not: what it cannot parse, a key or value it ignores, and an isolation teamai does not know. */
async function scoringSettingsFindings(repoDir: string, readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const dirs = (await fse.readdir(path.join(repoDir, 'scorers'), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const findings: Finding[] = [];
  for (const relativePath of [`scorers/${SCORING_FILE}`, ...dirs.map((dir) => `scorers/${dir}/${SCORING_FILE}`)]) {
    const text = await readText(path.join(repoDir, ...relativePath.split('/')));
    if (text === null) continue;
    const read = parseScoringFile(relativePath, text);
    const messages = read.ok
      ? [...read.problems, ...requiredIsolation([{ source: `${relativePath} isolation`, value: read.isolation }]).unknown.map(unknownIsolationText)]
      : [read.reason];
    findings.push(...messages.map((message): Finding => ({ level: 'fail', check: 'scorers', path: relativePath, message })));
  }
  return findings;
}

const TeamSessionsSchema = z.object({ sessions: z.unknown() });

/** The branch's `teamai.yaml` `sessions.publish` (#1385): each value pull ignores. A file that does not parse reports nothing here. */
async function sessionsFindings(repoDir: string, readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const text = await readText(path.join(repoDir, 'teamai.yaml'));
  if (text === null) return [];
  let team: unknown;
  try {
    team = YAML.parse(text);
  } catch {
    return [];
  }
  const parsed = TeamSessionsSchema.safeParse(team);
  const sessions = parsed.success ? parsed.data.sessions : undefined;
  return SessionPolicy.readPublish('teamai.yaml', sessions).problems.map((message): Finding => ({ level: 'fail', check: 'sessions', path: 'teamai.yaml', message }));
}

/**
 * The prompt steps a run of `definition` reaches, with each step's path, such as `check.classify`, and the
 * `defaults.model` in effect for it: an inline workflow uses the enclosing one, and a workflow file another runs its
 * own, else its caller's. A file that sets its own, and a step there that sets a model, are left to that file's check.
 */
function promptSteps(
  definition: { steps: WorkflowStep[] },
  workflows: Record<string, WorkflowDefinition>,
  defaultModel: string | undefined,
  prefix = '',
  inherited = false,
): Array<{ path: string; step: WorkflowStep; defaultModel: string | undefined }> {
  return definition.steps.flatMap((step) => {
    const stepPath = `${prefix}${step.id}`;
    if (typeof step.workflow === 'object') return promptSteps(step.workflow, workflows, defaultModel, `${stepPath}.`, inherited);
    if (step.workflow !== undefined) {
      const runs: WorkflowDefinition | undefined = workflows[step.workflow];
      return runs && runs.defaults?.model === undefined && defaultModel !== undefined
        ? promptSteps(runs, workflows, defaultModel, `${stepPath}.`, true)
        : [];
    }
    if (step.prompt === undefined && step.promptFile === undefined) return [];
    return inherited && step.model !== undefined ? [] : [{ path: stepPath, step, defaultModel }];
  });
}

/**
 * The workflow files `config` runs, each with the workflow files it runs, as pull caches them and start loads them, and
 * the scorers it receives, as pull caches them.
 */
async function receivedDefinitions(config: LocalConfig): Promise<{
  workflows: Array<{ relativePath: string; definition: WorkflowDefinition; workflows: Record<string, WorkflowDefinition> }>;
  scorers: CachedScorer[];
}> {
  const dataHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-models-'));
  const scratch = { ...config, dataHome };
  const wasSilent = isSilent();
  setSilent(true);
  try {
    const workflows = [];
    for (const name of (await syncWorkflowDefinitions(scratch)).cached) {
      const cached = await loadCachedWorkflow(scratch, name);
      const tree = cached && await loadWorkflowTree(scratch, cached);
      if (cached && tree && !('failed' in tree)) workflows.push({ relativePath: cached.relativePath, definition: cached.definition, workflows: tree.workflows });
    }
    const scorers = [];
    for (const name of (await syncScorerDefinitions(scratch)).cached) {
      const cached = await loadCachedScorer(scratch, name);
      if (cached) scorers.push(cached);
    }
    return { workflows, scorers };
  } finally {
    setSilent(wasSilent);
    await fse.remove(dataHome);
  }
}

/** The members of one selection of the branch: no role or project, one role, or one project. */
interface ModelContext {
  /** How a finding names these members: `role dev`. */
  label: string;
  config: LocalConfig;
  aliases: ModelAliases;
  /** The agent namespaces these members receive; null when they receive every one. */
  agentNamespaces: readonly string[] | null;
}

async function modelContexts(repoDir: string, roles: RolesManifest | null, projects: ProjectsManifest | null): Promise<ModelContext[]> {
  const base = reviewTreeConfig(repoDir, os.tmpdir());
  const selections: Array<{ label: string; config: LocalConfig }> = [
    { label: 'no role or project', config: base },
    ...(roles?.roles ?? []).map((role) => ({ label: `role ${role.id}`, config: { ...base, primaryRole: role.id } })),
    ...(projects?.projects ?? []).map((project) => ({ label: `project ${project.id}`, config: { ...base, projects: [project.id] } })),
  ];
  return Promise.all(selections.map(async ({ label, config }) => ({
    label,
    config,
    aliases: await loadTeamModelAliases(config),
    agentNamespaces: await resolveResourceNamespaces(config).then((resolved) => resolved?.activeNamespaces.agents ?? null, () => null),
  })));
}

function receives(context: ModelContext, namespace: string | undefined): boolean {
  return namespace === undefined || context.agentNamespaces === null || context.agentNamespaces.some((active) => caseFoldKey(active) === caseFoldKey(namespace));
}

/** Why `model` gives none of `tools` a model, worded to follow "which", or undefined when it gives one, or is a model name. */
function valueCause(aliases: ModelAliases, model: string, tools?: readonly ToolName[]): string | undefined {
  if (!isModelAlias(aliases, model)) return undefined;
  const resolutions = (tools ?? AGENT_TOOLS).map((tool) => resolveModelValue(aliases, model, tool));
  if (resolutions.some((resolution) => resolution.ok && resolution.model !== undefined)) return undefined;
  return noModelCause(resolutions[0] ?? { ok: true, step: 'default' }, tools?.join(', ') ?? 'any tool');
}

/** Why `spec` gives none of its target tools a model, as pull resolves it: a tool's extras model first. */
function agentCause(aliases: ModelAliases, spec: AgentSpec): string | undefined {
  const tools = spec.targets ?? AGENT_TOOLS;
  const resolutions = tools.map((tool) => resolveAgentModel(aliases, spec, tool));
  if (resolutions.some((resolution) => resolution.ok && resolution.model !== undefined)) return undefined;
  return noModelCause(resolutions[0] ?? { ok: true, step: 'default' }, spec.targets?.join(', ') ?? 'any tool');
}

/**
 * The model aliases the branch's agents, workflow steps, `defaults.model` and scorers ask for that the branch's own
 * team aliases files map for none of the tools that would use them, or the reason those files cannot be read. Each
 * role and project the branch declares, and members with neither, receive their own agents and aliases files, so each
 * is checked on its own and a finding names the ones it is about. Member overrides, model switches and installed
 * tools are this machine's, so they play no part. A model name is never one.
 */
async function modelFindings(repoDir: string, resources: ReviewResource[], readText: (p: string) => Promise<string | null>, roles: RolesManifest | null, projects: ProjectsManifest | null): Promise<Finding[]> {
  const contexts = await modelContexts(repoDir, roles, projects);
  const [unselected] = contexts;
  const failure = unselected && loadFailure(unselected.aliases);
  if (failure) return [{ level: 'fail', check: 'models', path: TEAM_ALIASES_FILE, message: failure }];
  const findings: Finding[] = [];
  const fail = (relativePath: string, message: string) => findings.push({ level: 'fail', check: 'models', path: relativePath, message });
  const failures = new Map<string, string[]>();
  for (const context of contexts) {
    const reason = loadFailure(context.aliases);
    if (reason) failures.set(reason, [...failures.get(reason) ?? [], context.label]);
  }
  for (const [reason, labels] of failures) fail(TEAM_ALIASES_FILE, `${reason} (${labels.join(', ')})`);
  const readable = contexts.filter((context) => loadFailure(context.aliases) === undefined);
  /** The cause in the first context `causeIn` finds one, naming the contexts it holds for when the branch has roles or projects. */
  const unmapped = (among: readonly ModelContext[], causeIn: (context: ModelContext) => string | undefined): string | undefined => {
    const found = among.flatMap((context) => {
      const cause = causeIn(context);
      return cause === undefined ? [] : [{ cause, label: context.label }];
    });
    const [first] = found;
    if (!first) return undefined;
    return contexts.length === 1 ? first.cause : `${first.cause} (${found.map(({ label }) => label).join(', ')})`;
  };

  const agents: Array<{ resource: ReviewResource; spec: AgentSpec }> = [];
  for (const resource of resources) {
    if (resource.type !== 'agents' || !/\.(yaml|yml)$/i.test(resource.absolutePath)) continue;
    const content = await readText(resource.absolutePath);
    const parsed = content === null ? null : parseAgentYaml(content, path.basename(resource.relativePath));
    if (parsed?.ok) agents.push({ resource, spec: parsed.spec });
  }
  for (const { resource, spec } of agents) {
    if (spec.model === undefined) continue;
    const cause = unmapped(readable.filter((context) => receives(context, resource.namespace)), (context) => agentCause(context.aliases, spec));
    if (cause) fail(resource.relativePath, `Agent "${spec.name}" asks for model alias "${spec.model}", which ${cause}. Add one, or remove model from the agent.`);
  }

  const received = new Map(await Promise.all(readable.map(async (context) => [context, await receivedDefinitions(context.config)] as const)));
  const steps = new Map<string, { relativePath: string; stepPath: string; own: boolean; model: string; contexts: ModelContext[] }>();
  for (const context of readable) {
    for (const { relativePath, definition, workflows } of received.get(context)?.workflows ?? []) {
      for (const { path: stepPath, step, defaultModel } of promptSteps(definition, workflows, definition.defaults?.model)) {
        const own = step.model !== undefined;
        // A run takes `defaults.model` unless the step's agent sets its own; an agent the branch does not have may set one.
        const model = step.model ?? defaultModel;
        if (model === undefined) continue;
        if (!own && step.agent !== undefined) {
          const agent = agents.find(({ resource, spec }) => spec.name === step.agent && receives(context, resource.namespace));
          if (agent === undefined || agent.spec.model !== undefined) continue;
        }
        const key = JSON.stringify([relativePath, stepPath, own, model]);
        const entry = steps.get(key) ?? { relativePath, stepPath, own, model, contexts: [] };
        entry.contexts.push(context);
        steps.set(key, entry);
      }
    }
  }
  for (const { relativePath, stepPath, own, model, contexts: among } of [...steps.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const cause = unmapped(among, (context) => valueCause(context.aliases, model));
    if (cause) fail(relativePath, stepModelUnavailableText(stepPath, own ? 'step' : 'defaults', `model alias "${model}"`, cause, 'unmapped'));
  }

  const scorers = new Map<string, { name: string; model: string; contexts: ModelContext[] }>();
  for (const context of readable) {
    for (const { relativePath, definition: { name, model } } of received.get(context)?.scorers ?? []) {
      if (model === undefined) continue;
      const entry = scorers.get(relativePath) ?? { name, model, contexts: [] };
      entry.contexts.push(context);
      scorers.set(relativePath, entry);
    }
  }
  for (const [relativePath, { name, model, contexts: among }] of [...scorers].sort(([left], [right]) => left.localeCompare(right))) {
    const cause = unmapped(among, (context) => valueCause(context.aliases, model));
    if (cause) fail(relativePath, scorerModelUnavailableText(name, `model alias "${model}"`, cause, 'unmapped'));
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
  const resources = await scanResources(repoDir, index);
  const readText = makeTextReader();
  const skillFiles = await scannableSkillFiles(resources, readText);

  const findings: Finding[] = [
    ...await structureFindings(resources, index),
    ...await namingFindings(resources, readText),
    ...await duplicateFindings(resources, index),
    ...await skillLinkFindings(skillFiles, resources),
    ...await formatFindings(resources, readText),
    ...pipedInstallFindings(skillFiles),
    ...await leakFindings(repoDir, resources, readText),
    ...await workflowFindings(repoDir),
    ...await scoringSettingsFindings(repoDir, readText),
    ...await sessionsFindings(repoDir, readText),
    ...await modelFindings(repoDir, resources, readText, roles, projects),
  ];

  const counts: Record<FindingLevel, number> = { fail: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.level]++;

  return { branch, ok: counts.fail === 0, counts, findings };
}

// ─── Read-only branch reader ─────────────────────────────────────────────────

/**
 * The repo roots read out of the branch, and `teamai.yaml`; everything else is irrelevant here.
 * Wiki is read from its authoritative root `teamwiki/evidence/code`, matching
 * where the resource handler and pull actually read it — reading `wiki/` would
 * let everything under the real root bypass review.
 */
const READ_ROOTS = [...PLACEABLE_TYPES.map(repoRootFor), 'manifest', 'teamai.yaml'];

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
