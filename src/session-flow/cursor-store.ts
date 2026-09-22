/**
 * cursor-store.ts -- register migrated sessions into Cursor's local database.
 *
 * Background: Cursor's Agents Window does **not** list sessions by scanning
 * `~/.cursor/projects/<proj>/agent-transcripts/` -- that transcript jsonl is a
 * one-way `flushTranscriptForConversation` export from Cursor's own store. The
 * UI list comes from `composerHeaders` in state.vscdb, the body from
 * `composerData:<composerId>` and `bubbleId:<composerId>:<bubbleId>` in cursorDiskKV.
 *
 * migration "succeeds" but shows nothing.

 * Three steps here (best-effort; any failure must not lose the transcript):
 *   1. resolve the cwd to a workspaceId via User/workspaceStorage/<hash>/workspace.json
 *
 *   3. write with sqlite3 in a single transaction, INSERT OR REPLACE
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Paths and helpers
// ---------------------------------------------------------------------------

 /** Cursor user-data dir (macOS / Linux; other platforms return null = registration unsupported). */
export function getCursorStateRoot(): string | null {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Cursor');
  }
   return null; // Windows: %APPDATA%/Cursor -- not supported yet (no guaranteed sqlite3 CLI)
}

 /** Path to Cursor's state.vscdb. */
export function getCursorStateDbPath(): string | null {
  const root = getCursorStateRoot();
  return root ? path.join(root, 'User', 'globalStorage', 'state.vscdb') : null;
}

 /** Locate the sqlite3 CLI: PATH first, then well-known install locations. */
function findSqlite3(): string | null {
  const candidates = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'sqlite3')),
    '/usr/bin/sqlite3',
    '/opt/homebrew/bin/sqlite3',
    '/usr/local/bin/sqlite3',
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

 /** cwd -> Cursor workspaceId (resolved from workspaceStorage/<hash>/workspace.json's folder). */
