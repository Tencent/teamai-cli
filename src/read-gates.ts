/**
 * Whether a tool reads what teamai delivered to a project, by the tool's own
 * verdict on that project: its trust, or its approval of the project's MCP
 * servers. `locate` declares each gate (`ReadGate`); this module evaluates
 * it. Read-only: it never grants a verdict.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { getAgentVersion } from './agent-version.js';
import type { ReadGate } from './locate.js';
import { codexProjectTrust, codexTrustFix } from './codex-project-trust.js';
import { realFilePath } from './git-exclude.js';
import { isJsonObject, type JsonObject, type JsonValue } from './types.js';
import { pathExists, readFileIfExists } from './utils/fs.js';
import { mapStrings, parseJson } from './utils/json.js';

/**
 * What teamai holds in the gated place. `summary` opens the fix
 * ("<place> holds team agents (a, b)"), `noun` names the resource, and
 * `names` are the team's items there.
 */
export type Held = { readonly summary: string; readonly noun: string; readonly names: readonly string[] };

/**
 * What the tool answers for the held resource. `unanswered`: the tool has not
 * asked yet, and asks the first time the member opens it here, so doctor warns
 * without failing. `blocked`: the member or a setting said no, or the answer
 * cannot be read, so opening the tool changes nothing and doctor fails.
 */
export type ReadGateVerdict =
  | { readonly kind: 'met' }
  | { readonly kind: 'unanswered'; readonly fix: string }
  | { readonly kind: 'blocked'; readonly fix: string };

const MET: ReadGateVerdict = { kind: 'met' };

/** The doctor check's name: what the gate decides for the held resource. */
export function readGateCheckName(gate: ReadGate, noun: string): string {
  switch (gate.kind) {
    case 'codex-project-trust':
      return `Codex trusts this project, so it loads its team ${noun}`;
    case 'pi-project-trust':
      return `Pi trusts this project, so it loads its team ${noun}`;
    case 'muse-workspace-trust':
      return `Muse Code trusts this project, so it loads its team ${noun}`;
    case 'copilot-folder-trust':
      return `Copilot CLI trusts this folder, so it loads its team ${noun}`;
    case 'qoder-folder-trust':
      return `Qoder CLI trusts this folder, so it loads its team ${noun}`;
    case 'qoder-mcp-approval':
      return 'Qoder CLI approves this project\'s team MCP servers';
    case 'claude-mcp-approval':
      return 'Claude Code approves this project\'s team MCP servers';
    case 'codebuddy-mcp-approval':
      return 'CodeBuddy Code approves this project\'s team MCP servers';
    case 'cursor-mcp-approval':
      return 'Cursor CLI approves this project\'s team MCP servers';
    case 'claude-hooks-enabled':
      return 'Claude Code has not turned hooks off with disableAllHooks';
    case 'openclaw-hooks-enabled':
      return 'OpenClaw hook enabled';
    case 'openclaw-plugins-enabled':
      return 'OpenClaw loads teamai\'s team hooks plugin';
    default: {
      const unhandled: never = gate;

      return unhandled;
    }
  }
}

