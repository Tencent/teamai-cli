import path from 'node:path';
import type { LocalConfig, TeamaiConfig, State } from './types.js';
import {
  DEFAULT_CODEX_ROOT,
  resolveBaseDir,
  resolveCoAuthor,
  resolveToolRootDir,
  scopedToolPaths,
} from './types.js';
import { getUserHome } from './utils/home.js';
import {
  writeJson,
  readFileSafe,
  readJsonObject,
  writeFile,
  pathExists,
} from './utils/fs.js';
import { log } from './utils/logger.js';

// ─── Co-author reconcile engine ──────────────────────────────
//
//  Applies the team's co-author intent (does an AI tool stamp a
//  Co-Authored-By / attribution trailer on the commits it makes?) to each
//  installed tool's own config file, idempotently.
//
//  Like MCP, the target files are NOT owned by teamai — ~/.codex/config.toml
//  holds model/trust settings, ~/.cursor/cli-config.json and the Claude
//  settings.json hold unrelated user config. So every write is key-level
//  surgery on an existing document, never a regenerate-from-scratch, and the
//  Codex TOML is patched by text surgery so the user's comments survive.
//
//  Write-only, never delete (issue: team may later drop the policy). The intent
//  we last wrote per file is recorded in state.coAuthorManaged so the pass stays
//  idempotent; when neither user nor team has an opinion we leave every file
//  untouched rather than removing a trailer the user may now depend on. The one
//  exception keeps that trailer: a value an earlier release wrote to Claude's
//  shared project settings.json moves to settings.local.json (#993).
//
//  The three tool families express the same intent differently:
//
//    Claude family   settings.json  attribution.{commit,pr}   deterministic
//                    (claude, tclaude, codebuddy, workbuddy, *-internal, ...)
//                    "" = strip the trailer, non-empty = default trailer.
//                    Scope-aware: project scope writes only claude, to the
//                    member-local <root>/.claude/settings.local.json (#993).
//    Codex family    ~/.codex/config.toml  commit_attribution   best-effort
//                    (codex, codex-internal, tcodex) — user scope only.
//                    Only takes effect when [features].codex_git_commit = true,
//                    which we do NOT force; "" strips, unset = default trailer.
//    Cursor          ~/.cursor/cli-config.json  attribution.attributeCommitsToAgent
//                    user scope only. Known upstream bug: the local executor may
//                    ignore this, so treat it as best-effort.

const CODEX_TOOLS = new Set(['codex', 'codex-internal', 'tcodex']);
const CURSOR_TOOLS = new Set(['cursor']);

type Family = 'claude' | 'codex' | 'cursor';

function familyOf(tool: string): Family {
  if (CODEX_TOOLS.has(tool)) return 'codex';
  return CURSOR_TOOLS.has(tool) ? 'cursor' : 'claude';
}

export interface CoAuthorChange {
  tool: string;
  file: string;
  /** The intent applied: true = keep trailer, false = strip it. */
  enabled: boolean;
  /**
   * `removed`: a pre-#993 value taken out of a shared project settings file;
   * `moved`: the same, with no co-author choice, so it went to settings.local.json.
   */
  action: 'updated' | 'removed' | 'moved' | 'skipped';
  reason?: string;
}

export interface CoAuthorReconcileResult {
  changes: CoAuthorChange[];
  /** The next state.coAuthorManaged map (caller persists it). */
  managed: Record<string, boolean>;
}

interface Target {
  tool: string;
  family: Family;
  /** Absolute path of the config file to edit. */
  file: string;
}

/**
 * Resolve which tools to write, and where. A tool is only targeted when it is
 * actually installed (its resource dir exists) — we never conjure a config file
 * on a machine that does not have that tool.
 */