export function resolveCursorWorkspaceId(cwd: string): { id: string; uri: CursorUri } | null {
  const root = getCursorStateRoot();
  if (!root) return null;
  const wsRoot = path.join(root, 'User', 'workspaceStorage');
  let entries: string[];
  try {
    entries = fs.readdirSync(wsRoot);
  } catch {
    return null;
  }

  const target = realpathOr(cwd);
  for (const hash of entries) {
    const wj = path.join(wsRoot, hash, 'workspace.json');
    let raw: string;
    try {
      raw = fs.readFileSync(wj, 'utf-8');
    } catch {
      continue;
    }
    let parsed: { folder?: string };
    try {
      parsed = JSON.parse(raw) as { folder?: string };
    } catch {
      continue;
    }
    const folder = parsed.folder;
    if (!folder) continue;
    const fsPath = decodeURIComponent(folder.replace(/^file:\/\//, ''));
    if (realpathOr(fsPath) !== target) continue;
    return { id: hash, uri: makeUri(folder, fsPath) };
  }
  return null;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

interface CursorUri {
  $mid: number;
  fsPath: string;
  external: string;
  path: string;
  scheme: string;
}

function makeUri(external: string, fsPath: string): CursorUri {
  return { $mid: 1, fsPath, external, path: fsPath, scheme: 'file' };
}

// ---------------------------------------------------------------------------
// Templates (field set taken from native records around Cursor 0.155)
// ---------------------------------------------------------------------------

 /** Lexical rich text: Cursor's composer/bubble render editor content with it. */
function lexical(text: string): string {
  const paragraph = text
    ? [
        {
          children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
          direction: 'ltr',
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
        },
      ]
    : [];
  return JSON.stringify({
    root: { children: paragraph, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 },
  });
}

interface BubbleTemplate {
  [k: string]: unknown;
}

 /** Tool output: the native result is a JSON string (object); bare text must be wrapped, or the UI cannot parse it. */
function encodeToolResult(raw?: string): string {
  if (!raw) return '';
  const s = raw.trim();
  if (s.startsWith('{') || s.startsWith('[')) return s;
  return JSON.stringify({ output: raw });
}

 /** Empty shape of the native composerData.context / bubble.context. */
function emptyContext(): Record<string, unknown> {
  return {
    composers: [],
    selectedCommits: [],
    selectedPullRequests: [],
    selectedImages: [],
    selectedDocuments: [],
    selectedVideos: [],
    folderSelections: [],
    fileSelections: [],
    mentions: {},
    uiElementSelections: [],
    consoleLogs: [],
    ideState: {},
    selections: [],
    terminalSelections: [],
    selectedDocs: [],
  };
}

 /** Bubble defaults (native bubble fields laid out in full so the UI never hits a missing field). */
function emptyBubble(): BubbleTemplate {
  return {
    _v: 3,
    type: 1,
    approximateLintErrors: [],
    lints: [],
    codebaseContextChunks: [],
    commits: [],
    pullRequests: [],
    attachedCodeChunks: [],
    assistantSuggestedDiffs: [],
    gitDiffs: [],
    interpreterResults: [],
    images: [],
    attachedFolders: [],
    attachedFoldersNew: [],
    bubbleId: '',
    userResponsesToSuggestedCodeBlocks: [],
    suggestedCodeBlocks: [],
    diffsForCompressingFiles: [],
    relevantFiles: [],
    toolResults: [],
    notepads: [],
    capabilities: [],
    multiFileLinterErrors: [],
    diffHistories: [],
    recentLocationsHistory: [],
    recentlyViewedFiles: [],
    isAgentic: false,
    fileDiffTrajectories: [],
    existedSubsequentTerminalCommand: false,
    existedPreviousTerminalCommand: false,
    docsReferences: [],
    webReferences: [],
    aiWebSearchResults: [],
    requestId: '',
    attachedFoldersListDirResults: [],
    humanChanges: [],
    attachedHumanChanges: false,
    summarizedComposers: [],
    cursorRules: [],
    cursorCommands: [],
    cursorCommandsExplicitlySet: false,
    pastChats: [],
    pastChatsExplicitlySet: false,
    contextPieces: [],
    editTrailContexts: [],
    allThinkingBlocks: [],
    diffsSinceLastApply: [],
    deletedFiles: [],
    supportedTools: [],
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    attachedFileCodeChunksMetadataOnly: [],
    consoleLogs: [],
    uiElementPicked: [],
    isRefunded: false,
    knowledgeItems: [],
    documentationSelections: [],
    externalLinks: [],
    projectLayouts: [],
    unifiedMode: 2,
    capabilityContexts: [],
    todos: [],
    createdAt: '',
    mcpDescriptors: [],
    workspaceUris: [],
    conversationState: '~',
    text: '',
  };
}

// ---------------------------------------------------------------------------
// Build head / composerData / bubbles
// ---------------------------------------------------------------------------

export interface CursorComposerTool {
  name: string;
  args: Record<string, unknown>;
  /**
    * Tool output. The native record keeps it on the assistant's tool bubble as
    * `toolFormerData.result` and does **not** emit a separate message -- so the
    * result must hang here, otherwise the UI shows a pile of
   */
  result?: string;
   /** Failed tool call (native status: failed). */
  isError?: boolean;
}

export interface CursorComposerMessage {
  role: 'user' | 'assistant';
  /**
    * Plain narrative text only.
    * Do not wrap thinking as <thinking> in here -- content starting with an HTML
    * tag is treated as an HTML block by Cursor: markdown (bold/lists/fences) and
   */
  text: string;
   /** Tool calls in this message (with results). */
  tools: CursorComposerTool[];
  createdAt: string; // ISO8601
   /** Model name of the assistant message (optional). */
  modelName?: string;
}

export interface RegisterCursorComposerArgs {
  cwd: string;
  composerId: string;
  title: string;
  messages: CursorComposerMessage[];
}

interface BubbleRecord {
  key: string;
  value: string;
}

function buildBubbleRecords(
  composerId: string,
  messages: CursorComposerMessage[],
): { records: BubbleRecord[]; headers: Record<string, unknown>[] } {
  const records: BubbleRecord[] = [];
  const headers: Record<string, unknown>[] = [];
  const uuid = (): string => cryptoRandomUuid();

  for (const msg of messages) {
    const isUser = msg.role === 'user';
    if (msg.text.trim()) {
      const bid = uuid();
      const bubble = emptyBubble();
      bubble.type = isUser ? 1 : 2;
      bubble.bubbleId = bid;
      bubble.createdAt = msg.createdAt;
      bubble.text = msg.text;
      if (isUser) {
        bubble.richText = lexical(msg.text);
        bubble.requestId = uuid();
        bubble.checkpointId = uuid();
         // Native user bubbles carry these three; without them the UI drops the context/model chips
        bubble.context = emptyContext();
        bubble.modelInfo = { modelName: msg.modelName ?? 'default' };
        bubble.isPlanExecution = false;
      } else {
        bubble.modelInfo = { modelName: msg.modelName ?? 'default' };
        bubble.turnDurationMs = 0;
         // Native assistant bubbles carry codeBlocks even when empty; without it the body may render as plain text
         // and markdown stops working
        bubble.codeBlocks = [];
      }
      records.push({ key: `bubbleId:${composerId}:${bid}`, value: JSON.stringify(bubble) });
      headers.push({
        bubbleId: bid,
        type: isUser ? 1 : 2,
        grouping: isUser
          ? {
              isRenderable: true,
              hasText: true,
               // Native decides by text length; hardcoding true makes long prompts render as short text
              isShortPlainText: msg.text.length <= 120,
              textPreview: msg.text.slice(0, 80),
              toolDisplayComputed: true,
            }
          : { isRenderable: true, hasText: true, toolDisplayComputed: true },
        contentHeightHint: 42,
        createdAt: msg.createdAt,
      });
    }

     // Tool calls: natively a body-less type-2 bubble + toolFormerData.
     // tool / toolCallBinary are Cursor-internal protobuf and cannot be rebuilt; omitted (only
     // affects the fine-grained tool icon, not session visibility or the body).
    for (const [i, tool] of msg.tools.entries()) {
      const bid = uuid();
      const callId = `tool_${uuid()}`;
      const argsJson = JSON.stringify(tool.args ?? {});
      const bubble = emptyBubble();
      bubble.type = 2;
      bubble.bubbleId = bid;
      bubble.createdAt = msg.createdAt;
      bubble.codeBlocks = [];
      bubble.turnDurationMs = 0;
      bubble.toolFormerData = {
        toolCallId: callId,
        toolIndex: i,
        modelCallId: callId,
        status: tool.isError ? 'failed' : 'completed',
        name: tool.name,
        rawArgs: argsJson,
        params: argsJson,
         // Tool output hangs here (the native location), not as a separate user bubble.
         // The native result is a "JSON string (object)"; the UI JSON.parses it and reads fields,
         // so bare text must be wrapped or the output will not show.
        result: encodeToolResult(tool.result),
      };
      records.push({ key: `bubbleId:${composerId}:${bid}`, value: JSON.stringify(bubble) });
      headers.push({
        bubbleId: bid,
        type: 2,
        grouping: { isRenderable: false, toolDisplayComputed: true },
        createdAt: msg.createdAt,
      });
    }
  }
  return { records, headers };
}

function buildComposerData(
  composerId: string,
  title: string,
  subtitle: string,
  createdMs: number,
  lastMs: number,
  ws: { id: string; uri: CursorUri },
  headers: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    _v: 18,
    composerId,
    richText: lexical(''),
    hasLoaded: true,
    text: '',
    fullConversationHeadersOnly: headers,
    conversationMap: {},
    status: 'completed',
    context: emptyContext(),
    generatingBubbleIds: [],
    codeBlockData: {},
    originalFileStates: {},
    newlyCreatedFiles: [],
    newlyCreatedFolders: [],
    lastUpdatedAt: lastMs,
    createdAt: createdMs,
    hasChangedContext: false,
     // Natively a fixed three-item capability list; leaving it empty breaks some tool/capability panels
    capabilities: [
      { type: 15, data: { bubbleDataMap: '{}' } },
      { type: 19, data: {} },
      { type: 33, data: {} },
    ],
    name: title,
    subtitle,
    isFileListExpanded: false,
    canvasPillCollapsed: false,
    browserChipManuallyDisabled: false,
    browserChipManuallyEnabled: false,
    unifiedMode: 'agent',
    activeCustomMode: null,
    committedCustomMode: null,
    pendingExitedCustomMode: null,
    forceMode: 'edit',
    usageData: {},
    allAttachedFileCodeChunksUris: [],
    modelConfig: {
      modelName: 'default',
      maxMode: false,
      selectedModels: [{ modelId: 'default', parameters: [] }],
    },
    subComposerIds: [],
    subagentComposerIds: [],
    capabilityContexts: [],
    todos: [],
    isQueueExpanded: true,
    hasUnreadMessages: false,
    gitHubPromptDismissed: false,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    addedFiles: 0,
    removedFiles: 0,
    isDraft: false,
    isCreatingWorktree: false,
    isApplyingWorktree: false,
    isUndoingWorktree: false,
    applied: false,
    pendingCreateWorktree: false,
    worktreeStartedReadOnly: false,
    isBestOfNSubcomposer: false,
    isBestOfNParent: false,
    isSpec: false,
    isProject: false,
    isSpecSubagentDone: false,
    isContinuationInProgress: false,
    stopHookLoopCount: 0,
    trackedGitRepos: [],
    isNAL: true,
    planModeSuggestionUsed: false,
    debugModeSuggestionUsed: false,
    conversationState: '~',
    queueItems: [],
    isAgentic: true,
    filesChangedCount: 0,
    workspaceIdentifier: { id: ws.id, uri: ws.uri },
    blobEncryptionKey: randomBase64Key(),
    speculativeSummarizationEncryptionKey: randomBase64Key(),
    latestChatGenerationUUID: cryptoRandomUuid(),
  };
}

function buildHead(
  composerId: string,
  title: string,
  subtitle: string,
  createdMs: number,
  lastMs: number,
  ws: { id: string; uri: CursorUri },
): Record<string, unknown> {
  return {
    type: 'head',
    composerId,
    createdAt: createdMs,
    lastUpdatedAt: lastMs,
    conversationCheckpointLastUpdatedAt: lastMs,
    name: title,
    subtitle,
    unifiedMode: 'agent',
    forceMode: 'edit',
    hasUnreadMessages: false,
    hasBlockingPendingActions: false,
    hasPendingPlan: false,
    isArchived: false,
    isDraft: false,
    isWorktree: false,
    worktreeStartedReadOnly: false,
    isSpec: false,
    isProject: false,
    isBestOfNSubcomposer: false,
    numSubComposers: 0,
    referencedPlans: [],
    trackedGitRepos: [],
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    filesChangedCount: 0,
    workspaceIdentifier: { id: ws.id, uri: ws.uri },
  };
}

function randomBase64Key(): string {
   // 32-byte random key (native stores base64).
  return crypto.randomBytes(32).toString('base64');
}

function cryptoRandomUuid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

export interface RegisterResult {
  ok: boolean;
   /** Failure reason (ok=false; for the CLI debug log). */
  reason?: string;
  bubbleCount?: number;
}

/**
 * Register the session into Cursor's Agents list.
 *
 * Failures always return {ok:false, reason}; the caller must not treat it as a
 * migration failure -- the transcript is on disk, a failed registration only
 */
export function registerCursorComposer(args: RegisterCursorComposerArgs): RegisterResult {
  const dbPath = getCursorStateDbPath();
  if (!dbPath) return { ok: false, reason: 'unsupported platform' };
  if (!fs.existsSync(dbPath)) return { ok: false, reason: `state db not found: ${dbPath}` };

  const sqlite3 = findSqlite3();
  if (!sqlite3) return { ok: false, reason: 'sqlite3 CLI not found' };

  const ws = resolveCursorWorkspaceId(args.cwd);
  if (!ws) return { ok: false, reason: `cursor workspace not found for ${args.cwd}` };

  const { records, headers } = buildBubbleRecords(args.composerId, args.messages);
  if (records.length === 0) return { ok: false, reason: 'no renderable messages' };

  const times = args.messages
    .map((m) => Date.parse(m.createdAt))
    .filter((n) => Number.isFinite(n));
  const createdMs = times.length ? Math.min(...times) : Date.now();
  const lastMs = times.length ? Math.max(...times) : createdMs;
   // List sort fields (lastUpdatedAt/recency) use the migration time: keeping the
   // source time would bury the migrated session in an "N days ago" group and the
   // user would not find it at the top. The in-session timeline (lastMs inside
  const recencyMs = Math.max(lastMs, Date.now());
  const subtitle = args.messages.find((m) => m.role === 'user' && m.text.trim())?.text.slice(0, 30) ?? '';

  const composer = buildComposerData(args.composerId, args.title, subtitle, createdMs, lastMs, ws, headers);
  const head = buildHead(args.composerId, args.title, subtitle, createdMs, lastMs, ws);

  const stmts: string[] = [
     // Cursor holds a write lock at runtime: bound the wait so the CLI cannot hang
    'PRAGMA busy_timeout=5000;',
    'BEGIN IMMEDIATE;',
     // OR REPLACE relies on a unique index; delete first so a re-migration
    `DELETE FROM composerHeaders WHERE composerId='${esc(args.composerId)}';`,
  ];
  stmts.push(
    'INSERT OR REPLACE INTO composerHeaders ' +
      '(composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName) ' +
      `VALUES ('${esc(args.composerId)}','${esc(ws.id)}',${createdMs},${recencyMs},0,0,${recencyMs},NULL,'${esc(JSON.stringify(head))}',NULL);`,
  );
   // Re-migrating the same session: clear the old bubbles to avoid leftovers
  stmts.push(`DELETE FROM cursorDiskKV WHERE key LIKE 'bubbleId:${esc(args.composerId)}:%';`);
  stmts.push(
    'INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES ' +
      `('composerData:${esc(args.composerId)}','${esc(JSON.stringify(composer))}');`,
  );
  for (const rec of records) {
    stmts.push(
      'INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES ' +
        `('${esc(rec.key)}','${esc(rec.value)}');`,
    );
  }
  stmts.push('COMMIT;');

  const sqlPath = path.join(os.tmpdir(), `teamai-cursor-${process.pid}-${Date.now()}.sql`);
  try {
    fs.writeFileSync(sqlPath, stmts.join('\n'), 'utf-8');
    const r = spawnSync(sqlite3, [dbPath], {
      input: fs.readFileSync(sqlPath),
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    });
    if (r.status !== 0) {
      return { ok: false, reason: (r.stderr?.toString() ?? '').trim().slice(0, 300) || `sqlite3 exit ${r.status}` };
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    try {
      fs.unlinkSync(sqlPath);
    } catch {
      // ignore
    }
  }

  return { ok: true, bubbleCount: records.length };
}

/**
 * Remove the session from Cursor's Agents list (called on rollback / delete).
 * Only rows for our own composerId are touched; best-effort.
 */
export function unregisterCursorComposer(composerId: string): RegisterResult {
  const dbPath = getCursorStateDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return { ok: false, reason: 'state db not found' };
  const sqlite3 = findSqlite3();
  if (!sqlite3) return { ok: false, reason: 'sqlite3 CLI not found' };

  const sql =
    'BEGIN IMMEDIATE;\n' +
    `DELETE FROM composerHeaders WHERE composerId='${esc(composerId)}';\n` +
    `DELETE FROM cursorDiskKV WHERE key='composerData:${esc(composerId)}' OR key LIKE 'bubbleId:${esc(composerId)}:%';\n` +
    'COMMIT;';

  const sqlPath = path.join(os.tmpdir(), `teamai-cursor-del-${process.pid}-${Date.now()}.sql`);
  try {
    fs.writeFileSync(sqlPath, sql, 'utf-8');
    const r = spawnSync(sqlite3, [dbPath], {
      input: fs.readFileSync(sqlPath),
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    });
    if (r.status !== 0) {
      return { ok: false, reason: (r.stderr?.toString() ?? '').trim().slice(0, 300) || `sqlite3 exit ${r.status}` };
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    try {
      fs.unlinkSync(sqlPath);
    } catch {
      // ignore
    }
  }
  return { ok: true };
}