export async function readGateVerdict(gate: ReadGate, held: Held): Promise<ReadGateVerdict> {
  switch (gate.kind) {
    case 'codex-project-trust': {
      const trust = await codexProjectTrust(gate);

      return trust.kind === 'trusted'
        ? MET
        : {
          // Codex asks about a checkout that no entry decides; an entry that does, or a config it cannot read, it does not.
          kind: trust.kind === 'untrusted' && !trust.decidedBy ? 'unanswered' : 'blocked',
          fix: codexTrustFix(trust, gate, `${held.summary}, but Codex loads a project's ${held.noun} only in a trusted project`),
        };
    }

    case 'pi-project-trust':
      return piProjectTrust(gate, `${held.summary}, but Pi loads a project's ${held.noun} only in a trusted project`);
    case 'muse-workspace-trust':
      return museWorkspaceTrust(gate, `${held.summary}, but Muse Code loads a project's ${held.noun} only in a trusted workspace`);
    case 'copilot-folder-trust':
      return copilotFolderTrust(gate, `${held.summary}, but Copilot CLI loads a repository's ${held.noun} only in a trusted folder`);
    case 'qoder-folder-trust':
      return qoderFolderTrust(gate, `${held.summary}, but an interactive Qoder CLI session loads a project's ${held.noun} only in a trusted folder`);
    case 'qoder-mcp-approval':
      return qoderMcpApproval(gate, held);
    case 'claude-mcp-approval':
      return claudeMcpApproval(gate, held);
    case 'codebuddy-mcp-approval':
      return codebuddyMcpApproval(gate, held);
    case 'cursor-mcp-approval':
      return cursorMcpApproval(gate, held);
    case 'claude-hooks-enabled':
      return claudeHooksEnabled(gate, `${held.summary}, but Claude Code runs no hooks while the settings that decide set disableAllHooks`);
    case 'openclaw-hooks-enabled':
      return openclawHooksEnabled(gate, `${held.summary}, but OpenClaw loads a workspace hook only once openclaw.json enables its entry`);
    case 'openclaw-plugins-enabled':
      return openclawPluginLoaded(gate, `${held.summary}, but OpenClaw runs a plugin only once openclaw.json loads and enables it`);
    default: {
      const unhandled: never = gate;

      return unhandled;
    }
  }
}

/** `question`: what the file would have answered ("Pi trusts this project"). */
function unreadable({ cause, file, reason, question }: { cause: string; file: string; reason: string; question: string }): ReadGateVerdict {
  return {
    kind: 'blocked',
    fix: `${cause}, and ${file} ${reason}, so whether ${question} is unknown. Fix ${file}, then run \`teamai doctor\` again.`,
  };
}

/** The directory and each one above it, nearest first. */
function upFrom(dir: string): string[] {
  const dirs = [dir];

  for (let parent = path.dirname(dir); parent !== dirs[dirs.length - 1]; parent = path.dirname(parent)) dirs.push(parent);

  return dirs;
}

/**
 * Pi 1.4.0: the nearest `true` or `false` entry of trust.json, walking up from
 * the real path of the directory Pi starts in, decides; with none,
 * `defaultProjectTrust` does ("always", "never", else Pi asks, and `pi -p`
 * takes that as untrusted). A value other than a boolean or null stops Pi.
 * Pi before 0.79.0 has no project trust and loads them all.
 */
async function piProjectTrust(gate: Extract<ReadGate, { kind: 'pi-project-trust' }>, cause: string): Promise<ReadGateVerdict> {
  const version = semver.valid(await getAgentVersion('pi'));

  if (version !== null && semver.lt(version, '0.79.0')) return MET;
  const root = await realFilePath(gate.checkout);
  const trust = await readStore(gate.config);

  if (trust.kind === 'unreadable') return unreadable({ cause, file: gate.config, reason: trust.reason, question: 'Pi trusts this project' });
  const entries = trust.kind === 'ok' ? trust.value : {};
  const invalidEntry = Object.entries(entries).find(([, value]) => value !== true && value !== false && value !== null);

  if (invalidEntry) return unreadable({ cause, file: gate.config, reason: `holds ${JSON.stringify(invalidEntry[1])} for ${invalidEntry[0]}, where Pi takes true, false or null`, question: 'Pi trusts this project' });
  const grant = `add ${JSON.stringify(root)}: true to ${gate.config}`;

  for (const dir of upFrom(root)) {
    const value = entries[dir];

    if (value === true) return MET;

    if (value === false) {
      return { kind: 'blocked', fix: `${cause}, and ${gate.config} sets ${JSON.stringify(dir)}: false, the entry Pi reads for ${root}. Set it to true, or ${grant}.` };
    }
  }

  const settings = await readStore(gate.settings);

  if (settings.kind === 'unreadable') return unreadable({ cause, file: gate.settings, reason: settings.reason, question: 'Pi trusts this project' });
  const fallback = settings.kind === 'ok' ? settings.value.defaultProjectTrust : undefined;

  if (fallback === 'always') return MET;

  if (fallback === 'never') {
    return { kind: 'blocked', fix: `${cause}, and ${gate.settings} sets defaultProjectTrust to "never" while ${gate.config} has no entry for ${root}. To trust this project only, ${grant}.` };
  }

  return {
    kind: 'unanswered',
    fix: `${cause}, and ${gate.config} has no entry for ${root} or a folder above it. Start \`pi\` in ${root} and choose Trust, `
      + `or ${grant}. Until then a headless run (\`pi -p\`) skips them.`,
  };
}

