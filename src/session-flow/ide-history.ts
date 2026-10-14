/**
 * ide-history.ts — sync into the CodeBuddy IDE sidebar "history".
 *
 * CodeBuddy IDE (the GUI) and CodeBuddy CLI store sessions in **two independent** stores:
 *   - CLI: ~/.codebuddy/projects/<encoded-cwd>/<uuid>.jsonl
 *   - IDE: <userData>/CodeBuddyExtension/Data/<ext-id>/CodeBuddyIDE/<ext-id>/history/<md5(cwd)>/
 *
 * Writing only the CLI path means the user cannot see the migrated session in the IDE
 * sidebar "history". This module **syncs** the migration result into the IDE history
 * directory so the sidebar can show it and it can be opened to continue the chat.
 *
 * IDE path notes:
 * - workspace hash = 32-char lowercase hex of md5(cwd) (cwd is normalized with path.resolve and trailing slashes stripped)
 * - conversation id / messages directory name = 32-char hex (no hyphens), so UUIDs must have hyphens removed
 * - index.json: { conversations: [{id,type,name,createdAt,lastMessageAt,modelMap?}], current }
 * - messages/<msg-id>.json: { role, message(stringified JSON), id, extra(stringified JSON), createdAt }
 *
 * IDE content block types: text / reasoning / tool-call / tool-result
 * - tool-result is an **independent role:"tool" message** in the IDE, not merged into user/assistant
 *
 * Design principle: this module is an **enhancement**. Any failure degrades silently and must never block the main migration flow.
 */

import { assertSafeSessionFileId } from './ids.js';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ContentBlock, Session } from './ir.js';
import { imagePlaceholderText } from './ir.js';
import { mayReadLocalImageFile, safeFileName } from './fs.js';
import { isInjectedText, titleFromUserText , visibleUserText } from './title.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of one IDE-side message file (message / extra are stringified JSON). */
interface IdeMessageFile {
  role: 'user' | 'assistant' | 'tool';
  message: string;
  id: string;
  extra: string;
  createdAt: string;
}

/** A conversation entry in the IDE index.json. */
export interface IdeConversation {
  id: string;
  type: 'craft' | 'plan' | 'team-member';
  name: string;
  createdAt: string;
  lastMessageAt: string;
  modelMap?: Record<string, string>;
}

export interface IdeSyncResult {
  /** Number of IDE instances synced successfully */
  synced: number;
  /** Number of messages written (counted the IDE way; tool-result is split into its own message) */
  messageCount: number;
  /**
   * Conversation id actually written (32-char hex).
   * A non-UUID sessionId is hashed, so the caller cannot use the source sessionId as the IDE id.
   */
  convId?: string;
  /** Reason it was not synced (set when synced===0) */
  skipped?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * IDE workspace hash: 32-char lowercase hex of md5(cwd).
 * cwd is resolved first, then trailing slashes are stripped, so it matches the IDE's internal algorithm.
 *
 * It must be a **real absolute path**. session.cwd may be the encoded form stored by the source
 * platform (for example `-Users-foo-project`), which cannot be reliably reversed to a real path
 * (spaces are lost). Return null so the caller skips — better not to sync than to write
 * a wrong hash into an unrelated directory.
 */
export function hashWorkspace(cwd: string): string | null {
  // POSIX absolute path, or a Windows drive absolute path (C:\ or C:/)
  if (!cwd || !(cwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cwd))) return null;
  let normalized = path.resolve(cwd).replace(/\/+$/, '');
  // On macOS /tmp is a symlink to /private/tmp, and VSCode passes the IDE the resolved real path.
  // Without realpath, "write via /tmp, list via /private/tmp" computes two different workspace
  // hashes: the write succeeds but listing cannot find it, and the user thinks the migration was lost.
  try {
    normalized = fs.realpathSync(normalized).replace(/\/+$/, '');
  } catch {
    // Keep the original path when the directory does not exist (createIfMissing case)
  }
  return crypto.createHash('md5').update(normalized).digest('hex');
}

/**
 * Conversation id: the IDE uses 32-char hex (no hyphens).
 *
 * All three input shapes must map back to the **same** id, or reads and deletes each compute their own:
 * - 32-char hex (native IDE / id read by codebuddy-ide) → reuse as-is
 * - Hyphenated UUID (sessionId from other platforms) → strip hyphens
 * - Anything else → md5 fallback
 *
 * Missing the first case double-hashes the IDE-side session id: write generates a new id,
 * rollback hashes it again into a different one, and the directory cannot be deleted — success
 * is reported but a permanent leftover remains.
 */
