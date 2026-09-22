/**
 * cursor-store.ts — 把迁移出来的会话注册进 Cursor 的本地数据库。
 *
 * 背景：Cursor 的 Agents Window **不是**扫 `~/.cursor/projects/<proj>/agent-transcripts/`
 * 列会话的 —— transcript jsonl 是 Cursor 从自己的库单向 `flushTranscriptForConversation`
 * 导出的产物。UI 的列表来自 `state.vscdb` 的 `composerHeaders` 表，正文来自
 * `cursorDiskKV` 的 `composerData:<composerId>` 与 `bubbleId:<composerId>:<bubbleId>`。
 * 因此只写 transcript 文件，会话在 Cursor 里完全不可见（迁移「成功」但看不到）。
 *
 * 这里做三件事（best-effort，任何一步失败都不影响 transcript 已写入）：
 *   1. 从 `User/workspaceStorage/<hash>/workspace.json` 反查 cwd 对应的 workspaceId
 *   2. 按原生结构构造 head / composerData / bubbles
 *   3. 用 sqlite3 以单事务 INSERT OR REPLACE 落库
 *
 * 只新增/覆盖自己这个 composerId 的行，不动其他会话；回滚 = 删掉这三类 key。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// 路径与工具
// ---------------------------------------------------------------------------

/** Cursor 用户数据目录（macOS / Linux；其他平台返回 null 表示不支持注册）。 */
export function getCursorStateRoot(): string | null {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Cursor');
  }
  return null; // Windows: %APPDATA%/Cursor —— 暂不支持（sqlite3 CLI 不保证存在）
}

/** Cursor 的 state.vscdb 路径。 */
export function getCursorStateDbPath(): string | null {
  const root = getCursorStateRoot();
  return root ? path.join(root, 'User', 'globalStorage', 'state.vscdb') : null;
}

/** 找 sqlite3 CLI：PATH → 常见安装位置。 */
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

/** cwd → Cursor workspaceId（由 workspaceStorage/<hash>/workspace.json 的 folder 反查）。 */
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
// 模板（字段集取自 Cursor 0.155 附近版本的原生记录）
// ---------------------------------------------------------------------------

/** Lexical 富文本：Cursor 的 composer/bubble 用它渲染编辑器内容。 */
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

/** 工具输出：原生 result 是 JSON 字符串（对象），裸文本要包成对象，否则 UI 解析不出来。 */
function encodeToolResult(raw?: string): string {
  if (!raw) return '';
  const s = raw.trim();
  if (s.startsWith('{') || s.startsWith('[')) return s;
  return JSON.stringify({ output: raw });
}

/** 原生 composerData.context / bubble.context 的空形态。 */
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

/** bubble 默认值（原生 bubble 的字段全量铺开，避免 UI 解析时缺字段）。 */
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
// 构造 head / composerData / bubbles
// ---------------------------------------------------------------------------

export interface CursorComposerTool {
  name: string;
  args: Record<string, unknown>;
  /**
   * 工具输出。原生把它放在 assistant 的 tool 气泡 `toolFormerData.result` 里，
   * **不会**单独成为一条消息 —— 所以工具结果必须挂在这里，否则 UI 里会冒出一堆
   * `[tool_result] {json}` 的用户气泡。
   */
  result?: string;
  /** 失败的工具调用（原生 status: failed）。 */
  isError?: boolean;
}