/**
 * Muse Code 1.4.14: the entry for the real path of the checkout's own git
 * root decides, exactly (no parent, and a linked worktree is its own); a store
 * Muse cannot parse fails closed to untrusted. `muse exec` runs an undecided
 * workspace untrusted.
 */
async function museWorkspaceTrust(gate: Extract<ReadGate, { kind: 'muse-workspace-trust' }>, cause: string): Promise<ReadGateVerdict> {
  const { resolveAnchors } = await import('./utils/git.js');
  const target = (await resolveAnchors(gate.checkout))?.workspaceRoot ?? await realFilePath(gate.checkout);
  const grant = `add ${JSON.stringify(target)}: {"decision": "trusted"} under "projects" in ${gate.config}, beside "schema_version": 1`;
  const store = await readStore(gate.config);

  if (store.kind === 'unreadable') return unreadable({ cause, file: gate.config, reason: store.reason, question: 'Muse Code trusts this project' });

  if (store.kind === 'ok') {
    const { schema_version: version, projects } = store.value;

    if (version !== 1) return unreadable({ cause, file: gate.config, reason: `has schema_version ${JSON.stringify(version)}, where Muse Code takes 1`, question: 'Muse Code trusts this project' });
    const decision = fieldOf(fieldOf(projects, target), 'decision');

    if (decision === 'trusted') return MET;

    if (decision === 'untrusted') {
      return { kind: 'blocked', fix: `${cause}, and ${gate.config} records "untrusted" for ${target}, so Muse Code never asks again. Set that decision to "trusted".` };
    }

    if (decision !== undefined) return unreadable({ cause, file: gate.config, reason: `holds the decision ${JSON.stringify(decision)} for ${target}, where Muse Code takes "trusted" or "untrusted"`, question: 'Muse Code trusts this project' });
  }

  return {
    kind: 'unanswered',
    fix: `${cause}, and ${gate.config} has no decision for ${target}. Start \`muse\` in ${target} and choose "Trust and continue", `
      + `or ${grant}. Each worktree needs its own entry. Until then \`muse exec\` skips them.`,
  };
}

/**
 * Copilot CLI 1.0.105: an entry of `trustedFolders` (or the older
 * `trusted_folders`) covers its folder and every folder under it, by real
 * path; a linked worktree takes its main checkout's trust. Copilot heads
 * config.json with `//` comment lines.
 */
async function copilotFolderTrust(gate: Extract<ReadGate, { kind: 'copilot-folder-trust' }>, cause: string): Promise<ReadGateVerdict> {
  const { resolveAnchors } = await import('./utils/git.js');
  const root = await realFilePath(gate.checkout);
  const main = (await resolveAnchors(gate.checkout))?.mainCheckout ?? root;
  const config = await readStore(gate.config, { comments: true });

  if (config.kind === 'unreadable') return unreadable({ cause, file: gate.config, reason: config.reason, question: 'Copilot CLI trusts this project' });
  const folders = config.kind === 'ok' ? [config.value.trustedFolders, config.value.trusted_folders].flatMap(stringsIn) : [];

  for (const folder of folders) {
    const real = await realFilePath(folder);

    if ([root, main].some((dir) => isAtOrUnder(dir, real))) return MET;
  }

  return {
    kind: 'unanswered',
    fix: `${cause}, and no folder in "trustedFolders" of ${gate.config} covers ${main}. Start \`copilot\` in ${main} and choose `
      + `"Yes, and remember this folder for future sessions", or add ${JSON.stringify(main)} to "trustedFolders" in ${gate.config}. `
      + 'Trusting the main checkout covers every worktree of it. Until then `copilot -p` skips them unless it runs with `--trust-folder`.',
  };
}

function isAtOrUnder(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);

  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** A tool's own trust or approval store: absent, there but unreadable (and why), or its object. */
type StoreRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'ok'; readonly value: JsonObject };