function toIdeConvId(sessionId: string): string {
  if (/^[0-9a-f]{32}$/i.test(sessionId)) return sessionId.toLowerCase();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(sessionId)) return sessionId.replace(/-/g, '').toLowerCase();
  return crypto.createHash('md5').update(sessionId).digest('hex');
}

/**
 * CodeBuddyExtension user-data root (cross-platform).
 */
export function getUserDataBase(): string | null {
  // Tests set this so fixtures stay under a temp directory. Coverage runs do
  // not apply the node:os homedir mock, and writing the real home pollutes
  // later tests on the same machine.
  const override = process.env.TEAMAI_CODEBUDDY_IDE_DATA?.trim();
  if (override) return override;
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data');
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
        'CodeBuddyExtension',
        'Data',
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
        'CodeBuddyExtension',
        'Data',
      );
  }
}

/**
 * List the history root of every IDE instance.
 *
 * Two layouts exist on disk, and both are real:
 *   - <base>/<extId>/CodeBuddyIDE/<instId>/history   regular instance (instId usually matches extId)
 *   - <base>/<extId>/CodeBuddyIDE/history            default instance, one fewer instId level
 *
 * Recognizing only the first makes every session under the default instance disappear
 * (neither readable nor writable), so both are collected.
 */
export function listIdeHistoryRoots(): string[] {
  const base = getUserDataBase();
  if (!base || !fs.existsSync(base)) return [];

  const out: string[] = [];
  try {
    for (const extId of fs.readdirSync(base)) {
      const ideRoot = path.join(base, extId, 'CodeBuddyIDE');
      if (!fs.existsSync(ideRoot)) continue;

      const direct = path.join(ideRoot, 'history');
      if (fs.existsSync(direct)) out.push(direct);

      for (const instId of fs.readdirSync(ideRoot)) {
        if (instId === 'history') continue;
        const historyRoot = path.join(ideRoot, instId, 'history');
        if (fs.existsSync(historyRoot)) out.push(historyRoot);
      }
    }
  } catch {
    return out;
  }

  return out;
}

/**
 * Find the history directory for this cwd under every IDE instance.
 *
 * Usually there is only 1 (single user, single instance). With multiple instances, return all of them and write each.
 * When createIfMissing=true, if this project's history directory does not exist yet (the IDE has never opened this project),
 * still return the path to be created so it is visible the next time the IDE opens.
 */
export function findIdeHistoryDirs(cwd: string, createIfMissing = false): string[] {
  const hash = hashWorkspace(cwd);
  if (!hash) return []; // cwd is not a real absolute path; skip sync

  const out: string[] = [];
  for (const historyRoot of listIdeHistoryRoots()) {
    const target = path.join(historyRoot, hash);
    if (fs.existsSync(target) || createIfMissing) out.push(target);
  }
  return out;
}

// ---------------------------------------------------------------------------
// IR → IDE conversion
// ---------------------------------------------------------------------------

/**
 * Pick a model name for modelMap / extra.
 * Prefer session.metadata.model, then the first message that carries a model.
 */
function pickModel(session: Session): string | undefined {
  if (session.metadata?.model) return String(session.metadata.model);
  for (const m of session.messages) {
    if (m.metadata?.model) return String(m.metadata.model);
  }
  return undefined;
}

/**
 * IR Session → IDE message list.
 *
 * One IR message may expand into several IDE messages:
 * - thinking/text/tool_call are combined into one (role stays user/assistant)
 * - tool_result is split into an independent role:"tool" message
 */
/**
 * Deterministic 32-char hex id (derived from content).
 *
 * The message file name is the message id, so the id must be **stable for the same input** —
 * randomUUID would generate a new file name on every migration. Old files would be neither
 * overwritten nor cleaned up, and messages/ would leak a batch of orphans on each migration.
 */