export interface CursorComposerMessage {
  role: 'user' | 'assistant';
  /**
   * 纯文本正文：只放真实叙述文本。
   * 不要把 thinking 包成 `<thinking>` 塞进来 —— 以 HTML 标签开头的正文会被 Cursor 当
   * HTML 块处理，markdown（粗体/列表/代码块）与换行全部失效，整段显示成一行。
   */
  text: string;
  /** 该消息里的工具调用（含结果）。 */
  tools: CursorComposerTool[];
  createdAt: string; // ISO8601
  /** assistant 消息的模型名（可选）。 */
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
        // 原生 user bubble 还带这三项，缺失会让 UI 少渲染上下文/模型标签
        bubble.context = emptyContext();
        bubble.modelInfo = { modelName: msg.modelName ?? 'default' };
        bubble.isPlanExecution = false;
      } else {
        bubble.modelInfo = { modelName: msg.modelName ?? 'default' };
        bubble.turnDurationMs = 0;
        // 原生 assistant 气泡带 codeBlocks（哪怕为空）；缺失时正文可能按纯文本渲染，
        // markdown 不生效
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
              // 原生按文本长度决定，写死 true 会让长提问被当短文本渲染
              isShortPlainText: msg.text.length <= 120,
              textPreview: msg.text.slice(0, 80),
              toolDisplayComputed: true,
            }
          : { isRenderable: true, hasText: true, toolDisplayComputed: true },
        contentHeightHint: 42,
        createdAt: msg.createdAt,
      });
    }

    // 工具调用：原生是「无正文的 type 2 气泡 + toolFormerData」。
    // tool / toolCallBinary 是 Cursor 内部 protobuf，无法还原，省略（仅影响工具图标的
    // 精细展示，不影响会话可见性与正文）。
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
        // 工具输出挂在这里（原生位置），不是一个独立的用户气泡。
        // 原生 result 是「JSON 字符串（对象）」，UI 会 JSON.parse 后取字段，
        // 所以裸文本要包成对象，否则工具输出显示不出来。
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
    // 原生是固定三项能力描述；留空会让部分工具/能力面板 UI 缺内容
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
  // 32 字节随机 key（原生是 base64）。
  return crypto.randomBytes(32).toString('base64');
}

function cryptoRandomUuid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

export interface RegisterResult {
  ok: boolean;
  /** 失败原因（ok=false 时给 CLI 记录 debug 用）。 */
  reason?: string;
  bubbleCount?: number;
}

/**
 * 将会话注册进 Cursor 的 Agents 列表。
 *
 * 失败一律返回 `{ok:false, reason}`，调用方不应把它当迁移失败 —— transcript 已落盘，
 * 注册失败只是「列表里看不到」，不会损坏任何数据。
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
  // 列表排序字段（lastUpdatedAt/recency）用迁移时刻：保留源时间会把迁移会话
  // 埋进「N 天前」分组，用户迁完在顶部找不到。会话内容时间轴（composerData
  // 内的 lastMs）保持源时间不变。
  const recencyMs = Math.max(lastMs, Date.now());
  const subtitle = args.messages.find((m) => m.role === 'user' && m.text.trim())?.text.slice(0, 30) ?? '';

  const composer = buildComposerData(args.composerId, args.title, subtitle, createdMs, lastMs, ws, headers);
  const head = buildHead(args.composerId, args.title, subtitle, createdMs, lastMs, ws);

  const stmts: string[] = [
    // Cursor 运行时会持有写锁：给一个有限的 busy 超时，避免 CLI 永久挂起
    'PRAGMA busy_timeout=5000;',
    'BEGIN IMMEDIATE;',
    // OR REPLACE 依赖唯一索引，先显式删一次，避免重迁移出现重复行
    `DELETE FROM composerHeaders WHERE composerId='${esc(args.composerId)}';`,
  ];
  stmts.push(
    'INSERT OR REPLACE INTO composerHeaders ' +
      '(composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName) ' +
      `VALUES ('${esc(args.composerId)}','${esc(ws.id)}',${createdMs},${recencyMs},0,0,${recencyMs},NULL,'${esc(JSON.stringify(head))}',NULL);`,
  );
  // 重迁移同一会话时先清掉旧的 bubble，避免残留
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
 * 从 Cursor 的 Agents 列表里移除该会话（迁移回滚 / 删除会话时调用）。
 * 只删自己这个 composerId 的行，best-effort。
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