/**
 * Only an absent store means the tool has not asked yet; one that is there
 * but cannot be read or parsed leaves its verdict unknown. `comments` drops
 * the `//` lines Copilot heads config.json with; `notJson` words a parse failure.
 */
async function readStore(
  file: string,
  { comments = false, notJson = (error: string) => `does not parse (${error})` }: { comments?: boolean; notJson?: (error: string) => string } = {},
): Promise<StoreRead> {
  let raw: string | null;

  try {
    raw = await readFileIfExists(file);
  } catch (error) {
    return { kind: 'unreadable', reason: `cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }

  if (raw === null) return { kind: 'missing' };
  const body = comments ? raw.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('//')).join('\n') : raw;

  try {
    const value = parseJson(body);

    return isJsonObject(value)
      ? { kind: 'ok', value }
      : { kind: 'unreadable', reason: notJson('not a JSON object') };
  } catch (error) {
    return { kind: 'unreadable', reason: notJson(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Qoder CLI 1.1.81: an entry of `permissions.trustDirectories` (or
 * `permissions.additionalDirectories`) in the user settings covers its folder
 * and every folder under it, by real path; `security.folderTrust.enabled:
 * false` turns the check off. A project's own settings cannot trust it, and
 * `qodercli -p` takes every folder as trusted.
 */
async function qoderFolderTrust(gate: Extract<ReadGate, { kind: 'qoder-folder-trust' }>, cause: string): Promise<ReadGateVerdict> {
  const root = await realFilePath(gate.checkout);
  const settings = await readStore(gate.config);

  if (settings.kind === 'unreadable') return unreadable({ cause, file: gate.config, reason: settings.reason, question: 'Qoder CLI trusts this folder' });
  const value = settings.kind === 'ok' ? settings.value : {};

  if (fieldOf(fieldOf(fieldOf(value, 'security'), 'folderTrust'), 'enabled') === false) return MET;
  const permissions = fieldOf(value, 'permissions');
  const folders = [fieldOf(permissions, 'trustDirectories'), fieldOf(permissions, 'additionalDirectories')].flatMap(stringsIn);

  for (const folder of folders) {
    if (isAtOrUnder(root, await realFilePath(folder))) return MET;
  }

  return {
    kind: 'unanswered',
    fix: `${cause}, and permissions.trustDirectories in ${gate.config} does not cover ${root}. Start \`qodercli\` in ${root} and trust the folder `
      + `when it asks, or add ${JSON.stringify(root)} to permissions.trustDirectories in ${gate.config}. \`qodercli -p\` loads them either way.`,
  };
}

/** `object[key]` of a parsed JSON value, or undefined when it is not an object. */
function fieldOf(object: JsonValue | undefined, key: string): JsonValue | undefined {
  return isJsonObject(object) ? Object.entries(object).find(([name]) => name === key)?.[1] : undefined;
}

/** The team's servers a tool holds back: `rejected` it never starts, `pending` it starts once approved. */
type Approval = { readonly rejected: readonly string[]; readonly pending: readonly string[] };

/** A verdict from `approval`: `approve` says how to approve, `undo` how to lift a rejection. */
function approvalVerdict({ cause, approval, approve, undo }: { cause: string; approval: Approval; approve: string; undo: string }): ReadGateVerdict {
  const { rejected, pending } = approval;

  if (rejected.length === 0 && pending.length === 0) return MET;

  const parts = [
    ...pending.length === 0 ? [] : [`${pending.join(', ')} ${pending.length === 1 ? 'waits' : 'wait'} for approval`],
    ...rejected.length === 0 ? [] : [`${rejected.join(', ')} ${rejected.length === 1 ? 'was' : 'were'} rejected`],
  ];

  // A rejection stays until someone lifts it; a server only waiting is asked about when the member opens the tool.
  return { kind: rejected.length > 0 ? 'blocked' : 'unanswered', fix: `${cause}, and ${parts.join(', and ')}. ${[...pending.length === 0 ? [] : [approve], ...rejected.length === 0 ? [] : [undo]].join(' ')}` };
}

/** Approval kept as name lists: `disabled` rejects, `enabled` or `all` approves, and the rest wait. */
function listedApproval(
  names: readonly string[],
  { enabled, disabled, all }: { enabled: ReadonlySet<string>; disabled: ReadonlySet<string>; all: boolean },
): Approval {
  return {
    rejected: names.filter((name) => disabled.has(name)),
    pending: names.filter((name) => !disabled.has(name) && !all && !enabled.has(name)),
  };
}

/**
 * Claude Code 2.1.316: the first of the checkout's .claude/settings.local.json,
 * its .claude/settings.json and the user settings.json that sets
 * `disableAllHooks` decides (`claude -p` runs no hook while it is true).
 * Managed policy, which can also turn hooks off, is not read.
 */
async function claudeHooksEnabled(gate: Extract<ReadGate, { kind: 'claude-hooks-enabled' }>, cause: string): Promise<ReadGateVerdict> {
  const files = [path.join(gate.checkout, '.claude', 'settings.local.json'), path.join(gate.checkout, '.claude', 'settings.json'), gate.settings];

  for (const file of files) {
    const settings = await readStore(file);

    if (settings.kind === 'unreadable') return unreadable({ cause, file, reason: settings.reason, question: 'Claude Code runs hooks' });
    const disabled = settings.kind === 'ok' ? settings.value.disableAllHooks : undefined;

    if (disabled === true) return { kind: 'blocked', fix: `${cause}, and ${file} sets it. Remove "disableAllHooks" from ${file}, or set it to false.` };

    if (disabled === false) return MET;
  }

  return MET;
}

/** Cursor CLI 2026.10.21's interpolation, over every string of an MCP entry: an unset name stays as written. */
const CURSOR_PLACEHOLDER = /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|([^:}]+)(?::-([^}]*))?)\}/g;