function stableId(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function toEpochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Resolve createdAt for each message.
 *
 * Source platforms often do not record per-message timestamps. Falling back to session.updatedAt
 * for every message makes the whole session share one time (in practice 468 of 484 messages were
 * identical), and the IDE timeline grouping / relative times look clearly wrong.
 * Linearly interpolate between known timestamps here, and force them to be strictly increasing.
 */
function resolveTimestamps(session: Session): string[] {
  const n = session.messages.length;
  const base = toEpochMs(session.createdAt) ?? Date.now();
  const tailRaw = toEpochMs(session.updatedAt);
  const tail = tailRaw !== undefined && tailRaw >= base ? tailRaw : base;

  if (n === 0) return [];

  // Virtual bounds: index -1 = createdAt, index n = updatedAt
  const known: Array<{ i: number; t: number }> = [
    { i: -1, t: base },
    { i: n, t: tail },
  ];
  session.messages.forEach((m, i) => {
    const t = toEpochMs(m.timestamp);
    if (t !== undefined) known.push({ i, t });
  });
  known.sort((a, b) => a.i - b.i);

  const ts: number[] = Array.from({ length: n });
  for (const p of known) {
    if (p.i >= 0 && p.i < n) ts[p.i] = p.t;
  }
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k];
    const b = known[k + 1];
    for (let i = a.i + 1; i <= b.i - 1; i++) {
      const ratio = (i - a.i) / (b.i - a.i);
      ts[i] = Math.round(a.t + (b.t - a.t) * ratio);
    }
  }

  // Force strictly increasing (at least +1ms): interpolation still produces many identical values inside a collapsed range
  for (let i = 1; i < n; i++) {
    if (!(ts[i] > ts[i - 1])) ts[i] = ts[i - 1] + 1;
  }

  return ts.map((t) => new Date(Number.isFinite(t) ? t : base).toISOString());
}

/** Session asset (image) waiting to be written. Prefer data, then copy from sourcePath. */
export interface IdeAsset {
  /** File name under assets/ (keeps the native image.<hash8>.<ext> naming style) */
  name: string;
  /** Absolute path of the source file (copy this first when present, to avoid a base64 round trip) */
  sourcePath?: string;
  /** base64 content (fallback when filePath is unreadable) */
  data?: string;
}

function irToIdeMessages(session: Session): { messages: IdeMessageFile[]; assets: IdeAsset[] } {
  const out: IdeMessageFile[] = [];
  const assets: IdeAsset[] = [];
  const usedNames = new Set<string>();
  const model = pickModel(session);
  const timestamps = resolveTimestamps(session);

  // callId → toolName map (tool-result needs toolName filled back in)
  const toolNameByCallId = new Map<string, string>();
  for (const msg of session.messages) {
    for (const b of msg.content) {
      if (b.type === 'tool_call' && b.callId) toolNameByCallId.set(b.callId, b.toolName);
    }
  }

  // IR image block → assets/<name> + codebuddy-asset:// ref (matches native storage)
  const assetRef = (b: Extract<ContentBlock, { type: 'image' }>): string | null => {
    // The label is archive-controlled when the session came from the team
    // repo: `../../evil` would otherwise become a path component and write
    // outside assets/. Force it down to a bare file name.
    const base = safeFileName(b.label || path.basename(b.filePath ?? 'image.png') || 'image.png');
    const ext = path.extname(base) || `.${(b.mimeType.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`;
    const stem = base.slice(0, base.length - ext.length) || 'image';
    let name = `${safeFileName(stem, 'image')}${ext}`;
    for (let i = 1; usedNames.has(name); i++) name = `${safeFileName(stem, 'image')}-${i}${ext}`;
    usedNames.add(name);
    if (mayReadLocalImageFile(session, b.filePath) && b.filePath && fs.existsSync(b.filePath)) {
      assets.push({ name, sourcePath: b.filePath });
    } else if (b.data) {
      assets.push({ name, data: b.data });
    } else {
      return null; // No usable content: the caller degrades to placeholder text
    }
    return `codebuddy-asset://assets/${name}`;
  };

  session.messages.forEach((msg, msgIdx) => {
    const ts = timestamps[msgIdx];
    const msgModel = msg.metadata?.model ?? model;
    const extra = JSON.stringify({
      requestId: stableId([session.sessionId, String(msgIdx), 'request']),
      modelId: msgModel ? `custom-local:${msgModel}` : 'custom-local:unknown',
      modelName: msgModel ?? 'unknown',
      isHelperMessage: false,
    });

    // 1) thinking + text + image + tool_call → one message
    const content: Record<string, unknown>[] = [];
    for (const b of msg.content) {
      if (b.type === 'thinking') {
        content.push({ type: 'reasoning', text: b.text });
      } else if (b.type === 'text') {
        // IDE messages are the display layer (there is no separate raw copy
        // like codex's response_item): strip injected wrappers
        // (<user_query>/<timestamp>/<image_files>...) and attachment paths
        // from user text so the bubble shows the real question.
        const text = msg.role === 'user' ? visibleUserText(b.text) : b.text;
        if (text) content.push({ type: 'text', text });
      } else if (b.type === 'image') {
        const ref = assetRef(b);
        if (ref) {
          content.push({ type: 'image', image: ref });
        } else {
          content.push({ type: 'text', text: imagePlaceholderText(b) });
        }
      } else if (b.type === 'tool_call') {
        content.push({
          type: 'tool-call',
          toolCallId:
            b.callId ||
            stableId([
              session.sessionId,
              String(msgIdx),
              'tool-call',
              b.toolName,
              JSON.stringify(b.arguments ?? {}),
            ]),
          toolName: b.toolName,
          args: b.arguments ?? {},
        });
      }
    }

    if (content.length > 0) {
      out.push({
        role: msg.role,
        message: JSON.stringify({ role: msg.role, content }),
        // The message id becomes a file name (messages/<id>.json). Ids read
        // back from an archive are untrusted: accept only the safe shape and
        // fall back to a locally derived id otherwise.
        id: /^[A-Za-z0-9_-]{1,128}$/.test(msg.messageId ?? '')
          ? (msg.messageId as string)
          : stableId([session.sessionId, String(msgIdx), 'message']),
        extra,
        createdAt: ts,
      });
    }

    // 2) tool_result → independent role:"tool" message
    for (const b of msg.content) {
      if (b.type !== 'tool_result') continue;
      out.push({
        role: 'tool',
        message: JSON.stringify({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: b.callId,
              toolName: toolNameByCallId.get(b.callId) ?? 'Agent',
              // Element-level isError: the IDE uses it to render a failed tool as an error state.
              // If it is missing it is treated as success (falsy), and a failed call looks like a normal return.
              isError: Boolean(b.isError),
              result: {
                status: b.isError ? 'failed' : 'success',
                success: !b.isError,
                result: { type: 'text_result', content: b.content },
              },
            },
          ],
        }),
        id: stableId([
          session.sessionId,
          String(msgIdx),
          'tool-result',
          b.callId ?? '',
          String(b.content),
        ]),
        extra,
        createdAt: ts,
      });
    }
  });

  return { messages: out, assets };
}

