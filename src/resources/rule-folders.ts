/**
 * Rule folders (#1787): `rules/[<ns>/]<name>/RULE.md` and the support files beside it. Each tool still receives one
 * rule file, `<name><ext>`, whose text names the folder through `${TEAMAI_RULE_DIR}`; pull renders that to where the
 * tool reads the folder's files, and delivers the folder there (`DeliveredFolders`, common rule 9).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DeliveryLedger } from './delivered-copies.js';
import { DeliveredFolders, type DeliveredFolderRef, type FolderDelivery } from './delivered-folders.js';
import { FolderFiles, type FolderFile } from './folder-files.js';
import { isLanguageVariant, RESOURCE_LAYOUTS, type ResourceDiagnostic } from './resolver.js';
import { splitRuleFrontmatter } from './team-rule.js';
import { toolPathUnder } from '../locate.js';
import { realHost } from '../tool-home.js';
import { folderReachOf } from '../tool-registry.js';
import { scopedToolPaths, type LocalConfig, type ResourceItem, type TeamaiConfig } from '../types.js';
import { pathExists, readJsonObject, writeJson } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { warnOnce } from '../utils/warn-once.js';

/** The marker and base text of a rule folder. */
const RESOURCE_MARKER = RESOURCE_LAYOUTS.rules.marker;

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

/** Where pull delivers the rule folder named `name` in `localConfig`'s scope. */
function pathOf(localConfig: LocalConfig, name: string): string {
  return DeliveredFolders.pathOf(localConfig, refOf({ name }));
}

/** Whether `localConfig`'s scope holds a delivered rule folder named `name`. */
async function isDelivered(localConfig: LocalConfig, name: string): Promise<boolean> {
  return pathExists(pathOf(localConfig, name));
}

/** A text file of a rule folder, read as common rule 12 says; null when it cannot be read. */
async function readTextFile(file: string): Promise<string | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);

  return raw === null ? null : FolderFiles.text(raw);
}

/**
 * The file of `dir` that holds the text `stem` in `language` (common rule 12): `<stem>.<language>.md` when `language`
 * is set and the folder holds that exact name, else `<stem>.md`.
 */
async function languageFile(dir: string, stem: string, language: TeamaiConfig['language']): Promise<string> {
  const variant = language === undefined ? null : `${stem}.${language}.md`;

  return variant !== null && (await fs.readdir(dir).catch((): string[] => [])).includes(variant) ? variant : `${stem}.md`;
}

/** What pull says about the frontmatter of `rule`'s language variant `variantName`, which it ignores. */
function variantFrontmatterMessage(rule: RuleFolder, variantName: string): string {
  return `The frontmatter of ${path.posix.join(path.posix.dirname(rule.relativePath), variantName)} is ignored: every language of a rule folder `
    + `takes the frontmatter of its RULE.md. Move those fields to ${rule.relativePath} in the team repo.`;
}

/** A note for each language variant among `files` (`RULE.<lang>.md`, common rule 12) of `rule` that carries frontmatter, which pull ignores. */
function variantNotes(rule: RuleFolder, files: readonly FolderFile[]): ResourceDiagnostic[] {
  return files.flatMap((file): ResourceDiagnostic[] => {
    if (!isLanguageVariant(RESOURCE_MARKER, file.path) || splitRuleFrontmatter(FolderFiles.text(file.bytes.toString('utf8'))).block === '') return [];

    return [{ kind: 'note', path: path.posix.join(path.posix.dirname(rule.relativePath), file.path), message: variantFrontmatterMessage(rule, file.path) }];
  });
}

/**
 * The rule text of `rule` for `language`, before `${TEAMAI_RULE_DIR}` is rendered, ending in one newline: `RULE.md`,
 * or its language variant's body under the frontmatter of `RULE.md` (`languageFile`). Null when a file it needs
 * cannot be read.
 */
async function text(rule: RuleFolder, language: TeamaiConfig['language']): Promise<string | null> {
  const base = await readTextFile(rule.sourcePath);

  if (base === null) return null;
  const dir = path.dirname(rule.sourcePath);
  const variantName = await languageFile(dir, 'RULE', language);

  if (variantName === RESOURCE_MARKER) return composeText({ rule, base, variant: null });
  const variant = await readTextFile(path.join(dir, variantName));

  return variant === null ? null : composeText({ rule, base, variant: { name: variantName, content: variant } });
}