function withCursorEnv(value: JsonValue): JsonValue {
  return mapStrings(value, (text) => text.replace(CURSOR_PLACEHOLDER, (whole, envName: string | undefined, name: string | undefined, fallback: string | undefined) =>
    envName !== undefined ? process.env[envName] ?? whole : name === undefined ? whole : process.env[name] ?? fallback ?? whole));
}

/** A string-list value; an item that is not a string reads as null. */
const NamesSchema = z.array(z.string().nullable().catch(null)).catch([]);

/** The strings in a string-list value, in order. */
function stringsIn(list: JsonValue | undefined): string[] {
  return NamesSchema.parse(list).filter((name) => name !== null);
}

/** Names in a string-list value, as a set. */
function namesIn(list: JsonValue | undefined): Set<string> {
  return new Set(stringsIn(list));
}

/**
 * Qoder CLI 1.1.81: a server in `mcp.disabledProjectMcpServers` of the user,
 * project or local settings is rejected, even in `qodercli -p`; one in
 * `mcp.enabledProjectMcpServers`, or any with `mcp.enableAllProjectMcpServers`,
 * is approved; the rest wait for the dialog of an interactive session, while
 * `-p` starts them. Approval is by name, in every project.
 */
async function qoderMcpApproval(gate: Extract<ReadGate, { kind: 'qoder-mcp-approval' }>, held: Held): Promise<ReadGateVerdict> {
  const cause = `${held.summary}, but Qoder CLI starts a project's servers in an interactive session only once you approve them`;
  const files = [gate.config, path.join(gate.checkout, '.qoder', 'settings.json'), path.join(gate.checkout, '.qoder', 'settings.local.json')];
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  let all = false;

  for (const file of files) {
    const settings = await readStore(file);

    if (settings.kind === 'unreadable') return unreadable({ cause, file, reason: settings.reason, question: 'Qoder CLI approved these servers' });
    const mcp = settings.kind === 'ok' ? fieldOf(settings.value, 'mcp') : undefined;

    for (const name of namesIn(fieldOf(mcp, 'enabledProjectMcpServers'))) enabled.add(name);

    for (const name of namesIn(fieldOf(mcp, 'disabledProjectMcpServers'))) disabled.add(name);
    all ||= fieldOf(mcp, 'enableAllProjectMcpServers') === true;
  }

  return approvalVerdict({
    cause,
    approval: listedApproval(held.names, { enabled, disabled, all }),
    approve: `Approve them when an interactive \`qodercli\` asks, or add them to mcp.enabledProjectMcpServers in ${gate.config}.`,
    undo: `Remove the rejected ones from mcp.disabledProjectMcpServers in ${files.join(', ')}, or run \`qodercli mcp reset-project-choices\` to be asked again.`,
  });
}