async function resolveTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<Target[]> {
  const baseDir = resolveBaseDir(localConfig);
  const projectScope = localConfig.scope === 'project';
  const userHome = getUserHome();
  const targets: Target[] = [];
  const disabled = new Set(localConfig.disabledAgents ?? []);
  const whitelist = localConfig.enabledAgents;

  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (disabled.has(tool)) continue;
    if (whitelist && !whitelist.includes(tool)) continue;
    // ZCode exposes no documented attribution setting — writing one into its
    // shared config.json would be an unknown key the tool never reads.
    if (tool === 'zcode') continue;
    const family = familyOf(tool);

    // Installation probe: the tool's root dir (parent of its resource dir), same
    // heuristic MCP reconcile uses. Skip tools we can't locate on disk.
    const probe = paths.settings ?? paths.skills ?? paths.agents;
    if (!probe) continue;
    const probeDir = path.dirname(probe);
    const toolRoot = probeDir === '.' ? path.join(baseDir, probe) : path.join(baseDir, probeDir);
    if (!(await pathExists(toolRoot))) {
      log.debug(`[coauthor] Skipping ${tool}: tool not installed`);
      continue;
    }

    if (family === 'claude') {
      // Scope-aware settings.json. Requires a `settings` path (some tools —
      // openclaw, hermes, dsh — have none and get no co-author control).
      if (!paths.settings) continue;
      if (!projectScope) {
        targets.push({ tool, family, file: path.join(baseDir, paths.settings) });
        continue;
      }
      // Project scope: the choice is the member's, and the project's
      // settings.json is often tracked (#993). Claude Code has a personal layer
      // beside it, settings.local.json (as team hooks use, #955); the rest of
      // the family has none we can rely on, so they are user-scope only here.
      if (tool !== 'claude') {
        log.debug(`[coauthor] Skipping ${tool}: no member-local project settings file`);
        continue;
      }
      targets.push({ tool, family, file: path.join(baseDir, path.dirname(paths.settings), 'settings.local.json') });
    } else if (family === 'codex') {
      // User scope only: Codex reads commit_attribution from $CODEX_HOME/config.toml.
      if (projectScope) {
        log.debug(`[coauthor] Skipping ${tool}: co-author is user-scope only`);
        continue;
      }
      // Each Codex keeps config.toml in its own root, not wherever a team maps
      // its skills: tcodex in ~/.tcodex, codex-internal in ~/.codex-internal,
      // codex in ~/.codex or the root the member recorded from CODEX_HOME.
      const defaultRoot = tool === 'tcodex' ? '.tcodex' : tool === 'codex-internal' ? '.codex-internal' : DEFAULT_CODEX_ROOT;
      targets.push({
        tool,
        family,
        file: path.join(resolveToolRootDir(tool, defaultRoot, localConfig.toolRoots), 'config.toml'),
      });
    } else {
      // Cursor: user scope only, ~/.cursor/cli-config.json.
      if (projectScope) {
        log.debug(`[coauthor] Skipping ${tool}: co-author is user-scope only`);
        continue;
      }
      targets.push({ tool, family, file: path.join(userHome, '.cursor', 'cli-config.json') });
    }
  }
  return targets;
}

/**
 * The shared project settings files earlier releases wrote `attribution` into
 * (every Claude-family tool's `settings`, #993), keyed by file. Empty outside
 * project scope.
 */
function preFixSharedTargets(teamConfig: TeamaiConfig, localConfig: LocalConfig): Map<string, string> {
  const files = new Map<string, string>();
  if (localConfig.scope !== 'project') return files;
  const baseDir = resolveBaseDir(localConfig);
  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (familyOf(tool) !== 'claude' || !paths.settings) continue;
    const file = path.join(baseDir, paths.settings);
    if (!files.has(file)) files.set(file, tool);
  }
  return files;
}

/**
 * A shared settings file's text without its pre-#993 `attribution`, when that
 * is exactly what teamai wrote (`{"commit": "", "pr": ""}`): only that
 * member's text goes, so every other byte, formatting included, stays as it
 * was. `none` when there is nothing of teamai's to remove; `unreadable` when
 * the file is not JSON, so nothing can be told.
 */
async function withoutPreFixAttribution(file: string): Promise<{ kind: 'stripped'; text: string } | { kind: 'none' } | { kind: 'unreadable' }> {
  const source = await readFileSafe(file);
  if (source === null) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { kind: 'unreadable' };
  }
  const attribution = (parsed as Record<string, unknown> | null)?.attribution as Record<string, unknown> | undefined;
  if (typeof attribution !== 'object' || attribution === null) return { kind: 'none' };
  const keys = Object.keys(attribution);
  if (keys.length !== 2 || attribution.commit !== '' || attribution.pr !== '') return { kind: 'none' };
  const text = removeTopLevelJsonMember(source, 'attribution');
  return text === null ? { kind: 'none' } : { kind: 'stripped', text };
}