/** The rule text of `rule` from its `RULE.md` text and the language variant picked for it, if any, as `text` gives it. */
function composeText(input: { readonly rule: RuleFolder; readonly base: string; readonly variant: { readonly name: string; readonly content: string } | null }): string {
  if (input.variant === null) return `${input.base}\n`;
  const { block, body } = splitRuleFrontmatter(input.variant.content);

  if (block !== '') warnOnce(variantFrontmatterMessage(input.rule, input.variant.name));

  return `${splitRuleFrontmatter(input.base).block}${body}\n`;
}

/** Whether `tool` reads a rule folder's files outside the project without a prompt, once teamai grants what it can. */
function readsOutsideProject(tool: string): boolean {
  return folderReachOf(tool).reach !== 'copy';
}

/** `text` with `${TEAMAI_RULE_DIR}` naming `rule`'s folder where `tool` reads it (`DeliveredFolders.renderFor`; `sync` warns for the tools that cannot read it). */
function render(ruleText: string, at: { readonly localConfig: LocalConfig; readonly rule: RuleFolder; readonly tool: string | null }): string {
  return DeliveredFolders.renderFor(ruleText, { localConfig: at.localConfig, ref: refOf(at.rule), tool: at.tool });
}

/**
 * Deliver the folder of each rule folder in `rules` to `localConfig`'s scope, recorded in `ledger`. In user scope, each
 * of `tools` (the tools receiving rules) that cannot read the data home is named once. A folder keeps the files an
 * earlier version had, which a copy the member edited may still name (`DeliveredFolders.deliverAll`). Throws when a
 * folder cannot be written; the caller keeps what it installed. Returns the removal of the scope's other folders, which
 * the caller runs once its stale sweep is done, with the rules a tool still holds a copy of: their folders stay, so the
 * text still names files that exist.
 */
async function sync(input: {
  readonly localConfig: LocalConfig;
  readonly rules: readonly ResourceItem[];
  readonly tools: readonly string[];
  readonly ledger: DeliveryLedger | undefined;
}): Promise<(heldByCopies: readonly string[]) => Promise<void>> {
  const { localConfig, ledger } = input;
  const folders: Array<FolderDelivery & { readonly name: string }> = [];

  for (const rule of input.rules.filter(isFolder)) {
    const read = await FolderFiles.read(path.dirname(rule.sourcePath));

    if (read.kind === 'files') folders.push({ dest: DeliveredFolders.pathOf(localConfig, refOf(rule)), name: rule.name, files: read.files, earlierFiles: 'keep' });
  }

  if (DeliveredFolders.worktreeRoot(localConfig) === null) {
    for (const tool of folders.length === 0 ? [] : input.tools.filter((name) => !readsOutsideProject(name))) {
      warnOnce(`${tool} may ask before it reads the files of user-scope rule folders in ${DeliveredFolders.root(localConfig, 'rules')}`
        + `${path.sep}rules (${folders.map(({ name }) => name).join(', ')}): teamai grants it no access there, and a user-scope `
        + 'rule has no project to copy them into. Allow the directory in its settings, or share these rules from a project.');
    }
  }

  await DeliveredFolders.sync({ localConfig, type: 'rules', folders, ledger, prune: false });

  return async (heldByCopies) => {
    await DeliveredFolders.prune({ localConfig, type: 'rules', keep: [...folders.map(({ dest }) => dest), ...heldByCopies.map((name) => pathOf(localConfig, name))], ledger });
  };
}

/** The rule folders delivered in `localConfig`'s scope, by name (`api-style`, `fe/api-style`): each directory holding a `RULE.md`. */
async function deliveredNames(localConfig: LocalConfig): Promise<string[]> {
  const rulesRoot = path.join(DeliveredFolders.root(localConfig, 'rules'), 'rules');
  const names: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (await pathExists(path.join(dir, entry.name, RESOURCE_MARKER))) names.push(name);
      else await walk(path.join(dir, entry.name), name);
    }
  };

  await walk(rulesRoot, '');

  return names;
}

/**
 * The user settings file of `tool` that `grant` edits: its configured settings path under the home, where the root
 * `toolRoots` records (Claude Code's `CLAUDE_CONFIG_DIR`) or an instance's home moves it, as its hooks find it.
 */
function grantSettingsFile(input: { tool: string; teamConfig: Pick<TeamaiConfig, 'toolPaths'>; localConfig: LocalConfig }): string | null {
  const { tool, teamConfig, localConfig } = input;
  const settings = scopedToolPaths(teamConfig, { ...localConfig, scope: 'user' })[tool]?.settings;
  const host = realHost();

  return settings ? toolPathUnder(tool, host.home, settings, host) : null;
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

export const RuleFolders = { isFolder, pathOf, isDelivered, deliveredNames, languageFile, readTextFile, text, composeText, variantNotes, render, sync, grant, grantSettingsFile } as const;