/**
 * Claude Code 2.1.316: a server in `disabledMcpjsonServers` of any settings
 * file is rejected. One in `enabledMcpjsonServers`, or any with
 * `enableAllProjectMcpServers`, is approved by ~/.claude/settings.json always,
 * and by the project's settings.json and the main checkout's
 * settings.local.json (where the dialog writes, a worktree's own as an older
 * layer) only once ~/.claude.json trusts the main checkout. Keys an earlier
 * Claude Code kept in that `projects` entry count as the local settings, where
 * its next start moves them. An interactive session waits for the rest;
 * `claude -p` starts them.
 */
async function claudeMcpApproval(gate: Extract<ReadGate, { kind: 'claude-mcp-approval' }>, held: Held): Promise<ReadGateVerdict> {
  const cause = `${held.summary}, but Claude Code starts a project's .mcp.json servers in an interactive session only once you approve them`;
  const { resolveAnchors } = await import('./utils/git.js');
  const root = await realFilePath(gate.checkout);
  const main = (await resolveAnchors(gate.checkout))?.mainCheckout ?? root;
  const config = await readStore(gate.config);

  if (config.kind === 'unreadable') return unreadable({ cause, file: gate.config, reason: config.reason, question: 'Claude Code approved these servers' });
  const entry = fieldOf(fieldOf(config.kind === 'ok' ? config.value : {}, 'projects'), main);
  const trusted = fieldOf(entry, 'hasTrustDialogAccepted') === true;
  const local = path.join(main, '.claude', 'settings.local.json');

  const sources: { readonly file: string; readonly counts: boolean; readonly value?: JsonValue }[] = [
    { file: gate.settings, counts: true },
    { file: path.join(root, '.claude', 'settings.json'), counts: trusted },
    { file: local, counts: trusted },
    ...root === main ? [] : [{ file: path.join(root, '.claude', 'settings.local.json'), counts: trusted }],
    { file: gate.config, counts: trusted, value: entry },
  ];

  const enabled = new Set<string>();
  const rejectedIn = new Set<string>();
  const disabled = new Set<string>();
  let all = false;

  for (const source of sources) {
    let value = source.value;

    if (value === undefined && source.file !== gate.config) {
      const settings = await readStore(source.file);

      if (settings.kind === 'unreadable') return unreadable({ cause, file: source.file, reason: settings.reason, question: 'Claude Code approved these servers' });
      value = settings.kind === 'ok' ? settings.value : undefined;
    }

    const off = namesIn(fieldOf(value, 'disabledMcpjsonServers'));

    if (held.names.some((name) => off.has(name))) rejectedIn.add(source.file);

    for (const name of off) disabled.add(name);

    if (!source.counts) continue;

    for (const name of namesIn(fieldOf(value, 'enabledMcpjsonServers'))) enabled.add(name);
    all ||= fieldOf(value, 'enableAllProjectMcpServers') === true;
  }

  const how = trusted
    ? `Approve them when an interactive \`claude\` in ${main} lists new MCP servers, or add them to enabledMcpjsonServers in ${local}. \`claude -p\` starts them either way.`
    : `${gate.config} does not trust ${main}, so only enabledMcpjsonServers in ${gate.settings} can approve them now. `
      + `Start \`claude\` in ${main}, accept the trust dialog and approve them when it lists new MCP servers, or add them to enabledMcpjsonServers in ${gate.settings}. `
      + '`claude -p` starts them either way.';

  return approvalVerdict({
    cause,
    approval: listedApproval(held.names, { enabled, disabled, all }),
    approve: how,
    undo: `Remove the rejected ones from disabledMcpjsonServers in ${[...rejectedIn].join(', ')}; \`claude mcp reset-project-choices\` in ${main} clears the local settings' choices.`,
  });
}

