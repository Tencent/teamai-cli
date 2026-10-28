import YAML from 'yaml';
import path from 'node:path';
import { toolHome } from './tool-home.js';
import { readFileSafe, writeFile, ensureDir, remove, pathExists, readJson, writeJson } from './utils/fs.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END } from './types.js';

/** Markers that delimit the teamai-managed block inside SOUL.md. */
const RULES_BLOCK_START = TEAMAI_RULES_START;
const RULES_BLOCK_END = TEAMAI_RULES_END;

/** Absolute path to the Hermes config.yaml in `home`. */
export function getHermesConfigPath(home = toolHome('hermes')): string {
  return path.join(home, 'config.yaml');
}

/** Hermes uses an explicit cap, or a model-dependent cap with a 20,000-character floor. */
export async function hermesContextFileBudget(): Promise<{ limit: number; explicit: boolean; error?: string }> {
  const raw = await readFileSafe(getHermesConfigPath());
  try {
    const config = raw ? YAML.parse(raw) as { context_file_max_chars?: unknown } | null : null;
    const value = config?.context_file_max_chars;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return { limit: Math.trunc(value), explicit: true };
    }
    return { limit: 20_000, explicit: false };
  } catch (error) {
    return { limit: 20_000, explicit: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Read the Hermes config.yaml as a YAML Document, preserving comments and
 * formatting. Returns an empty Document when the file is missing or empty.
 */
async function readConfigDoc(home = toolHome('hermes')): Promise<YAML.Document.Parsed> {
  const content = await readFileSafe(getHermesConfigPath(home));
  if (!content || content.trim() === '') return new YAML.Document({}) as YAML.Document.Parsed;
  const doc = YAML.parseDocument(content);
  // If the top level is not a map (unexpected), start fresh to stay safe.
  if (!doc.contents || !YAML.isMap(doc.contents)) {
    return new YAML.Document({}) as YAML.Document.Parsed;
  }
  return doc as YAML.Document.Parsed;
}

/**
 * Serialize and write the Hermes config.yaml Document, creating the home dir
 * if needed. Comments and key order in the original file are preserved.
 */
async function writeConfigDoc(doc: YAML.Document.Parsed, home = toolHome('hermes')): Promise<void> {
  await ensureDir(home);
  await writeFile(getHermesConfigPath(home), doc.toString());
}

/**
 * Replace or insert the teamai-managed block within an existing string.
 *
 * Rules:
 * - If rulesText is non-empty, block = START + newline + rulesText.trim() + newline + END.
 * - If rulesText is empty, block = '' (remove the managed section).
 * - If existing already contains both markers, replace the entire START..END span with block.
 * - Otherwise append block after existing (separated by a blank line when existing is non-empty).
 * - Returns a trimmed string; empty string when the result would be blank.
 */
function mergeBlock(existing: string, rulesText: string): string {
  const block =
    rulesText.trim() !== ''
      ? `${RULES_BLOCK_START}\n${rulesText.trim()}\n${RULES_BLOCK_END}`
      : '';

  const startIdx = existing.indexOf(RULES_BLOCK_START);
  const endIdx = existing.indexOf(RULES_BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace the existing managed block (inclusive of markers).
    const before = existing.substring(0, startIdx).replace(/\n+$/, '');
    const after = existing.substring(endIdx + RULES_BLOCK_END.length).replace(/^\n+/, '');

    let result: string;
    if (block === '') {
      // Remove the managed block; stitch before and after.
      if (before === '' && after === '') {
        result = '';
      } else if (before === '') {
        result = after;
      } else if (after === '') {
        result = before;
      } else {
        result = `${before}\n\n${after}`;
      }
    } else {
      if (before === '' && after === '') {
        result = block;
      } else if (before === '') {
        result = `${block}\n\n${after}`;
      } else if (after === '') {
        result = `${before}\n\n${block}`;
      } else {
        result = `${before}\n\n${block}\n\n${after}`;
      }
    }
    return result.trim();
  }

  // No existing managed block — append.
  if (block === '') return existing.trim();
  if (existing.trim() === '') return block;
  return `${existing.trim()}\n\n${block}`;
}

/**
 * Merge the teamai-managed rules block into the Hermes SOUL.md file,
 * preserving any user-authored content outside the teamai markers.
 *
 * Pass an empty string to remove the teamai block. Removes the file entirely
 * when the merged result is blank.
 *
 * @param soulPath  SOUL.md, where `locate` puts Hermes' blocks.
 * @param rulesText Concatenated team rule bodies (already joined).
 */
export async function upsertSoulRules(soulPath: string, rulesText: string): Promise<void> {
  // Strip any teamai markers embedded in rule bodies so they can't break the
  // block boundaries on the next read.
  const sanitized = rulesText
    .split('\n')
    .filter((line) => line.trim() !== RULES_BLOCK_START && line.trim() !== RULES_BLOCK_END)
    .join('\n');
  const existing = (await readFileSafe(soulPath)) ?? '';
  const merged = mergeBlock(existing, sanitized);

  if (merged === '') {
    if (await pathExists(soulPath)) await remove(soulPath);
    return;
  }

  await ensureDir(path.dirname(soulPath));
  await writeFile(soulPath, merged + '\n');
}

/**
 * The text inside the teamai-managed block of SOUL.md, or null when the block
 * is not there. Read-only: `doctor` has to compare what Hermes actually reads
 * with what `upsertSoulRules` would write, and reusing the writer to find out
 * would edit the file the command is only meant to describe.
 */
export async function readSoulRules(soulPath: string): Promise<string | null> {
  const content = await readFileSafe(soulPath);
  if (content === null) return null;

  const startIdx = content.indexOf(RULES_BLOCK_START);
  const endIdx = content.indexOf(RULES_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  return content.slice(startIdx + RULES_BLOCK_START.length, endIdx).trim();
}

/**
 * Remove the teamai-managed rules block from Hermes SOUL.md, leaving user
 * content intact. No-op when nothing is present.
 */
export async function removeSoulRules(soulPath: string): Promise<void> {
  await upsertSoulRules(soulPath, '');
}

/** Absolute path to the Hermes shell-hooks allowlist JSON in `home`. */
export function getHermesAllowlistPath(home = toolHome('hermes')): string {
  return path.join(home, 'shell-hooks-allowlist.json');
}

/** Shape of a single hook entry in config.yaml `hooks.<event>[]`. */
interface HookEntry {
  command: string;
  matcher?: string;
  timeout?: number;
}

/** Shape of the allowlist JSON file. */
interface AllowlistFile {
  approvals: Array<{ event: string; command: string }>;
}

/**
 * Insert or replace a hook entry (matched by `command`) under `hooks.<event>`
 * in the Hermes config.yaml.
 *
 * Idempotent: no write occurs when the serialized result is identical to the
 * current state.
 *
 * @param event - The hook event name (e.g. `on_session_start`).
 * @param entry - Hook descriptor; `matcher` and `timeout` are omitted when
 *   undefined so the YAML does not contain null values.
 * @returns Whether config.yaml was written.
 */
export async function upsertHermesHook(
  event: string,
  entry: { command: string; matcher?: string; timeout?: number },
): Promise<boolean> {
  const doc = await readConfigDoc();

  // Get current hooks[event] as a plain JS array.
  const rawSeq = doc.getIn(['hooks', event]);
  const currentJs: unknown = YAML.isSeq(rawSeq) ? rawSeq.toJSON() : rawSeq;
  const arr: HookEntry[] = Array.isArray(currentJs) ? (currentJs as HookEntry[]) : [];
  const untouched = arr.filter((e) => e && typeof e === 'object' && e.command !== entry.command);

  // Build clean entry without undefined keys to avoid YAML null values.
  const cleanEntry: HookEntry = { command: entry.command };
  if (entry.matcher !== undefined) cleanEntry.matcher = entry.matcher;
  if (entry.timeout !== undefined) cleanEntry.timeout = entry.timeout;

  const newArr = [...untouched, cleanEntry];

  if (JSON.stringify(arr) === JSON.stringify(newArr)) return false;

  doc.setIn(['hooks', event], newArr);
  await writeConfigDoc(doc);
  return true;
}

/**
 * Remove every hook entry whose `command` matches `command` from all events
 * in the Hermes config.yaml `hooks:` block.
 *
 * Cleans up empty event arrays and the `hooks` key itself when all entries
 * are removed. No-op when no matching entry exists.
 *
 * @param command - The command string to remove.
 */
export async function removeHermesHookByCommand(command: string, home = toolHome('hermes')): Promise<void> {
  const doc = await readConfigDoc(home);

  // Get hooks as a plain JS object for iteration.
  const rawHooks = doc.getIn(['hooks']);
  const hooks: Record<string, unknown> | null = YAML.isMap(rawHooks)
    ? (rawHooks.toJSON() as Record<string, unknown>)
    : null;
  if (!hooks || typeof hooks !== 'object') return;

  let changed = false;

  for (const event of Object.keys(hooks)) {
    const arr: HookEntry[] = Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : [];
    const filtered = arr.filter((e) => e && typeof e === 'object' && e.command !== command);
    if (filtered.length !== arr.length) {
      changed = true;
      if (filtered.length === 0) {
        doc.deleteIn(['hooks', event]);
      } else {
        doc.setIn(['hooks', event], filtered);
      }
    }
  }

  if (!changed) return;

  // If hooks map is now empty, remove the hooks key entirely.
  const remainingRaw = doc.getIn(['hooks']);
  const remaining: Record<string, unknown> | null = YAML.isMap(remainingRaw)
    ? (remainingRaw.toJSON() as Record<string, unknown>)
    : null;
  if (!remaining || Object.keys(remaining).length === 0) {
    doc.deleteIn(['hooks']);
  }

  await writeConfigDoc(doc, home);
}

/**
 * Add `{event, command}` to the Hermes shell-hooks allowlist JSON if not
 * already present. Creates the file when missing.
 *
 * @param event   - Hook event name.
 * @param command - Absolute path to the approved script.
 * @returns Whether the allowlist was written.
 */
export async function addHermesAllowlist(event: string, command: string): Promise<boolean> {
  const filePath = getHermesAllowlistPath();
  const raw = await readJson<AllowlistFile>(filePath);
  const data: AllowlistFile =
    raw && Array.isArray(raw.approvals) ? raw : { approvals: [] };

  const exists = data.approvals.some((a) => a.event === event && a.command === command);
  if (exists) return false;

  data.approvals.push({ event, command });
  await writeJson(filePath, data);
  return true;
}

/** Whether these exact managed commands remain in hooks or their approvals. */
export async function hasHermesHookCommands(commands: readonly string[], home = toolHome('hermes')): Promise<boolean> {
  const doc = await readConfigDoc(home);
  const raw = doc.getIn(['hooks']);
  const hooks = YAML.isMap(raw) ? raw.toJSON() as Record<string, unknown> : {};
  if (Object.values(hooks).some(entries => Array.isArray(entries)
    && entries.some((entry: HookEntry) => entry && typeof entry === 'object' && commands.includes(entry.command)))) return true;
  const approvals = await readJson<AllowlistFile>(getHermesAllowlistPath(home));
  return Array.isArray(approvals?.approvals) && approvals.approvals.some(entry => commands.includes(entry.command));
}

/**
 * Remove `{event, command}` from the Hermes shell-hooks allowlist JSON.
 * No-op when the file is missing or the entry is absent.
 *
 * @param event   - Hook event name.
 * @param command - Absolute path of the script to de-approve.
 */
export async function removeHermesAllowlist(event: string, command: string, home = toolHome('hermes')): Promise<void> {
  const filePath = getHermesAllowlistPath(home);
  const raw = await readJson<AllowlistFile>(filePath);
  if (!raw || !Array.isArray(raw.approvals)) return;

  const filtered = raw.approvals.filter(
    (a) => !(a.event === event && a.command === command),
  );
  if (filtered.length === raw.approvals.length) return;

  await writeJson(filePath, { approvals: filtered });
}

/**
 * Add `name` to `plugins.enabled` in the Hermes config.yaml: Hermes loads no
 * user plugin that is not listed there. A name the member put under
 * `plugins.disabled` stays off. Returns whether config.yaml was written.
 */
export async function enableHermesPlugin(name: string): Promise<boolean> {
  const doc = await readConfigDoc();
  const disabled = doc.getIn(['plugins', 'disabled']);
  if (YAML.isSeq(disabled) && (disabled.toJSON() as unknown[]).includes(name)) return false;
  const enabled = doc.getIn(['plugins', 'enabled']);
  const list = YAML.isSeq(enabled) ? (enabled.toJSON() as unknown[]) : [];
  if (list.includes(name)) return false;
  doc.setIn(['plugins', 'enabled'], [...list, name]);
  await writeConfigDoc(doc);
  return true;
}

/** Remove `name` from `plugins.enabled` in the Hermes config.yaml, dropping keys left empty. */
export async function disableHermesPlugin(name: string, home = toolHome('hermes')): Promise<void> {
  const doc = await readConfigDoc(home);
  const enabled = doc.getIn(['plugins', 'enabled']);
  if (!YAML.isSeq(enabled)) return;
  const list = enabled.toJSON() as unknown[];
  if (!list.includes(name)) return;
  const rest = list.filter((entry) => entry !== name);
  if (rest.length > 0) doc.setIn(['plugins', 'enabled'], rest);
  else doc.deleteIn(['plugins', 'enabled']);
  const plugins = doc.getIn(['plugins']);
  if (YAML.isMap(plugins) && plugins.items.length === 0) doc.deleteIn(['plugins']);
  await writeConfigDoc(doc, home);
}

/** Whether the member put `name` in `plugins.disabled`, which enabling leaves alone. */
export async function isHermesPluginDisabled(name: string): Promise<boolean> {
  const disabled = (await readConfigDoc()).getIn(['plugins', 'disabled']);
  return YAML.isSeq(disabled) && (disabled.toJSON() as unknown[]).includes(name);
}

/** Whether `name` is in `plugins.enabled` of the Hermes config.yaml. */
export async function isHermesPluginEnabled(name: string): Promise<boolean> {
  const enabled = (await readConfigDoc()).getIn(['plugins', 'enabled']);
  return YAML.isSeq(enabled) && (enabled.toJSON() as unknown[]).includes(name);
}
