import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { LocalConfig, TeamaiConfig, ToolId } from './types.js';
import { isAgentExcluded, recordedToolRootDir, resolveAutoCompactTokens } from './types.js';
import { CODEX_TOOL_IDS } from './utils/tool-names.js';
import { toolHome } from './tool-home.js';
import { withFileLock } from './update.js';
import { pathExists, readFileSafe, readJsonObject, writeFile, writeJson, writeJsonAtomic } from './utils/fs.js';
import { getUserHome } from './utils/home.js';

// ─── Auto-compact reconcile engine ───────────────────────────
//
//  Applies the team's auto-compact threshold (compact the conversation once
//  its context reaches N tokens) to each installed tool's own config file.
//
//  No tool takes "compact at N tokens" directly, so N is translated per tool.
//  Every translation keeps the tool's own `min(value, model window)`, which
//  means the setting can only make a tool compact earlier, never later, on a
//  model whose window the tool knows:
//
//    Claude family   <home>/settings.json  autoCompactWindow = N + 33K
//                    (claude, tclaude, claude-internal) Claude Code compacts at
//                    window - min(maxOutput, 20K) - 13K; accepts 100K..1M.
//    CodeBuddy       <home>/settings.json  autoCompactWindow = N / ratio
//                    (codebuddy, workbuddy) compacts mid-turn at
//                    min(window, model window) * ratio. ratio is the product
//                    config's inputTokens.emergency (WorkBuddy 0.9), else the
//                    built-in 0.92. Must be a number: a string compacts every turn.
//                    A model with no known window uses the value as is, so a
//                    custom model without maxInputTokens skips the write.
//    Codex family    <home>/config.toml  model_auto_compact_token_limit = N
//                    (codex, codex-internal, tcodex) Codex uses
//                    min(N, 90% of the model window).
//    DeepSeek        <home>/cordis.patch.yml  row `compaction-basic`, one
//    Harness (dsh)   modelPolicies entry per model with ratio N / window. Only
//                    ratios in (0.16, 0.8): at or below the default retainRatio
//                    0.16 dsh refuses to boot, at or above 0.8 it is a no-op.
//
//  Cursor and the rest expose no client-side compaction setting and are left out.
//
//  The value teamai last wrote is recorded per file in one machine-wide record
//  (~/.teamai/autocompact-managed.json), since every target file is per machine
//  whichever scope decides. teamai only writes over its own value or an absent
//  one, so a member's own setting always wins; when the policy goes away,
//  teamai removes its value if the file still holds exactly that. A record is
//  kept while its tool is excluded or missing, so the value stays teamai's.

const CLAUDE_TOOLS: readonly ToolId[] = ['claude', 'tclaude', 'claude-internal'];
const BUDDY_TOOLS: readonly ToolId[] = ['codebuddy', 'workbuddy'];

type Kind = 'claude' | 'buddy' | 'codex' | 'dsh';

const WINDOW_MIN = 100_000;
const WINDOW_MAX = 1_000_000;
/** Claude Code reserves min(maxOutput, 20K) for output plus a 13K buffer. */
const CLAUDE_BUFFER = 33_000;
const BUDDY_DEFAULT_RATIO = 0.92;
const DSH_ROW_ID = 'compaction-basic';
const DSH_RETAIN_RATIO = 0.16;
const DSH_DEFAULT_RATIO = 0.8;
/** dsh-llm-deepseek DEFAULT_MODELS (dsh 0.1.5): all 1M context. */
const DSH_DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
const DSH_DEEPSEEK_WINDOW = 1_000_000;

export interface AutoCompactChange {
  tool: string;
  file: string;
  action: 'updated' | 'removed' | 'skipped';
  /** The value written (JSON text) on `updated`. */
  value?: string;
  reason?: string;
  /** A skip the member should hear about: their tool keeps its own threshold. */
  notable?: true;
}

export interface AutoCompactReconcileResult {
  changes: AutoCompactChange[];
  /** The next machine-wide record (caller persists it with saveAutoCompactRecord). */
  managed: Record<string, string>;
}

interface Target {
  tool: ToolId;
  kind: Kind;
  file: string;
}

