/**
 * Rule folders (#1787): `rules/[<ns>/]<name>/RULE.md` and the support files beside it. Each tool still receives one
 * rule file, `<name><ext>`, whose text names the folder through `${TEAMAI_RULE_DIR}`; pull renders that to where the
 * tool reads the folder's files, and delivers the folder there (`DeliveredFolders`, common rule 9).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DeliveryLedger } from './delivered-copies.js';
import { DELIVERED_DIR, DeliveredFolders, type DeliveredFolderRef } from './delivered-folders.js';
import { FolderFiles, type FolderFile } from './folder-files.js';
import { splitRuleFrontmatter } from './team-rule.js';
import { ruleFolderReachOf } from '../tools.js';
import { isSelfMode, type LocalConfig, type ResourceItem, type TeamaiConfig } from '../types.js';
import { pathExists, readJsonObject, writeJson } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { warnOnce } from '../utils/warn-once.js';

/** A rule folder, as the team repo holds it: `item.sourcePath` is its `RULE.md`. */
type RuleFolder = ResourceItem & { readonly folder: true };

/** Whether `rule` is a rule folder rather than a rule file. */
function isFolder(rule: ResourceItem): rule is RuleFolder {
  return rule.folder === true;
}

/** Where the rule folder `name` sits in the rules directory: its namespace path and its own name. */
function refOf({ name }: { readonly name: string }): DeliveredFolderRef {
  const namespace = path.posix.dirname(name);

  return { type: 'rules', namespace: namespace === '.' ? null : namespace, name: path.posix.basename(name) };
}

/** Whether `localConfig`'s scope holds a delivered rule folder named `name`. */
async function isDelivered(localConfig: LocalConfig, name: string): Promise<boolean> {
  return pathExists(DeliveredFolders.pathOf(localConfig, refOf({ name })));
}

/** A text file teamai renders, as common rule 12 reads it: CRLF turned into LF, one trailing newline removed. */
function readText(raw: string): string {
  return raw.replaceAll('\r\n', '\n').replace(/\n$/, '');
}

/** A text file of a rule folder, read as common rule 12 says; null when it cannot be read. */
async function readTextFile(file: string): Promise<string | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);

  return raw === null ? null : readText(raw);
}

/**
 * The rule text of `rule` for `language`, before `${TEAMAI_RULE_DIR}` is rendered, ending in one newline: `RULE.md`,
 * or with `language` set and `RULE.<language>.md` in the folder (an exact name, common rule 1), that file's body under
 * the frontmatter of `RULE.md`. Null when a file it needs cannot be read.
 */
async function text(rule: RuleFolder, language: TeamaiConfig['language']): Promise<string | null> {
  const base = await readTextFile(rule.sourcePath);

  if (base === null) return null;
  const dir = path.dirname(rule.sourcePath);
  const variantName = language === undefined ? null : `RULE.${language}.md`;
  const names = variantName === null ? [] : await fs.readdir(dir).catch(() => []);

  if (variantName === null || !names.includes(variantName)) return `${base}\n`;
  const variant = await readTextFile(path.join(dir, variantName));

  if (variant === null) return null;
  const { block, body } = splitRuleFrontmatter(variant);

  if (block !== '') {
    warnOnce(`The frontmatter of ${path.posix.join(path.posix.dirname(rule.relativePath), variantName)} is ignored: every language of a rule folder `
      + `takes the frontmatter of its RULE.md. Move those fields to ${rule.relativePath} in the team repo.`);
  }

  return `${splitRuleFrontmatter(base).block}${body}\n`;
}

/**
 * Where a project's tools that cannot read the data home take a remote team's rule folders: copies in the worktree,
 * named relative to the project root. Null outside a project. In single-repo it is the data home itself.
 */
function copyRootOf(localConfig: LocalConfig): string | null {
  return localConfig.scope === 'project' && localConfig.projectRoot ? path.join(localConfig.projectRoot, '.teamai', DELIVERED_DIR) : null;
}

/** Whether `tool` reads a rule folder's files in the data home without a prompt, once teamai grants what it can. */
function readsDataHome(tool: string): boolean {
  return ruleFolderReachOf(tool).reach !== 'copy';
}

/**
 * `text` with `${TEAMAI_RULE_DIR}` naming where `tool` reads `rule`'s folder in `localConfig`'s scope: the data home
 * when the tool reads it there, and in a project otherwise the worktree's copy, relative to the project root. A
 * user-scope rule has no worktree, so it names the data home for every tool (`sync` warns for the rest). `tool` null:
 * text teamai injects for the tools without native rules, none of which reads the data home.
 */
function render(ruleText: string, at: { readonly localConfig: LocalConfig; readonly rule: RuleFolder; readonly tool: string | null }): string {
  const copyRoot = copyRootOf(at.localConfig);
  const { projectRoot } = at.localConfig;

  if (copyRoot === null || projectRoot === undefined || (at.tool !== null && readsDataHome(at.tool))) {
    return DeliveredFolders.render(ruleText, { type: 'rules', dest: DeliveredFolders.pathOf(at.localConfig, refOf(at.rule)) });
  }

  return DeliveredFolders.render(ruleText, { type: 'rules', dest: path.relative(projectRoot, copyPathOf(copyRoot, refOf(at.rule))) });
}

