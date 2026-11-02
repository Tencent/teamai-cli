import YAML from 'yaml';
import { parseYaml } from './utils/yaml.js';
import path from 'node:path';
import { z } from 'zod';
import { toolHome } from './tool-home.js';
import { readFileSafe, writeFile, ensureDir, remove, pathExists, readJson, writeJson } from './utils/fs.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END, isJsonObject, type JsonValue } from './types.js';

/** Markers that delimit the teamai-managed block inside SOUL.md. */
const RULES_BLOCK_START = TEAMAI_RULES_START;
const RULES_BLOCK_END = TEAMAI_RULES_END;

/** Absolute path to the Hermes config.yaml in `home`. */
export function getHermesConfigPath(home = toolHome('hermes')): string {
  return path.join(home, 'config.yaml');
}

/** The cap config.yaml sets on context files: a finite number above zero, else none. */
const ContextFileBudgetSchema = z.object({ context_file_max_chars: z.number().positive().optional().catch(undefined) });

/** Hermes uses an explicit cap, or a model-dependent cap with a 20,000-character floor. */
export async function hermesContextFileBudget(): Promise<{ limit: number; explicit: boolean; error?: string }> {
  const raw = await readFileSafe(getHermesConfigPath());

  try {
    const config = ContextFileBudgetSchema.safeParse(raw ? parseYaml(raw) : null);
    const value = config.success ? config.data.context_file_max_chars : undefined;

    if (value !== undefined) {
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
async function readConfigDoc(home = toolHome('hermes')): Promise<YAML.Document> {
  const content = await readFileSafe(getHermesConfigPath(home));

  if (!content || content.trim() === '') return new YAML.Document({});
  const doc = YAML.parseDocument(content);

  // If the top level is not a map (unexpected), start fresh to stay safe.
  if (!doc.contents || !YAML.isMap(doc.contents)) {
    return new YAML.Document({});
  }

  return doc;
}

/**
 * Serialize and write the Hermes config.yaml Document, creating the home dir
 * if needed. Comments and key order in the original file are preserved.
 */
async function writeConfigDoc(doc: YAML.Document, home = toolHome('hermes')): Promise<void> {
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

/** A list of config.yaml as written: its entries need not be JSON (`.inf`) and are kept whole. */
const YamlListSchema = z.array(z.unknown());

/** A mapping of config.yaml as written, kept key for key. */
const YamlMapSchema = z.record(z.string(), z.unknown());

/** A hook entry teamai matches by its `command`. */
const HookCommandSchema = z.object({ command: z.string() });

/**
 * The entries of a hook list that stay when the entry for `command` is
 * removed or rewritten: each mapping (or list) with another command, as written.
 */
function entriesBesides(list: z.infer<typeof YamlListSchema>, command: string): z.infer<typeof YamlListSchema> {
  return list.filter((entry) => Array.isArray(entry)
    || (YamlMapSchema.safeParse(entry).success && HookCommandSchema.safeParse(entry).data?.command !== command));
}

/** One approval of the allowlist, as teamai reads it: Hermes and the member edit the file, so a field of another type reads as absent. */
const ApprovalSchema = z.object({
  event: z.string().optional().catch(undefined),
  command: z.string().optional().catch(undefined),
});

/** The approvals list of an allowlist file as written, or null when the file holds none. */
function approvalsOf(file: JsonValue | null): JsonValue[] | null {
  return isJsonObject(file) && Array.isArray(file.approvals) ? file.approvals : null;
}

/** Whether an approval names `command`, and `event` when given. An entry that is not an object names nothing. */
function approves(entry: JsonValue, command: string, event?: string): boolean {
  const approval = ApprovalSchema.safeParse(entry);

  return approval.success && approval.data.command === command && (event === undefined || approval.data.event === event);
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
  const current = YamlListSchema.safeParse(YAML.isSeq(rawSeq) ? rawSeq.toJSON() : rawSeq);
  const arr = current.success ? current.data : [];
  const untouched = entriesBesides(arr, entry.command);

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

  const hooks = YamlMapSchema.safeParse(YAML.isMap(rawHooks) ? rawHooks.toJSON() : null);

  if (!hooks.success) return;

  let changed = false;

  for (const [event, entries] of Object.entries(hooks.data)) {
    const list = YamlListSchema.safeParse(entries);
    const arr = list.success ? list.data : [];
    const filtered = entriesBesides(arr, command);

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

  const remaining = YamlMapSchema.safeParse(YAML.isMap(remainingRaw) ? remainingRaw.toJSON() : null);

  if (!remaining.success || Object.keys(remaining.data).length === 0) {
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
  const raw = await readJson<JsonValue>(filePath);
  const approvals = approvalsOf(raw);

  if (approvals?.some((entry) => approves(entry, command, event))) return false;

  if (approvals) {
    // `approvals` is the file's own list: the file is written back as read, with the approval appended.
    approvals.push({ event, command });
    await writeJson(filePath, raw);
  } else {
    await writeJson(filePath, { approvals: [{ event, command }] });
  }

  return true;
}

/** Whether these exact managed commands remain in hooks or their approvals. */
export async function hasHermesHookCommands(commands: readonly string[], home = toolHome('hermes')): Promise<boolean> {
  const doc = await readConfigDoc(home);
  const raw = doc.getIn(['hooks']);
  const hooks = YamlMapSchema.safeParse(YAML.isMap(raw) ? raw.toJSON() : null);

  if (hooks.success && Object.values(hooks.data).some((entries) => {
    const list = YamlListSchema.safeParse(entries);

    return list.success && list.data.some((entry) => {
      const hook = HookCommandSchema.safeParse(entry);

      return hook.success && commands.includes(hook.data.command);
    });
  })) return true;
  const approvals = approvalsOf(await readJson<JsonValue>(getHermesAllowlistPath(home)));

  return approvals?.some((entry) => commands.some((command) => approves(entry, command))) ?? false;
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
  const approvals = approvalsOf(await readJson<JsonValue>(filePath));

  if (!approvals) return;

  const filtered = approvals.filter((entry) => !approves(entry, command, event));

  if (filtered.length === approvals.length) return;

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

  if (YAML.isSeq(disabled) && disabled.toJSON().includes(name)) return false;
  const enabled = doc.getIn(['plugins', 'enabled']);
  const list = YAML.isSeq(enabled) ? enabled.toJSON() : [];

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
  const list = enabled.toJSON();

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

  return YAML.isSeq(disabled) && disabled.toJSON().includes(name);
}

/** Whether `name` is in `plugins.enabled` of the Hermes config.yaml. */
export async function isHermesPluginEnabled(name: string): Promise<boolean> {
  const enabled = (await readConfigDoc()).getIn(['plugins', 'enabled']);

  return YAML.isSeq(enabled) && enabled.toJSON().includes(name);
}