// ---------------------------------------------------------------------------
// index.json read/write
// ---------------------------------------------------------------------------

interface IdeIndex {
  conversations?: IdeConversation[];
  current?: string;
  [key: string]: unknown;
}

function readIndex(historyDir: string): IdeIndex {
  const idxPath = path.join(historyDir, 'index.json');
  if (!fs.existsSync(idxPath)) return { conversations: [] };
  try {
    const data = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as IdeIndex;
    if (!Array.isArray(data.conversations)) data.conversations = [];
    return data;
  } catch {
    // When index.json is corrupt, try to restore from the backup
    const bakPath = path.join(historyDir, '.index_bak.json');
    try {
      const data = JSON.parse(fs.readFileSync(bakPath, 'utf-8')) as IdeIndex;
      if (!Array.isArray(data.conversations)) data.conversations = [];
      return data;
    } catch {
      return { conversations: [] };
    }
  }
}

function writeIndex(historyDir: string, data: IdeIndex): void {
  const idxPath = path.join(historyDir, 'index.json');
  // Back up before writing, matching the IDE's own .index_bak.json convention
  if (fs.existsSync(idxPath)) {
    try {
      fs.copyFileSync(idxPath, path.join(historyDir, '.index_bak.json'));
    } catch {
      // A failed backup must not block the write
    }
  }
  fs.writeFileSync(idxPath, JSON.stringify(data, null, 2), 'utf-8');
}

function upsertConversation(historyDir: string, conv: IdeConversation): void {
  const data = readIndex(historyDir);
  const convs = data.conversations as IdeConversation[];
  const i = convs.findIndex((c) => c.id === conv.id);
  if (i >= 0) convs[i] = conv;
  else convs.push(conv);
  data.conversations = convs;
  // A native index.json always has top-level current (pointing at the current session). A new
  // workspace does not have it naturally. If it is missing, the IDE may open that workspace with
  // nothing selected → fill in the conversation just written.
  if (!data.current) data.current = conv.id;
  writeIndex(historyDir, data);
}