/** Where `ref` is copied under `copyRoot`. */
function copyPathOf(copyRoot: string, ref: DeliveredFolderRef): string {
  return path.join(copyRoot, ref.type, ...(ref.namespace === null ? [] : [ref.namespace]), ref.name);
}

/**
 * Deliver the folder of each rule folder in `rules` to `localConfig`'s scope and remove the scope's others, recorded
 * in `ledger`. In a remote team's project where one of `tools` (the tools receiving rules) cannot read the data home,
 * the folders are copied into the worktree too; in user scope, each such tool is named once. Throws when a folder
 * cannot be written; the caller keeps what it installed.
 */
async function sync(input: {
  readonly localConfig: LocalConfig;
  readonly rules: readonly ResourceItem[];
  readonly tools: readonly string[];
  readonly ledger: DeliveryLedger | undefined;
}): Promise<void> {
  const { localConfig, ledger } = input;
  const folders: { readonly ref: DeliveredFolderRef; readonly name: string; readonly files: readonly FolderFile[] }[] = [];

  for (const rule of input.rules.filter(isFolder)) {
    const read = await FolderFiles.read(path.dirname(rule.sourcePath));

    if (read.kind === 'files') folders.push({ ref: refOf(rule), name: rule.name, files: read.files });
  }

  const delivered = folders.map(({ ref, files }) => ({ dest: DeliveredFolders.pathOf(localConfig, ref), files }));
  await DeliveredFolders.sync({ localConfig, type: 'rules', folders: delivered, ledger, prune: true });
  const copying = input.tools.filter((tool) => !readsDataHome(tool));
  const copyRoot = copyRootOf(localConfig);

  if (copyRoot === null) {
    for (const tool of folders.length === 0 ? [] : copying) {
      warnOnce(`${tool} may ask before it reads the files of user-scope rule folders in ${DeliveredFolders.root(localConfig)}`
        + `${path.sep}rules (${folders.map(({ name }) => name).join(', ')}): teamai grants it no access there, and a user-scope `
        + 'rule has no project to copy them into. Allow the directory in its settings, or share these rules from a project.');
    }

    return;
  }

  if (isSelfMode(localConfig)) return;
  const copies = copying.length === 0 ? [] : folders.map(({ ref, files }) => ({ dest: copyPathOf(copyRoot, ref), files }));
  await DeliveredFolders.sync({ localConfig, type: 'rules', folders: copies, ledger, prune: true, root: copyRoot });
}

/** A JSON object in a tool's settings file, as far as teamai reads it. */
const SettingsObjectSchema = z.record(z.string(), z.unknown());

/**
 * Keep `dirs` in `permissions.additionalDirectories` of `settingsFile`, a tool's user settings whose rule folder
 * cell is `grant` (Claude Code), so the tool reads the rule folders' files there without a prompt. Appends what is
 * missing after the member's entries, takes back what `previous` (the entries teamai owned) names and `dirs` no longer
 * does, and leaves every other entry where it is. An entry the member already had stays theirs. Returns the entries
 * teamai owns now, for the next run's `previous`. `withdraw` takes back every one, for uninstall. A file that is not
 * a JSON object, or whose `permissions` is not one, is left alone, and `previous` stays owned.
 */
async function grant(input: {
  readonly settingsFile: string;
  readonly dirs: readonly string[];
  readonly previous: readonly string[];
  readonly withdraw?: boolean;
}): Promise<string[]> {
  const desired = input.withdraw ? [] : [...input.dirs];

  if (desired.length === 0 && input.previous.length === 0) return [];
  const read = await readJsonObject(input.settingsFile);
  const settings = read.kind === 'ok' ? read.value : {};
  const permissions = settings.permissions === undefined ? {} : SettingsObjectSchema.safeParse(settings.permissions).data;

  if (read.kind === 'invalid' || permissions === undefined) {
    const why = read.kind === 'invalid' ? `is not valid JSON (${read.error})` : 'has a "permissions" that is not an object';

    if (!input.withdraw) log.warn(`${input.settingsFile} ${why}, so it does not let the tool read the rule folders' files in ${desired.join(', ')}. Fix the file, then run \`teamai pull\`.`);

    return [...input.previous];
  }

  const current = z.array(z.unknown()).safeParse(permissions.additionalDirectories).data ?? [];
  // Only strings are ever stale, so any other entry is kept.
  const stale = new Set<unknown>(input.previous.filter((entry) => !desired.includes(entry)));
  const kept = current.filter((entry) => !stale.has(entry));
  const next = [...kept, ...desired.filter((entry) => !kept.includes(entry))];
  const owned = desired.filter((entry) => input.previous.includes(entry) || !current.includes(entry));

  if (JSON.stringify(next) === JSON.stringify(current)) return owned;
  // In place when kept, so the member's file keeps its order.
  const { additionalDirectories: _dirs, ...otherPermissions } = permissions;
  const nextPermissions = next.length > 0 ? { ...permissions, additionalDirectories: next } : otherPermissions;
  const { permissions: _permissions, ...otherSettings } = settings;

  await writeJson(input.settingsFile, Object.keys(nextPermissions).length > 0 ? { ...settings, permissions: nextPermissions } : otherSettings);

  return owned;
}

export const RuleFolders = { isFolder, isDelivered, text, render, sync, grant } as const;