/**
 * Write teamai's "strip" value to a member-local settings file, unless the
 * member already set `attribution` there (theirs wins). Throws when the file is
 * not a JSON object, so the caller leaves the shared value in place. Returns
 * true when teamai wrote the value.
 */
async function writeStripUnlessSet(file: string): Promise<boolean> {
  const read = await readJsonObject(file);
  if (read.kind === 'invalid') throw new Error(`${file} is not a JSON object (${read.error})`);
  if (read.kind === 'ok' && 'attribution' in read.value) return false;
  await applyClaude(file, false);
  return true;
}

/**
 * Delete the top-level member `key` of a JSON object document by text, along
 * with one adjoining comma, leaving everything else byte-identical. Null when
 * the document is not an object or holds the key other than exactly once.
 */
function removeTopLevelJsonMember(source: string, key: string): string | null {
  interface Member { key: string; start: number; end: number; commaAfter?: number }
  const members: Member[] = [];
  let open = -1;
  let depth = 0;
  let inString = false;
  let stringStart = 0;
  let lastKey: { text: string; start: number } | null = null;
  let current: Member | null = null;
  let lastEnd = 0; // index just past the last non-whitespace character
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') {
        inString = false;
        lastEnd = i + 1;
        if (depth === 1 && !current) lastKey = { text: source.slice(stringStart, i + 1), start: stringStart };
      }
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === '"') {
      inString = true;
      stringStart = i;
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0) {
        if (c !== '{' || open !== -1) return null;
        open = i;
      }
      depth++;
    } else if (c === '}' || c === ']') {
      if (depth === 1 && current) {
        members.push({ ...current, end: lastEnd });
        current = null;
      }
      depth--;
    } else if (depth === 1 && c === ':' && lastKey) {
      current = { key: JSON.parse(lastKey.text) as string, start: lastKey.start, end: -1 };
      lastKey = null;
    } else if (depth === 1 && c === ',' && current) {
      members.push({ ...current, end: lastEnd, commaAfter: i });
      current = null;
    }
    lastEnd = i + 1;
  }
  const matches = members.filter((m) => m.key === key);
  if (open === -1 || depth !== 0 || matches.length !== 1) return null;
  const index = members.indexOf(matches[0]);
  const member = members[index];
  const previous = members[index - 1];
  // `, "key": value` after a sibling; `"key": value, ` before one; else alone.
  if (previous?.commaAfter !== undefined) return source.slice(0, previous.commaAfter) + source.slice(member.end);
  if (member.commaAfter !== undefined && members[index + 1]) {
    return source.slice(0, member.start) + source.slice(members[index + 1].start);
  }
  return source.slice(0, open + 1) + source.slice(member.end);
}

// ─── Per-family writers ──────────────────────────────────────

/**
 * Patch a Claude-family settings.json: `attribution.commit` and
 * `attribution.pr`. Empty string strips the trailer; a non-empty default is
 * restored by DELETING the keys (absent = tool's built-in default) so we never
 * pin an arbitrary trailer string of our own.
 *
 * Returns true when the file changed.
 */