function removeConversation(historyDir: string, convId: string): void {
  const data = readIndex(historyDir);
  const convs = (data.conversations as IdeConversation[]).filter((c) => c.id !== convId);
  if (convs.length === (data.conversations as IdeConversation[]).length) return; // No change
  data.conversations = convs;
  if (data.current === convId) data.current = convs[convs.length - 1]?.id;
  writeIndex(historyDir, data);
}

function removeDirRecursive(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sync a session into CodeBuddy IDE history (visible in the sidebar "history").
 * Failures degrade silently and do not throw.
 */
/**
 * System prefixes injected by the source platform. The first "user message" is often this
 * wrapper text, and using it as the title would leak raw prompt text into the IDE sidebar history list.
 */
const SYSTEM_INJECTED_TITLE = /^\s*<(local-command-caveat|local-command-stdout|system-reminder|system|command-name|command-message|command-args|command-contents|timestamp)\b/i;

/**
 * Session title: clean system-injected text, and fall back to the first real user text when no usable title is found.
 */
/** Placeholder name when the source adapter cannot produce a title (for example "Session 2bf4d3be") — must not be used as the session title. */
const PLACEHOLDER_TITLE = /^session\s+[0-9a-f]{8}$/i;

function cleanTitle(session: Session, convId: string): string {
  const raw = (session.title ?? '').replace(/\s+/g, ' ').trim();
  if (raw && !PLACEHOLDER_TITLE.test(raw) && !SYSTEM_INJECTED_TITLE.test(raw)) return raw.slice(0, 100);

  for (const m of session.messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type !== 'text') continue;
      // The source platform's first user message is often wrapped in <user_info>/<rules>/<additional_data>
      // and attachment paths. Using the raw text as the title makes the whole span look injected →
      // fall back to "Session xxxxxxxx". Clean first (unwrap <user_query> + strip metadata + drop
      // attachment paths), then take the title.
      const cleaned = titleFromUserText(b.text);
      if (cleaned) return cleaned.slice(0, 100);
      const t = b.text.replace(/\s+/g, ' ').trim();
      // isInjectedText is the full injected-tag-head list maintained in title.ts (it evolves with META_BLOCK_RE).
      // SYSTEM_INJECTED_TITLE is kept only as a second check — one source of truth, so adding a tag
      // does not miss one of the two sides.
      if (t && !isInjectedText(t) && !SYSTEM_INJECTED_TITLE.test(t)) return t.slice(0, 100);
    }
  }
  return `Session ${convId.slice(0, 8)}`;
}

interface IdeRequest {
  id: string;
  type: 'craft';
  /** Message ids in this turn (the user message and the assistant/tool messages after it) */
  messages: string[];
  state: string;
  /** Epoch milliseconds, matching native IDE (a number, not an ISO string) */
  startedAt: number;
  usage?: Record<string, unknown>;
}

/**
 * Split IDE requests by user turn.
 *
 * Why it must be written: the consumer `dashboard-collector` guards with
 * `if (!Array.isArray(data.requests)) return null`. Missing this array makes stats such as
 * prompts (user-turn count) silently go to zero **as a whole**, not just tokens.
 *
 * Why usage is omitted: IR does not carry token usage. Writing 0 out of nowhere would disguise
 * "unknown" as "measured as 0". The consumer skips accumulation when usage is missing, so omitting
 * it is safe and honest — tokens stay 0, but prompts and the other stats recover.
 */
function buildIdeRequests(session: Session, messages: IdeMessageFile[]): IdeRequest[] {
  const requests: IdeRequest[] = [];
  let cur: IdeRequest | null = null;

  const openRequest = (startedAtIso: string): IdeRequest => ({
    id: stableId([session.sessionId, 'request', String(requests.length)]),
    type: 'craft',
    messages: [],
    state: 'complete',
    startedAt: toEpochMs(startedAtIso) ?? toEpochMs(session.createdAt) ?? Date.now(),
  });

  for (const m of messages) {
    if (m.role === 'user') {
      if (cur) requests.push(cur);
      cur = openRequest(m.createdAt);
    } else if (!cur) {
      // First message is not user (rare): open a fallback turn so the message is not unowned
      cur = openRequest(m.createdAt);
    }
    cur.messages.push(m.id);
  }
  if (cur) requests.push(cur);

  return requests;
}