/**
 * CodeBuddy Code 2.179.1: the project's settings.local.json alone decides. A
 * server in `disabledMcpjsonServers` is rejected; one in
 * `enabledMcpjsonServers`, or any with `enableAllProjectMcpServers`, is
 * approved; the rest wait, in `codebuddy -p` too.
 */
async function codebuddyMcpApproval(gate: Extract<ReadGate, { kind: 'codebuddy-mcp-approval' }>, held: Held): Promise<ReadGateVerdict> {
  const cause = `${held.summary}, but CodeBuddy Code starts a project's .mcp.json servers only once you approve them`;
  const settings = await readStore(gate.config);

  if (settings.kind === 'unreadable') return unreadable({ cause, file: gate.config, reason: settings.reason, question: 'CodeBuddy Code approved these servers' });
  const value = settings.kind === 'ok' ? settings.value : {};
  const enabled = namesIn(fieldOf(value, 'enabledMcpjsonServers'));
  const disabled = namesIn(fieldOf(value, 'disabledMcpjsonServers'));
  const all = fieldOf(value, 'enableAllProjectMcpServers') === true;

  return approvalVerdict({
    cause,
    approval: listedApproval(held.names, { enabled, disabled, all }),
    approve: `Start \`codebuddy\` in ${gate.checkout} and choose "Use this MCP server", or add them to enabledMcpjsonServers in ${gate.config}.`,
    undo: `Remove the rejected ones from disabledMcpjsonServers in ${gate.config}.`,
  });
}

/**
 * Cursor CLI 2026.10.21 keeps a project's verdicts in
 * `<config>/<slug of the real git root>/`: `mcp-disabled.json` lists the names
 * it never loads or asks about again, and `mcp-approvals.json` holds
 * `<name>-<16 hex>`: sha256 of `{ path: <root>, server: <entry> }` as JSON,
 * over the root's `.cursor/mcp.json` entry. With no approvals file the CLI
 * approves nothing; until the CLI has run on this machine (its
 * `cli-config.json`) the member is taken to be on the Cursor IDE, whose own
 * approvals are not read. The CLI hashes an entry after resolving its
 * `${env:NAME}`, `${NAME}` and `${NAME:-default}` with the env of the shell
 * it runs in; doctor resolves them with its own.
 */
async function cursorMcpApproval(gate: Extract<ReadGate, { kind: 'cursor-mcp-approval' }>, held: Held): Promise<ReadGateVerdict> {
  const cause = `${held.summary}, but the Cursor CLI loads a project's servers only once you approve them`;
  const { resolveAnchors } = await import('./utils/git.js');
  const root = (await resolveAnchors(gate.checkout))?.workspaceRoot ?? await realFilePath(gate.checkout);
  const dir = path.join(gate.projects, root.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''));
  const lists: Record<'disabled' | 'approvals', Set<string> | null> = { disabled: null, approvals: null };

  for (const [key, file] of [['disabled', 'mcp-disabled.json'], ['approvals', 'mcp-approvals.json']] as const) {
    let raw: string | null;

    try {
      raw = await readFileIfExists(path.join(dir, file));
    } catch (error) {
      return unreadable({ cause, file: path.join(dir, file), reason: `cannot be read (${error instanceof Error ? error.message : String(error)})`, question: 'the Cursor CLI approved these servers' });
    }

    if (raw === null) continue;

    try {
      lists[key] = namesIn(parseJson(raw));
    } catch (error) {
      return unreadable({ cause, file: path.join(dir, file), reason: `does not parse (${error instanceof Error ? error.message : String(error)})`, question: 'the Cursor CLI approved these servers' });
    }
  }

  const { disabled } = lists;
  const cliHasRun = await pathExists(gate.cliConfig);
  const approvals = lists.approvals ?? (cliHasRun ? new Set<string>() : null);
  const project = await readStore(path.join(root, '.cursor', 'mcp.json'));
  const servers = project.kind === 'ok' ? fieldOf(project.value, 'mcpServers') : undefined;

  const approved = (name: string): boolean => {
    const server = fieldOf(servers, name);

    if (server === undefined) return false;
    const hash = createHash('sha256').update(JSON.stringify({ path: root, server: withCursorEnv(server) })).digest('hex').slice(0, 16);

    return approvals?.has(`${name}-${hash}`) === true;
  };

  const rejected = held.names.filter((name) => disabled?.has(name));
  const pending = approvals === null ? [] : held.names.filter((name) => !rejected.includes(name) && !approved(name));
  const enable = (names: readonly string[]): string => names.map((name) => `\`cursor-agent mcp enable ${name}\``).join(', ');
  const readsEnv = pending.some((name) => JSON.stringify(fieldOf(servers, name) ?? null).includes('${'));
  const envNote = readsEnv ? ' `teamai doctor` resolved their ${...} with the env of this shell; run it from the shell you start `cursor-agent` in.' : '';

  return approvalVerdict({
    cause,
    approval: { rejected, pending },
    approve: `Run ${enable(pending)} in ${root}, or approve them when an interactive \`cursor-agent\` asks.${envNote}`,
    undo: `Run ${enable(rejected)} in ${root}: it clears ${path.join(dir, 'mcp-disabled.json')} and approves the server.`,
  });
}