/** What teamai last wrote, per config file, as JSON text: one record per machine. */
export function autoCompactRecordPath(): string {
  return path.join(getUserHome(), '.teamai', 'autocompact-managed.json');
}

export async function loadAutoCompactRecord(): Promise<Record<string, string>> {
  const read = await readJsonObject(autoCompactRecordPath());
  if (read.kind !== 'ok') return {};
  return Object.fromEntries(Object.entries(read.value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

export async function saveAutoCompactRecord(record: Readonly<Record<string, string>>): Promise<void> {
  await writeJsonAtomic(autoCompactRecordPath(), record);
}

const RECORD_LOCK_WAIT = { attempts: 20, delayMs: 100 };

/**
 * Read the record, reconcile and save it under the record's lock, so pulls in
 * two projects cannot drop each other's entries. Null when another teamai
 * process held the lock throughout: nothing was written, the next pull retries.
 */
export async function reconcileAutoCompactLocked(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<AutoCompactChange[] | null> {
  const run = await withFileLock(`${autoCompactRecordPath()}.lock`, RECORD_LOCK_WAIT, async () => {
    const record = await loadAutoCompactRecord();
    const { changes, managed } = await reconcileAutoCompactForConfig(teamConfig, localConfig, record);
    if (JSON.stringify(managed) !== JSON.stringify(record)) await saveAutoCompactRecord(managed);
    return changes;
  });
  return run.held ? run.value : null;
}

/** Installed, not excluded tools this policy can reach, with the file each reads. */
async function resolveTargets(localConfig: LocalConfig): Promise<Target[]> {
  const families: [readonly ToolId[], Kind, string][] = [
    [CLAUDE_TOOLS, 'claude', 'settings.json'],
    [BUDDY_TOOLS, 'buddy', 'settings.json'],
    [CODEX_TOOL_IDS, 'codex', 'config.toml'],
    [['dsh'], 'dsh', 'cordis.patch.yml'],
  ];
  const targets: Target[] = [];
  for (const [tools, kind, file] of families) {
    for (const tool of tools) {
      if (isAgentExcluded(localConfig, tool)) continue;
      // A root the member recorded at init (CODEX_HOME, CLAUDE_CONFIG_DIR) wins,
      // so a pull from a shell without the variable still finds it.
      const home = recordedToolRootDir(tool, localConfig.toolRoots) ?? toolHome(tool);
      if (!(await pathExists(home))) continue;
      targets.push({ tool, kind, file: path.join(home, file) });
    }
  }
  return targets;
}

// ─── Per-kind value computation ──────────────────────────────

/** The value to write, or a reason not to write one for this tool. */
type Desired = { value: unknown } | { skip: string };

function claudeValue(tokens: number, settings: Record<string, unknown>): Desired {
  const env = settings.env as Record<string, unknown> | undefined;
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined) {
    return { skip: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and overrides autoCompactWindow' };
  }
  const window = tokens + CLAUDE_BUFFER;
  if (window < WINDOW_MIN || window > WINDOW_MAX) {
    return { skip: `${tokens} tokens is outside what autoCompactWindow can express (${WINDOW_MIN - CLAUDE_BUFFER}..${WINDOW_MAX - CLAUDE_BUFFER})` };
  }
  return { value: window };
}

/**
 * The mid-turn compaction ratio the tool's cached product config sets
 * (`tokenUsageThresholds.inputTokens.emergency`, newest cache file first),
 * else the built-in default.
 */
async function buddyRatio(home: string): Promise<number> {
  const dir = path.join(home, 'cache');
  let names: string[] = [];
  try {
    const entries = await fs.readdir(dir);
    const candidates = entries.filter((n) => /^acc-product-config-v3.*\.json$/.test(n));
    const stamped = await Promise.all(candidates.map(async (n) => ({ n, t: (await fs.stat(path.join(dir, n))).mtimeMs })));
    names = stamped.sort((a, b) => b.t - a.t).map((s) => s.n);
  } catch {
    return BUDDY_DEFAULT_RATIO;
  }
  for (const name of names) {
    const read = await readJsonObject(path.join(dir, name));
    if (read.kind !== 'ok') continue;
    const ratio = findEmergencyRatio(read.value);
    if (ratio !== undefined) return ratio;
  }
  return BUDDY_DEFAULT_RATIO;
}

function findEmergencyRatio(node: unknown): number | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const thresholds = (node as Record<string, unknown>).tokenUsageThresholds as Record<string, unknown> | undefined;
  const emergency = (thresholds?.inputTokens as Record<string, unknown> | undefined)?.emergency;
  if (typeof emergency === 'number' && emergency > 0 && emergency <= 1) return emergency;
  for (const child of Object.values(node as Record<string, unknown>)) {
    const found = findEmergencyRatio(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function buddyValue(tokens: number, tool: ToolId, home: string): Promise<Desired> {
  if (process.env.CODEBUDDY_AUTO_COMPACT_WINDOW) {
    return { skip: 'CODEBUDDY_AUTO_COMPACT_WINDOW is set and overrides autoCompactWindow' };
  }
  const models = await readJsonObject(path.join(home, 'models.json'));
  const list = models.kind === 'ok' ? models.value.models : undefined;
  if (Array.isArray(list) && list.some((m) => !(typeof (m as Record<string, unknown>)?.maxInputTokens === 'number'))) {
    return { skip: `a custom model in ${tool}'s models.json has no maxInputTokens, so ${tool} would compact it only at autoCompactWindow itself` };
  }
  const ratio = await buddyRatio(home);
  const window = Math.ceil(tokens / ratio);
  if (window < WINDOW_MIN || window > WINDOW_MAX) {
    return { skip: `${tokens} tokens is outside what autoCompactWindow can express at ratio ${ratio}` };
  }
  return { value: window };
}

/** Context windows of the models dsh can route to: DeepSeek's own, plus the `llm-pi-ai` providers patched in. */
async function dshModels(home: string): Promise<{ provider: string; model: string; window: number }[]> {
  const models = DSH_DEEPSEEK_MODELS.map((model) => ({ provider: 'deepseek-official', model, window: DSH_DEEPSEEK_WINDOW }));
  const files = [path.join(home, 'cordis.patch.yml')];
  try {
    for (const profile of await fs.readdir(path.join(home, 'profiles'))) {
      files.push(path.join(home, 'profiles', profile, 'cordis.patch.yml'));
    }
  } catch {
    // no profiles yet
  }
  for (const file of files) {
    const rows = parseRows(await readFileSafe(file));
    for (const row of rows ?? []) {
      if (row?.id !== 'llm-pi-ai') continue;
      const providers = (row.config as Record<string, unknown> | undefined)?.providers as Record<string, { models?: unknown }> | undefined;
      for (const [provider, def] of Object.entries(providers ?? {})) {
        for (const m of Array.isArray(def?.models) ? def.models : []) {
          const { id, contextWindow } = m as { id?: unknown; contextWindow?: unknown };
          if (typeof id !== 'string' || typeof contextWindow !== 'number') continue;
          if (!models.some((x) => x.provider === provider && x.model === id)) models.push({ provider, model: id, window: contextWindow });
        }
      }
    }
  }
  return models;
}

async function dshValue(tokens: number, home: string): Promise<Desired> {
  const policies = (await dshModels(home))
    .map(({ provider, model, window }) => ({ provider, model, thresholdRatio: Math.round((tokens / window) * 10_000) / 10_000 }))
    .filter((p) => p.thresholdRatio > DSH_RETAIN_RATIO && p.thresholdRatio < DSH_DEFAULT_RATIO);
  if (policies.length === 0) return { skip: `no model's window puts ${tokens} tokens between ${DSH_RETAIN_RATIO} and ${DSH_DEFAULT_RATIO} of it` };
  return { value: { modelPolicies: policies } };
}

// ─── Reading and writing each file kind ──────────────────────

function parseRows(source: string | null): Record<string, unknown>[] | null {
  if (source === null) return [];
  const doc = YAML.parseDocument(source);
  if (doc.errors.length > 0) return null;
  const value: unknown = doc.toJS();
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value as Record<string, unknown>[] : null;
}

const CODEX_KEY = 'model_auto_compact_token_limit';
// Bare or quoted (`"key"`, `'key'`): TOML treats them as the same key, and a second one is a load error.
const codexKeyLineRe = new RegExp(`^[ \\t]*(?:${CODEX_KEY}|"${CODEX_KEY}"|'${CODEX_KEY}')[ \\t]*=[ \\t]*(\\S+)`);

type MultilineQuote = '"""' | "'''";

/**
 * The top level of a config.toml: where the first table header starts
 * (`source.length` when there is none) and the top-level key line, if any.
 * Lines inside a multiline string are content, never a header or a key, so a
 * `[Rules]` in `developer_instructions = """..."""` does not end the region.
 */
function scanTomlTop(source: string): { tableAt: number; key: { start: number; end: number; value: string } | null } {
  let open: MultilineQuote | null = null;
  let key: { start: number; end: number; value: string } | null = null;
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf('\n', offset);
    const end = newline === -1 ? source.length : newline + 1;
    const line = source.slice(offset, end);
    if (open === null) {
      // A table header may be indented.
      if (/^[ \t]*\[/.test(line)) return { tableAt: offset, key };
      const match = codexKeyLineRe.exec(line);
      if (match && !key) key = { start: offset, end, value: match[1] };
    }
    open = multilineOpenAfter(line, open);
    offset = end;
  }
  return { tableAt: source.length, key };
}

function backslashesBefore(line: string, at: number): number {
  let n = 0;
  while (at - n - 1 >= 0 && line[at - n - 1] === '\\') n++;
  return n;
}

/** The multiline string still open after `line`, given the one open before it. */
function multilineOpenAfter(line: string, open: MultilineQuote | null): MultilineQuote | null {
  let i = 0;
  while (i < line.length) {
    if (open !== null) {
      let close = line.indexOf(open, i);
      // In a basic string, a quote after an odd run of backslashes is escaped.
      while (close > 0 && open === '"""' && backslashesBefore(line, close) % 2 === 1) close = line.indexOf(open, close + 1);
      if (close === -1) return open;
      i = close + 3;
      open = null;
      continue;
    }
    const c = line[i];
    if (c === '#') return null;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      open = line.slice(i, i + 3) as MultilineQuote;
      i += 3;
    } else if (c === '"' || c === "'") {
      // A one-line string: skip to its closing quote.
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += c === '"' && line[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else {
      i++;
    }
  }
  return open;
}

/** Set (value) or drop (null) the top-level `model_auto_compact_token_limit` by text, keeping every other byte. */
export function spliceCodexAutoCompact(source: string, value: number | null): string {
  const { tableAt, key } = scanTomlTop(source);
  const head = source.slice(0, tableAt);
  const tail = source.slice(tableAt);
  if (value === null) {
    if (!key) return source;
    // Also drop the blank line inserted with the key right before a table header.
    const after = source.slice(key.end, tableAt);
    return source.slice(0, key.start) + (tail && after === '\n' ? '' : after) + tail;
  }
  const line = `${CODEX_KEY} = ${value}\n`;
  if (key) return source.slice(0, key.start) + line + source.slice(key.end);
  const lead = head.length === 0 || head.endsWith('\n') ? '' : '\n';
  return head + lead + line + (tail ? '\n' : '') + tail;
}

/** The current value as JSON text (undefined when absent), or `unreadable`. */
async function readCurrent(t: Target): Promise<{ current: string | undefined; doc?: Record<string, unknown> } | 'unreadable'> {
  if (t.kind === 'claude' || t.kind === 'buddy') {
    const read = await readJsonObject(t.file);
    if (read.kind === 'invalid') return 'unreadable';
    const doc = read.kind === 'ok' ? read.value : {};
    return { current: doc.autoCompactWindow === undefined ? undefined : JSON.stringify(doc.autoCompactWindow), doc };
  }
  const source = await readFileSafe(t.file);
  if (t.kind === 'codex') {
    const { key } = scanTomlTop(source ?? '');
    return { current: key ? JSON.stringify(Number(key.value)) : undefined };
  }
  const rows = parseRows(source);
  if (rows === null) return 'unreadable';
  const row = rows.filter((r) => r?.id === DSH_ROW_ID).at(-1);
  return { current: row ? JSON.stringify(row.config ?? null) : undefined };
}

/** Write `value`, or remove the setting when it is null. */
async function apply(t: Target, value: unknown, doc?: Record<string, unknown>): Promise<void> {
  if (t.kind === 'claude' || t.kind === 'buddy') {
    const next = { ...doc };
    if (value === null) delete next.autoCompactWindow;
    else next.autoCompactWindow = value;
    await writeJson(t.file, next);
    return;
  }
  const source = (await readFileSafe(t.file)) ?? '';
  if (t.kind === 'codex') {
    await writeFile(t.file, spliceCodexAutoCompact(source, value as number | null));
    return;
  }
  const yamlDoc: YAML.Document = YAML.parseDocument(source);
  if (yamlDoc.contents === null) yamlDoc.contents = yamlDoc.createNode([]);
  const rows = yamlDoc.contents as YAML.YAMLSeq;
  rows.items = rows.items.filter((row) => !(YAML.isMap(row) && row.get('id') === DSH_ROW_ID));
  if (value !== null) rows.items.push(yamlDoc.createNode({ id: DSH_ROW_ID, config: value }));
  // dsh refuses an empty patch file: an empty list is the "no rows" form.
  await writeFile(t.file, rows.items.length === 0 && !/#/.test(source) ? '[]\n' : yamlDoc.toString());
}

// ─── Main entry ──────────────────────────────────────────────

/**
 * Reconcile every installed tool's auto-compact setting to the resolved
 * threshold. Idempotent. Returns the changes plus the next record.
 */
export async function reconcileAutoCompactForConfig(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  record: Readonly<Record<string, string>>,
): Promise<AutoCompactReconcileResult> {
  const managed: Record<string, string> = { ...record };
  const changes: AutoCompactChange[] = [];
  const tokens = resolveAutoCompactTokens(localConfig, teamConfig);
  const targets = await resolveTargets(localConfig);

  for (const t of targets) {
    try {
      const read = await readCurrent(t);
      if (read === 'unreadable') {
        changes.push({ tool: t.tool, file: t.file, action: 'skipped', reason: `${t.file} could not be parsed; left as it is`, notable: true });
        continue;
      }
      const ours = managed[t.file];
      const owned = read.current === undefined || read.current === ours;

      let desired: Desired | null = null;
      if (tokens !== undefined) {
        const home = path.dirname(t.file);
        if (t.kind === 'claude') desired = claudeValue(tokens, read.doc ?? {});
        else if (t.kind === 'buddy') desired = await buddyValue(tokens, t.tool, home);
        else if (t.kind === 'codex') desired = { value: tokens };
        else desired = await dshValue(tokens, home);
      }

      if (!desired || 'skip' in desired) {
        // No policy here (or none this tool can take): give back what teamai set, if it is still there.
        if (ours !== undefined && read.current === ours) {
          await apply(t, null, read.doc);
          changes.push({ tool: t.tool, file: t.file, action: 'removed' });
        } else if (desired && 'skip' in desired) {
          changes.push({ tool: t.tool, file: t.file, action: 'skipped', reason: desired.skip, notable: true });
        }
        delete managed[t.file];
        continue;
      }

      if (!owned) {
        delete managed[t.file];
        changes.push({ tool: t.tool, file: t.file, action: 'skipped', reason: 'the member set their own value' });
        continue;
      }
      const value = JSON.stringify(desired.value);
      if (read.current === value) {
        managed[t.file] = value;
        changes.push({ tool: t.tool, file: t.file, action: 'skipped', reason: 'already applied' });
        continue;
      }
      // Record only once written: a failed write leaves the last record, which still matches the file.
      await apply(t, desired.value, read.doc);
      managed[t.file] = value;
      changes.push({ tool: t.tool, file: t.file, action: 'updated', value });
    } catch (e) {
      changes.push({ tool: t.tool, file: t.file, action: 'skipped', reason: (e as Error).message, notable: true });
    }
  }
  return { changes, managed };
}