export function writeIdeSession(session: Session, cwd: string): IdeSyncResult {
  const dirs = findIdeHistoryDirs(cwd, true);
  if (dirs.length === 0) {
    return {
      synced: 0,
      messageCount: 0,
      skipped: 'CodeBuddy IDE storage not found (not installed or initialized); only the CLI path was written',
    };
  }

  const convId = toIdeConvId(session.sessionId);
  const { messages, assets } = irToIdeMessages(session);
  const model = pickModel(session);
  const requests = buildIdeRequests(session, messages);

  const conv: IdeConversation = {
    id: convId,
    type: 'craft',
    name: cleanTitle(session, convId),
    createdAt: session.createdAt,
    // lastMessageAt uses the migration time, not the source session time: the IDE list groups by
    // recent activity. Keeping the source time buries the migrated session in an "N days ago"
    // group, so the user cannot find it at the top after migrating. The source timeline stays in
    // createdAt (list details) and in message timestamps (after the session is opened).
    lastMessageAt: new Date().toISOString(),
    ...(model ? { modelMap: { ask: model, craft: model, plan: model } } : {}),
  };

  let synced = 0;
  for (const historyDir of dirs) {
    try {
      const convDir = path.join(historyDir, convId);
      const msgDir = path.join(convDir, 'messages');

      // Idempotent: rerunning a migration must clear messages/ first.
      // Message file name = message id. Leftover files from older versions are neither overwritten
      // nor indexed, so they become orphans and the directory grows without bound as migrations repeat.
      const marker = path.join(msgDir, '.teamai-migrated');
      if (fs.existsSync(msgDir) && !fs.existsSync(marker)) {
        const backup = path.join(convDir, `messages.backup-${Date.now()}`);
        fs.renameSync(msgDir, backup);
      } else if (fs.existsSync(msgDir)) {
        for (const f of fs.readdirSync(msgDir)) {
          if (f.endsWith('.json')) fs.unlinkSync(path.join(msgDir, f));
        }
      }
      fs.mkdirSync(msgDir, { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');

      // Write image assets: put them in <convDir>/assets/ like native storage, and reference them
      // in messages as codebuddy-asset://assets/<name>. If one asset fails, degrade only that image
      // (replace it with placeholder text) and do not block writing the whole session.
      if (assets.length > 0) {
        const assetsDir = path.join(convDir, 'assets');
        try {
          fs.mkdirSync(assetsDir, { recursive: true });
        } catch {
          // If the directory cannot be created, the per-asset writes below fail and fall back to placeholders
        }
        for (const asset of assets) {
          let ok = false;
          try {
            const dest = path.join(assetsDir, asset.name);
            // Belt and braces: never write outside assets/ even if a name
            // slips past safeFileName.
            if (path.relative(assetsDir, dest).startsWith('..')) throw new Error('unsafe asset name');
            if (asset.sourcePath && fs.existsSync(asset.sourcePath)) {
              fs.copyFileSync(asset.sourcePath, dest);
              ok = true;
            } else if (asset.data) {
              fs.writeFileSync(dest, Buffer.from(asset.data, 'base64'));
              ok = true;
            }
          } catch {
            ok = false;
          }
          if (!ok) {
            const ref = `codebuddy-asset://assets/${asset.name}`;
            for (const m of messages) {
              let body: { role?: string; content?: Array<Record<string, unknown>> };
              try {
                body = JSON.parse(m.message);
              } catch {
                continue;
              }
              if (!Array.isArray(body.content)) continue;
              const idx = body.content.findIndex(
                (c) => c.type === 'image' && c.image === ref,
              );
              if (idx >= 0) {
                body.content[idx] = { type: 'text', text: `[image: ${asset.name} (asset write failed)]` };
                m.message = JSON.stringify(body);
              }
            }
          }
        }
      }

      // Write each message and collect the order index at the same time.
      // The conversation-level index.json is the **message order index** — the IDE uses it to decide
      // display order. Writing only messages/*.json without it opens a blank session.
      const messageIndex: Array<Record<string, unknown>> = [];
      for (const m of messages) {
        fs.writeFileSync(path.join(msgDir, `${m.id}.json`), JSON.stringify(m, null, 2), 'utf-8');
        messageIndex.push({ id: m.id, type: 'text', role: m.role, isComplete: true });
      }

      // Back up before writing, matching the IDE's own .index_bak.json convention
      // (native session directories all carry it, so a corrupt index can heal itself)
      const convIdxPath = path.join(convDir, 'index.json');
      if (fs.existsSync(convIdxPath)) {
        try {
          fs.copyFileSync(convIdxPath, path.join(convDir, '.index_bak.json'));
        } catch {
          // A failed backup must not block the write
        }
      }

      fs.writeFileSync(
        convIdxPath,
        JSON.stringify({ messages: messageIndex, requests }, null, 2),
        'utf-8',
      );

      upsertConversation(historyDir, conv);
      synced++;
    } catch {
      // A failed sync of one IDE instance does not affect other instances or the main CLI-path flow
    }
  }

  return {
    synced,
    messageCount: messages.length,
    ...(synced > 0 ? { convId } : { skipped: 'failed to write IDE history directories' }),
  };
}

/**
 * Walk every IDE instance's history and locate the session directory by convId.
 *
 * On rollback the cwd is often an encoded directory name (decodeCwdGeneric is the identity
 * function and cannot restore the real path), so the workspace hash cannot be computed. convId
 * is globally unique, so search globally and do not depend on cwd.
 */
export function findIdeConversationDirs(convId: string): Array<{ historyDir: string; convDir: string }> {
  const out: Array<{ historyDir: string; convDir: string }> = [];
  try {
    for (const historyRoot of listIdeHistoryRoots()) {
      for (const wsHash of fs.readdirSync(historyRoot)) {
        const historyDir = path.join(historyRoot, wsHash);
        if (!fs.statSync(historyDir).isDirectory()) continue;
        const convDir = path.join(historyDir, convId);
        if (fs.existsSync(convDir)) out.push({ historyDir, convDir });
      }
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Delete a session from CodeBuddy IDE history (cleanup on rollback).
 * Returns the number of IDE instances cleaned.
 *
 * cwd is optional: when given, also clean orphan index entries for that project as a fallback,
 * but cleanup by convId still works when it is omitted.
 */
export function deleteIdeSession(sessionId: string, cwd?: string): number {
  assertSafeSessionFileId(sessionId);
  const convId = toIdeConvId(sessionId);

  // When cwd is given and a workspace can be resolved, clean only that workspace:
  // findIdeConversationDirs walks every workspace hash, and the same sessionId can exist in
  // several workspaces at once (the same session migrated into projects A and B). A global
  // delete by convId would also delete the copy in the other workspace — unrecoverable data loss.
  //
  // Once cwd is given it is the **user's explicit scope** (rollback --cwd <real path>): if the
  // workspace cannot be resolved, report that nothing was deleted. Never fall back to a global
  // delete. A global fallback would delete the same-named copy in other projects — unrecoverable
  // data loss, much worse than leaving a leftover.
  // Only when the caller omits cwd (automatic rollback after a failed migrate) is cleanup global by convId.
  const scoped = cwd ? findIdeHistoryDirs(cwd, false) : [];
  if (cwd && scoped.length === 0) {
    console.warn(
      `  · No CodeBuddy IDE workspace matches ${cwd}; nothing deleted. Pass no --cwd to delete every copy.`,
    );
    return 0;
  }
  const targets: Array<{ historyDir: string; convDir: string }> = scoped.length > 0
    ? scoped.map((historyDir) => ({ historyDir, convDir: path.join(historyDir, convId) }))
    : findIdeConversationDirs(convId);

  let cleaned = 0;
  for (const { historyDir, convDir } of targets) {
    // Directory deletion and index-entry cleanup must be two separate try blocks.
    // In one try, once rm throws (a large session easily races a running IDE process writing back),
    // the later removeConversation is skipped and the index entry can never be cleared —
    // the directory is still there, the sidebar still shows it, and the user thinks rollback failed
    // with no way to recover.
    try {
      removeDirRecursive(convDir);
    } catch {
      // ignore: if the directory cannot be deleted, at least make it disappear from the sidebar
    }
    try {
      removeConversation(historyDir, convId);
      cleaned++;
    } catch {
      // ignore
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// IDE → IR read (used by the codebuddy-ide adapter)
// ---------------------------------------------------------------------------

/** One parsed IDE message (content is the native IDE block array). */
export interface IdeMessageParsed {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  createdAt?: string;
  content: Array<Record<string, unknown>>;
  model?: string;
}

/** One IDE session entry, with location info so the adapter can hit the directory directly without a second search. */
export interface IdeConversationEntry {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  lastMessageAt: string;
  /** history/<workspace-hash> */
  historyDir: string;
  /** md5(cwd), irreversible — cwd can be restored only if the caller passes it in */
  workspaceHash: string;
  convDir: string;
}

/**
 * Read session metadata from index.json under one workspace (history/<hash>).
 *
 * The argument is the **workspace directory**, not the history root — their subdirectory
 * meanings are completely different (a workspace contains session directories; the history root
 * contains workspace directories). Passing the wrong one returns an empty list.
 */
export function readIdeConversations(historyDir: string): IdeConversation[] {
  return (readIndex(historyDir).conversations ?? []).filter((c) => Boolean(c?.id));
}

/**
 * List every session on the IDE side.
 *
 * When historyDirs is omitted, walk every IDE instance; when it is passed, walk only the given
 * workspaces (located by md5(cwd)).
 */
export function listIdeConversations(historyDirs?: string[]): IdeConversationEntry[] {
  const roots = historyDirs ?? listIdeHistoryRoots();
  const out: IdeConversationEntry[] = [];

  for (const historyRoot of roots) {
    let wsHashes: string[] = [];
    try {
      wsHashes = fs.readdirSync(historyRoot);
    } catch {
      continue;
    }
    for (const wsHash of wsHashes) {
      const historyDir = path.join(historyRoot, wsHash);
      try {
        if (!fs.statSync(historyDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const c of readIndex(historyDir).conversations as IdeConversation[]) {
        if (!c?.id) continue;
        out.push({
          id: c.id,
          name: c.name ?? '',
          type: c.type ?? 'craft',
          createdAt: c.createdAt ?? '',
          lastMessageAt: c.lastMessageAt ?? c.createdAt ?? '',
          historyDir,
          workspaceHash: wsHash,
          convDir: path.join(historyDir, c.id),
        });
      }
    }
  }

  return out;
}

function parseIdeMessageFile(file: string): IdeMessageParsed | null {
  let raw: IdeMessageFile;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as IdeMessageFile;
  } catch {
    return null;
  }

  // message is stringified JSON. When it is corrupt (a half-written file while the IDE is writing),
  // skip the whole message. Half JSON cannot be degraded to text — stitching it back only yields unreadable garbage.
  let body: { role?: string; content?: unknown };
  try {
    body = JSON.parse(raw.message) as { role?: string; content?: unknown };
  } catch {
    return null;
  }

  const content = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];

  let model: string | undefined;
  try {
    const extra = JSON.parse(raw.extra ?? '{}') as { modelName?: string };
    if (extra?.modelName) model = String(extra.modelName).replace(/^custom-local:/, '');
  } catch {
    // A missing extra does not affect the message itself
  }

  const role = (raw.role ?? body.role ?? 'user') as IdeMessageParsed['role'];

  return {
    id: raw.id ?? path.basename(file, '.json'),
    role,
    createdAt: raw.createdAt,
    content,
    ...(model ? { model } : {}),
  };
}

/**
 * Read messages from a session directory, keeping the IDE display order.
 *
 * Order comes from the messages array in convDir/index.json — the IDE uses it to decide display
 * order. Filename dictionary order is unrelated to the real order (message ids are content hashes/UUIDs).
 * Fall back to filename sort only when the index is missing, and append orphan files the index does not cover at the end.
 */
export function readIdeConversation(convDir: string, limit?: number): IdeMessageParsed[] {
  const msgDir = path.join(convDir, 'messages');
  if (!fs.existsSync(msgDir)) return [];

  let order: string[] = [];
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(convDir, 'index.json'), 'utf-8')) as {
      messages?: Array<{ id?: string }>;
    };
    if (Array.isArray(idx.messages)) {
      order = idx.messages.map((m) => String(m?.id ?? '')).filter(Boolean);
    }
  } catch {
    order = [];
  }

  let files: string[] = [];
  try {
    files = fs.readdirSync(msgDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  if (order.length === 0) {
    files.sort();
    order = files.map((f) => f.replace(/\.json$/, ''));
  }

  const messages: IdeMessageParsed[] = [];
  const seen = new Set<string>();
  const reached = (): boolean => limit !== undefined && messages.length >= limit;

  for (const id of order) {
    if (reached()) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const parsed = parseIdeMessageFile(path.join(msgDir, `${id}.json`));
    if (parsed) messages.push(parsed);
  }
  for (const f of files) {
    if (reached()) break;
    const id = f.replace(/\.json$/, '');
    if (seen.has(id)) continue;
    seen.add(id);
    const parsed = parseIdeMessageFile(path.join(msgDir, f));
    if (parsed) messages.push(parsed);
  }

  return messages;
}
