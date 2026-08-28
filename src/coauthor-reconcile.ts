import path from 'node:path';
import type { LocalConfig, TeamaiConfig, State } from './types.js';
import { resolveBaseDir, resolveCoAuthor, scopedToolPaths } from './types.js';
import { getUserHome } from './utils/home.js';
import {
  readJson,
  writeJson,
  readFileSafe,
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
//  untouched rather than removing a trailer the user may now depend on.
//
//  The three tool families express the same intent differently:
//
//    Claude family   settings.json  attribution.{commit,pr}   deterministic
//                    (claude, tclaude, codebuddy, workbuddy, *-internal, ...)
//                    "" = strip the trailer, non-empty = default trailer.
//                    Scope-aware: project scope writes <root>/.claude/settings.json.
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
  action: 'updated' | 'skipped';
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
      targets.push({ tool, family, file: path.join(baseDir, paths.settings) });
    } else if (family === 'codex') {
      // User scope only: Codex reads commit_attribution from ~/.codex/config.toml.
      if (projectScope) {
        log.debug(`[coauthor] Skipping ${tool}: co-author is user-scope only`);
        continue;
      }
      // tcodex relocates its home to ~/.tcodex; codex-internal to ~/.codex-internal.
      const home = tool === 'tcodex' ? '.tcodex' : tool === 'codex-internal' ? '.codex-internal' : '.codex';
      targets.push({ tool, family, file: path.join(userHome, home, 'config.toml') });
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
  const settings = (await readJson<Record<string, unknown>>(file)) ?? {};
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
  const config = (await readJson<Record<string, unknown>>(file)) ?? {};
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
  const managed: Record<string, boolean> = { ...(state.coAuthorManaged ?? {}) };
  const changes: CoAuthorChange[] = [];

  const intent = resolveCoAuthor(localConfig, teamConfig);
  // No opinion from user or team → write-only means touch nothing.
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