async function applyClaude(file: string, enabled: boolean): Promise<boolean> {
  // A file that does not parse is the member's to repair: writing it would replace all of it.
  const read = await readJsonObject(file);
  if (read.kind === 'invalid') throw new Error(`${file} is not a JSON object (${read.error}); left as it is`);
  const settings = read.kind === 'ok' ? read.value : {};
  const attribution = (typeof settings.attribution === 'object' && settings.attribution !== null
    ? { ...(settings.attribution as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  const before = JSON.stringify(settings.attribution ?? null);
  if (enabled) {
    // Restore the default: remove our override rather than guess a trailer.
    if (attribution.commit === '') delete attribution.commit;
    if (attribution.pr === '') delete attribution.pr;
  } else {
    attribution.commit = '';
    attribution.pr = '';
  }

  if (Object.keys(attribution).length === 0) {
    delete settings.attribution;
  } else {
    settings.attribution = attribution;
  }
  if (JSON.stringify(settings.attribution ?? null) === before) return false;
  await writeJson(file, settings);
  return true;
}

/**
 * Patch Codex's config.toml top-level `commit_attribution` scalar by text
 * surgery, leaving the rest of the file (comments included) byte-identical.
 * enabled=true removes the key (restore default trailer); enabled=false sets
 * `commit_attribution = ""`.
 *
 * Only rewrites/removes a top-level occurrence — a `commit_attribution` nested
 * under some `[table]` is left alone. Returns true when the file changed.
 */
export function spliceCodexAttribution(source: string, enabled: boolean): string {
  // A top-level key is one that appears before the first `[table]` header, or
  // (defensively) any line matching the key at column 0. Codex config.toml keeps
  // scalars at the top, so we operate on the pre-first-table region.
  const firstTable = source.search(/^\[/m);
  const head = firstTable === -1 ? source : source.slice(0, firstTable);
  const tail = firstTable === -1 ? '' : source.slice(firstTable);

  const keyRe = /^[ \t]*commit_attribution[ \t]*=.*$(?:\r?\n)?/m;
  const hasKey = keyRe.test(head);

  if (enabled) {
    // Restore default: drop our line if present, else no-op.
    if (!hasKey) return source;
    const cleanedHead = head.replace(keyRe, '');
    return cleanedHead + tail;
  }

  const line = 'commit_attribution = ""\n';
  if (hasKey) {
    const replacedHead = head.replace(keyRe, line);
    return replacedHead + tail;
  }
  // Insert at the end of the head region (before the first table / EOF).
  const lead = head.length === 0 || head.endsWith('\n') ? '' : '\n';
  // Keep a blank line before a following `[table]` so the inserted scalar does
  // not sit flush against a table header (valid TOML, but visually misleading).
  const trail = tail.startsWith('[') ? '\n' : '';
  return head + lead + line + trail + tail;
}

async function applyCodex(file: string, enabled: boolean): Promise<boolean> {
  const source = (await readFileSafe(file)) ?? '';
  const next = spliceCodexAttribution(source, enabled);
  if (next === source) return false;
  await writeFile(file, next);
  return true;
}

/**
 * Patch Cursor's cli-config.json `attribution.attributeCommitsToAgent`.
 * enabled=true removes the override (restore default); enabled=false sets it to
 * false. Returns true when the file changed.
 */
async function applyCursor(file: string, enabled: boolean): Promise<boolean> {
  const read = await readJsonObject(file);
  if (read.kind === 'invalid') throw new Error(`${file} is not a JSON object (${read.error}); left as it is`);
  const config = read.kind === 'ok' ? read.value : {};
  const attribution = (typeof config.attribution === 'object' && config.attribution !== null
    ? { ...(config.attribution as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  const before = JSON.stringify(config.attribution ?? null);
  if (enabled) {
    if (attribution.attributeCommitsToAgent === false) delete attribution.attributeCommitsToAgent;
  } else {
    attribution.attributeCommitsToAgent = false;
  }

  if (Object.keys(attribution).length === 0) {
    delete config.attribution;
  } else {
    config.attribution = attribution;
  }
  if (JSON.stringify(config.attribution ?? null) === before) return false;
  await writeJson(file, config);
  return true;
}

/**
 * The project's `.claude/settings.local.json` and teamai's entry there (#915).
 * `holds`: the record says teamai wrote "strip" (`managed` false) and the file
 * still holds an empty trailer. teamai owns `attribution` only then; the file
 * may hold anything else too. `unreadable`: the record says so but the file
 * does not parse, so whether the entry is still there is unknown.
 */
export async function coAuthorLocalSettingsFile(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  managed: Readonly<Record<string, boolean>>,
): Promise<{ kind: 'holds' | 'unreadable'; file: string } | { kind: 'none' }> {
  const settings = scopedToolPaths(teamConfig, localConfig).claude?.settings;
  if (localConfig.scope !== 'project' || !settings) return { kind: 'none' };
  const file = path.join(resolveBaseDir(localConfig), path.dirname(settings), 'settings.local.json');
  if (managed[file] !== false) return { kind: 'none' };
  const read = await readJsonObject(file);
  if (read.kind === 'invalid') return { kind: 'unreadable', file };
  const attribution = read.kind === 'ok' ? read.value.attribution : undefined;
  if (typeof attribution !== 'object' || attribution === null) return { kind: 'none' };
  const { commit, pr } = attribution as Record<string, unknown>;
  return commit === '' || pr === '' ? { kind: 'holds', file } : { kind: 'none' };
}

// ─── Main entry ──────────────────────────────────────────────

/**
 * Reconcile one scope's tool configs to the team's desired co-author intent.
 * Idempotent. Returns the changes plus the next `coAuthorManaged` map.
 */
export async function reconcileCoAuthorForConfig(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  state: State,
): Promise<CoAuthorReconcileResult> {
  const managed: Record<string, boolean> = { ...state.coAuthorManaged };
  const changes: CoAuthorChange[] = [];

  const intent = resolveCoAuthor(localConfig, teamConfig);
  const claudeSettings = scopedToolPaths(teamConfig, localConfig).claude?.settings;
  const claudeShared = claudeSettings ? path.join(resolveBaseDir(localConfig), claudeSettings) : undefined;

  // Settle each shared project file an earlier release wrote into: remove the
  // value only when the record says teamai wrote "strip" there and it is still
  // exactly that; either way the file is no longer teamai's to manage. With no
  // choice, the value moves to Claude's settings.local.json so the member's
  // trailer stays as it was; a file with no such place waits for a choice.
  for (const [file, tool] of preFixSharedTargets(teamConfig, localConfig)) {
    if (!(file in managed)) continue;
    const moveTo = intent === undefined && file === claudeShared
      ? path.join(path.dirname(file), 'settings.local.json')
      : undefined;
    if (intent === undefined && !moveTo) continue;
    const recorded = managed[file];
    const wroteStrip = recorded === false;
    delete managed[file];
    try {
      const next = wroteStrip ? await withoutPreFixAttribution(file) : { kind: 'none' as const };
      if (next.kind !== 'stripped') {
        // An unreadable file proves nothing: keep the record, so a pull after it is repaired settles it.
        if (next.kind === 'unreadable') managed[file] = recorded;
        const reason = next.kind === 'unreadable' ? `${file} is not valid JSON, so teamai could not read it` : 'not teamai\'s value';
        changes.push({ tool, file, enabled: false, action: 'skipped', reason });
        continue;
      }
      if (moveTo && await writeStripUnlessSet(moveTo)) managed[moveTo] = false;
      await writeFile(file, next.text);
      changes.push({ tool, file, enabled: false, action: moveTo ? 'moved' : 'removed' });
    } catch (e) {
      managed[file] = recorded;
      changes.push({ tool, file, enabled: false, action: 'skipped', reason: (e as Error).message });
    }
  }

  // No opinion from user or team → write-only means touch nothing else.
  if (intent === undefined) {
    return { changes, managed };
  }

  const targets = await resolveTargets(teamConfig, localConfig);
  for (const t of targets) {
    // Idempotence: skip when we already wrote this exact intent to this file.
    if (managed[t.file] === intent) {
      changes.push({ tool: t.tool, file: t.file, enabled: intent, action: 'skipped', reason: 'already applied' });
      continue;
    }
    try {
      let changed: boolean;
      if (t.family === 'claude') changed = await applyClaude(t.file, intent);
      else if (t.family === 'codex') changed = await applyCodex(t.file, intent);
      else changed = await applyCursor(t.file, intent);

      managed[t.file] = intent;
      changes.push({
        tool: t.tool,
        file: t.file,
        enabled: intent,
        action: changed ? 'updated' : 'skipped',
        reason: changed ? undefined : 'already up-to-date',
      });
    } catch (e) {
      changes.push({ tool: t.tool, file: t.file, enabled: intent, action: 'skipped', reason: (e as Error).message });
    }
  }

  return { changes, managed };
}