/** openclaw.json as OpenClaw writes it is plain JSON; a member may write JSON5, which teamai cannot read. */
async function readOpenclawConfig(
  config: string, cause: string, question: string,
): Promise<{ readonly read: true; readonly value: JsonObject } | { readonly read: false; readonly verdict: ReadGateVerdict }> {
  const found = await readStore(config, { notJson: (error) => `is not plain JSON (${error}), as comments or JSON5 make it` });

  if (found.kind === 'unreadable') return { read: false, verdict: unreadable({ cause, file: config, reason: found.reason, question }) };

  return { read: true, value: found.kind === 'ok' ? found.value : {} };
}

/**
 * OpenClaw 2026.10.9 loads teamai's workspace hook only while
 * `hooks.internal.entries.<key>.enabled` is true and `hooks.internal.enabled`
 * is not false (`src/hooks/configured.ts`); the Gateway, not `hooks list`, honours the master switch.
 */
async function openclawHooksEnabled(gate: Extract<ReadGate, { kind: 'openclaw-hooks-enabled' }>, cause: string): Promise<ReadGateVerdict> {
  const { OPENCLAW_HOOK_KEY, openclawHookEnabledIn } = await import('./openclaw-hooks.js');
  const config = await readOpenclawConfig(gate.config, cause, 'OpenClaw loads teamai\'s hook');

  if (!config.read) return config.verdict;

  if (openclawHookEnabledIn(config.value)) return MET;

  return {
    kind: 'blocked',
    fix: `${cause} (hooks.internal.entries.${OPENCLAW_HOOK_KEY}.enabled, with internal hooks not switched off in ${gate.config}), `
      + `so OpenClaw sends no status report or sync. Run \`openclaw hooks enable ${OPENCLAW_HOOK_KEY}\`.`,
  };
}

const PluginLoadPathsSchema = z.object({ paths: z.array(z.unknown()) });

/**
 * OpenClaw 2026.10.9 loads a `plugins.load.paths` plugin unless `plugins.enabled` is false, `plugins.deny`
 * lists it, its entry is disabled, or a non-empty `plugins.allow` leaves it out
 * (`src/plugins/config-activation-shared.ts`).
 */
async function openclawPluginLoaded(gate: Extract<ReadGate, { kind: 'openclaw-plugins-enabled' }>, cause: string): Promise<ReadGateVerdict> {
  const { pluginsOf, teamHookPluginBlocker } = await import('./openclaw-hooks.js');
  const config = await readOpenclawConfig(gate.config, cause, 'OpenClaw loads the team hooks plugin');

  if (!config.read) return config.verdict;
  const plugins = pluginsOf(config.value);
  const blocker = teamHookPluginBlocker(plugins);

  if (blocker !== null) return { kind: 'blocked', fix: `${cause}, and in ${gate.config} ${blocker}. teamai leaves that setting to you.` };
  const paths = PluginLoadPathsSchema.safeParse(plugins.load).data?.paths;

  if (paths?.includes(gate.plugin)) return MET;

  return { kind: 'blocked', fix: `${cause}, and plugins.load.paths in ${gate.config} does not list it. Run \`teamai hooks inject\`.` };
}
