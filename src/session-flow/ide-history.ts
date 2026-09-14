/**
 * ide-history.ts — CodeBuddy IDE 侧边栏「历史对话」同步。
 *
 * CodeBuddy IDE（图形化）与 CodeBuddy CLI 的会话存储是**互相独立**的两套：
 *   - CLI: ~/.codebuddy/projects/<encoded-cwd>/<uuid>.jsonl
 *   - IDE: <userData>/CodeBuddyExtension/Data/<ext-id>/CodeBuddyIDE/<ext-id>/history/<md5(cwd)>/
 *
 * 只写 CLI 路径的话，用户在 IDE 侧边栏「历史对话」里看不到迁移过来的会话。
 * 本模块把迁移结果**同步**进 IDE 的 history 目录，使侧边栏可见且可点开继续聊。
 *
 * IDE 路径要点：
 * - workspace 哈希 = md5(cwd) 的 32 位小写 hex（cwd 用 path.resolve 规范化、去尾部斜杠）
 * - conversation id / messages 目录名 = 32 位 hex（无横线），故 UUID 需去横线
 * - index.json: { conversations: [{id,type,name,createdAt,lastMessageAt,modelMap?}], current }
 * - messages/<msg-id>.json: { role, message(stringified JSON), id, extra(stringified JSON), createdAt }
 *
 * IDE content block 类型：text / reasoning / tool-call / tool-result
 * - tool-result 在 IDE 中是**独立 role:"tool" 消息**，不合并进 user/assistant
 *
 * 设计原则：本模块是**增强功能**，任何失败都静默降级，绝不阻断主迁移流程。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from './ir.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** IDE 侧单条消息文件的结构（message / extra 为 stringified JSON）。 */
interface IdeMessageFile {
  role: 'user' | 'assistant' | 'tool';
  message: string;
  id: string;
  extra: string;
  createdAt: string;
}

/** IDE index.json 中的 conversation 条目。 */
interface IdeConversation {
  id: string;
  type: 'craft' | 'plan' | 'team-member';
  name: string;
  createdAt: string;
  lastMessageAt: string;
  modelMap?: Record<string, string>;
}

export interface IdeSyncResult {
  /** 成功同步的 IDE 实例数 */
  synced: number;
  /** 写入的消息条数（按 IDE 计，tool-result 会拆成独立消息） */
  messageCount: number;
  /** 未同步时的原因（synced===0 时有值） */
  skipped?: string;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function uuidV4(): string {
  return crypto.randomUUID();
}

function hex32(): string {
  return uuidV4().replace(/-/g, '');
}

/**
 * IDE 的 workspace 哈希：md5(cwd) 的 32 位小写 hex。
 * cwd 先 resolve 再去掉尾部斜杠，保证与 IDE 内部算法一致。
 *
 * 必须是**真实绝对路径**。session.cwd 可能是源平台存的 encoded 形式
 * （如 `-Users-foo-project`），此时无法可靠反推真实路径（空格会丢失），
 * 返回 null 让调用方跳过——宁可不同步，也不能用错误 hash 写进无关目录。
 */
export function hashWorkspace(cwd: string): string | null {
  if (!cwd || !cwd.startsWith('/')) return null;
  const normalized = path.resolve(cwd).replace(/\/+$/, '');
  return crypto.createHash('md5').update(normalized).digest('hex');
}

/**
 * conversation id：IDE 用 32 位 hex（无横线）。
 * UUID v4 去横线即可；非 UUID 则回退为 md5(sessionId)。
 */
function toIdeConvId(sessionId: string): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(sessionId)) return sessionId.replace(/-/g, '').toLowerCase();
  return crypto.createHash('md5').update(sessionId).digest('hex');
}

/**
 * CodeBuddyExtension 的用户数据根目录（跨平台）。
 */
function getUserDataBase(): string | null {
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
 * 找出所有 IDE 实例下该 cwd 对应的 history 目录。
 *
 * 通常只有 1 个（单用户单实例）。多实例时全部返回，逐个写入。
 * createIfMissing=true 时，若该项目的 history 目录尚不存在（IDE 没打开过这个项目），
 * 仍返回待创建路径，使其下次打开即可见。
 */
export function findIdeHistoryDirs(cwd: string, createIfMissing = false): string[] {
  const base = getUserDataBase();
  if (!base || !fs.existsSync(base)) return [];

  const hash = hashWorkspace(cwd);
  if (!hash) return []; // cwd 不是真实绝对路径，放弃同步

  const out: string[] = [];
  try {
    for (const extId of fs.readdirSync(base)) {
      const ideRoot = path.join(base, extId, 'CodeBuddyIDE');
      if (!fs.existsSync(ideRoot)) continue;
      for (const instId of fs.readdirSync(ideRoot)) {
        const historyRoot = path.join(ideRoot, instId, 'history');
        if (!fs.existsSync(historyRoot)) continue;
        const target = path.join(historyRoot, hash);
        if (fs.existsSync(target) || createIfMissing) out.push(target);
      }
    }
  } catch {
    return [];
  }

  return out;
}

// ---------------------------------------------------------------------------
// IR → IDE 转换
// ---------------------------------------------------------------------------

/**
 * 挑一个模型名用于 modelMap / extra。
 * 优先 session.metadata.model，其次首条带 model 的消息。
 */
function pickModel(session: Session): string | undefined {
  if (session.metadata?.model) return String(session.metadata.model);
  for (const m of session.messages) {
    if (m.metadata?.model) return String(m.metadata.model);
  }
  return undefined;
}

/**
 * IR Session → IDE 消息列表。
 *
 * 一条 IR message 可能展开为多条 IDE 消息：
 * - thinking/text/tool_call 合成一条（role 保持 user/assistant）
 * - tool_result 拆成独立的 role:"tool" 消息
 */
/**
 * 确定性 32 位 hex id（内容派生）。
 *
 * 消息文件名就是消息 id，因此 id 必须对**相同输入稳定**——用 randomUUID
 * 会导致每次迁移都生成新文件名，旧文件既不被覆盖也不被清理，
 * messages/ 目录每次迁移泄漏一批孤儿。
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
 * 解析每条消息的 createdAt。
 *
 * 源平台常常不记录 per-message 时间戳，若一律回落到 session.updatedAt，
 * 会让整个会话的消息共用一个时间（实测 484 条里 468 条完全相同），
 * IDE 的时间线分组 / 相对时间会明显异常。
 * 这里在已知时间戳之间线性插值，并强制严格递增。
 */
function resolveTimestamps(session: Session): string[] {
  const n = session.messages.length;
  const base = toEpochMs(session.createdAt) ?? Date.now();
  const tailRaw = toEpochMs(session.updatedAt);
  const tail = tailRaw !== undefined && tailRaw >= base ? tailRaw : base;

  if (n === 0) return [];

  // 虚拟边界：index -1 = createdAt，index n = updatedAt
  const known: Array<{ i: number; t: number }> = [
    { i: -1, t: base },
    { i: n, t: tail },
  ];
  session.messages.forEach((m, i) => {
    const t = toEpochMs(m.timestamp);
    if (t !== undefined) known.push({ i, t });
  });
  known.sort((a, b) => a.i - b.i);

  const ts = new Array<number>(n);
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

  // 强制严格递增（至少 +1ms）：插值在塌缩区间内仍会产生大量相同值
  for (let i = 1; i < n; i++) {
    if (!(ts[i] > ts[i - 1])) ts[i] = ts[i - 1] + 1;
  }

  return ts.map((t) => new Date(Number.isFinite(t) ? t : base).toISOString());
}

function irToIdeMessages(session: Session): IdeMessageFile[] {
  const out: IdeMessageFile[] = [];
  const model = pickModel(session);
  const timestamps = resolveTimestamps(session);

  // callId → toolName 映射（tool-result 需要回填 toolName）
  const toolNameByCallId = new Map<string, string>();
  for (const msg of session.messages) {
    for (const b of msg.content) {
      if (b.type === 'tool_call' && b.callId) toolNameByCallId.set(b.callId, b.toolName);
    }
  }

  session.messages.forEach((msg, msgIdx) => {
    const ts = timestamps[msgIdx];
    const msgModel = msg.metadata?.model ?? model;
    const extra = JSON.stringify({
      requestId: stableId([session.sessionId, String(msgIdx), 'request']),
      modelId: msgModel ? `custom-local:${msgModel}` : 'custom-local:unknown',
      modelName: msgModel ?? 'unknown',
      isHelperMessage: false,
    });

    // 1) thinking + text + tool_call → 一条
    const content: Record<string, unknown>[] = [];
    for (const b of msg.content) {
      if (b.type === 'thinking') {
        content.push({ type: 'reasoning', text: b.text });
      } else if (b.type === 'text') {
        content.push({ type: 'text', text: b.text });
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
        id: msg.messageId ?? stableId([session.sessionId, String(msgIdx), 'message']),
        extra,
        createdAt: ts,
      });
    }

    // 2) tool_result → 独立 role:"tool" 消息
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
              // 元素级 isError：IDE 靠它把失败的 tool 渲染成错误态。
              // 缺失会被当成成功（falsy），失败的调用看起来像正常返回。
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

  return out;
}

// ---------------------------------------------------------------------------
// index.json 读写
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
    // index.json 损坏时，尝试用备份恢复
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
  // 写前备份，与 IDE 自身的 .index_bak.json 约定保持一致
  if (fs.existsSync(idxPath)) {
    try {
      fs.copyFileSync(idxPath, path.join(historyDir, '.index_bak.json'));
    } catch {
      // 备份失败不阻断写入
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
  writeIndex(historyDir, data);
}

function removeConversation(historyDir: string, convId: string): void {
  const data = readIndex(historyDir);
  const convs = (data.conversations as IdeConversation[]).filter((c) => c.id !== convId);
  if (convs.length === (data.conversations as IdeConversation[]).length) return; // 无变化
  data.conversations = convs;
  if (data.current === convId) data.current = convs[convs.length - 1]?.id;
  writeIndex(historyDir, data);
}

function removeDirRecursive(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 把会话同步进 CodeBuddy IDE 的 history（侧边栏「历史对话」可见）。
 * 失败静默降级，不抛异常。
 */
/**
 * 源平台注入的系统前缀。首条「用户消息」常常是这类包装文本，
 * 直接当标题会把提示词原文泄漏到 IDE 侧边栏历史列表里。
 */
const SYSTEM_INJECTED_TITLE = /^\s*<(local-command-caveat|system-reminder|system|command-name|command-message|command-args|timestamp)\b/i;

/**
 * 会话标题：清洗系统注入文本，拿不到有效标题时退回首条真实用户文本。
 */
function cleanTitle(session: Session, convId: string): string {
  const raw = (session.title ?? '').replace(/\s+/g, ' ').trim();
  if (raw && !SYSTEM_INJECTED_TITLE.test(raw)) return raw.slice(0, 100);

  for (const m of session.messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type !== 'text') continue;
      const t = b.text.replace(/\s+/g, ' ').trim();
      if (t && !SYSTEM_INJECTED_TITLE.test(t)) return t.slice(0, 100);
    }
  }
  return `Session ${convId.slice(0, 8)}`;
}

interface IdeRequest {
  id: string;
  type: 'craft';
  /** 该 turn 包含的消息 id（含 user 及其后的 assistant/tool） */
  messages: string[];
  state: string;
  /** epoch 毫秒，与 IDE 原生一致（number，不是 ISO 串） */
  startedAt: number;
  usage?: Record<string, unknown>;
}

/**
 * 按 user turn 切分出 IDE 的 requests 数组。
 *
 * 为什么必须写：消费方 `dashboard-collector` 用
 * `if (!Array.isArray(data.requests)) return null` 做守卫，缺了这个数组会让
 * prompts（user turn 数）等统计**整体**静默归零，而不只是 token 归零。
 *
 * 为什么不给 usage：IR 不携带 token 用量，凭空写 0 会把「未知」伪装成「实测为 0」。
 * 消费方对缺失 usage 直接跳过累加，因此不写是安全且诚实的——token 仍为 0，
 * 但 prompts 等其余统计能恢复正常。
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
      // 首条不是 user（少见）：兜底开一个 turn，避免消息无归属
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
      skipped: 'CodeBuddy IDE 存储未找到（未安装或未初始化），仅写入 CLI 路径',
    };
  }

  const convId = toIdeConvId(session.sessionId);
  const messages = irToIdeMessages(session);
  const model = pickModel(session);
  const requests = buildIdeRequests(session, messages);

  const conv: IdeConversation = {
    id: convId,
    type: 'craft',
    name: cleanTitle(session, convId),
    createdAt: session.createdAt,
    lastMessageAt: session.updatedAt,
    ...(model ? { modelMap: { ask: model, craft: model, plan: model } } : {}),
  };

  let synced = 0;
  for (const historyDir of dirs) {
    try {
      const convDir = path.join(historyDir, convId);
      const msgDir = path.join(convDir, 'messages');

      // 幂等：重跑迁移必须先清空 messages/。
      // 消息文件名 = 消息 id，旧版本残留的文件既不会被覆盖也不会被索引，
      // 会变成孤儿并让目录随迁移次数无上限增长。
      if (fs.existsSync(msgDir)) {
        for (const f of fs.readdirSync(msgDir)) {
          if (f.endsWith('.json')) fs.unlinkSync(path.join(msgDir, f));
        }
      }
      fs.mkdirSync(msgDir, { recursive: true });

      // 写每条消息，同时收集顺序索引。
      // conversation 级 index.json 是**消息顺序索引**——IDE 靠它决定显示顺序，
      // 只写 messages/*.json 而没有它的话，会话打开会是空白。
      const messageIndex: Array<Record<string, unknown>> = [];
      for (const m of messages) {
        fs.writeFileSync(path.join(msgDir, `${m.id}.json`), JSON.stringify(m, null, 2), 'utf-8');
        messageIndex.push({ id: m.id, type: 'text', role: m.role, isComplete: true });
      }

      // 写前备份，与 IDE 自身的 .index_bak.json 约定保持一致
      // （原生会话目录都带它，用于在 index 损坏时自愈）
      const convIdxPath = path.join(convDir, 'index.json');
      if (fs.existsSync(convIdxPath)) {
        try {
          fs.copyFileSync(convIdxPath, path.join(convDir, '.index_bak.json'));
        } catch {
          // 备份失败不阻断写入
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
      // 单个 IDE 实例同步失败不影响其他实例，也不影响 CLI 路径的主流程
    }
  }

  return {
    synced,
    messageCount: messages.length,
    ...(synced === 0 ? { skipped: 'IDE history 目录写入失败' } : {}),
  };
}

/**
 * 遍历所有 IDE 实例的 history，按 convId 定位会话目录。
 *
 * rollback 时拿到的 cwd 往往是 encoded 的目录名（decodeCwdGeneric 是恒等函数，
 * 无法还原真实路径），算不出 workspace hash。而 convId 是全局唯一的，
 * 故直接全局搜索，不依赖 cwd。
 */
function findIdeConversationDirs(convId: string): Array<{ historyDir: string; convDir: string }> {
  const base = getUserDataBase();
  if (!base || !fs.existsSync(base)) return [];

  const out: Array<{ historyDir: string; convDir: string }> = [];
  try {
    for (const extId of fs.readdirSync(base)) {
      const ideRoot = path.join(base, extId, 'CodeBuddyIDE');
      if (!fs.existsSync(ideRoot)) continue;
      for (const instId of fs.readdirSync(ideRoot)) {
        const historyRoot = path.join(ideRoot, instId, 'history');
        if (!fs.existsSync(historyRoot)) continue;
        for (const wsHash of fs.readdirSync(historyRoot)) {
          const historyDir = path.join(historyRoot, wsHash);
          const convDir = path.join(historyDir, convId);
          if (fs.existsSync(convDir)) out.push({ historyDir, convDir });
        }
      }
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * 从 CodeBuddy IDE 的 history 中删除会话（rollback 时清理）。
 * 返回清理的 IDE 实例数。
 *
 * cwd 可选：给了就额外兜底清理该项目的 index 孤儿条目，但即使不给也能按 convId 清理。
 */
export function deleteIdeSession(sessionId: string, cwd?: string): number {
  const convId = toIdeConvId(sessionId);

  // 有 cwd 且能解析出 workspace 时，只清理该工作区：
  // findIdeConversationDirs 遍历的是所有 workspace hash，而同一个 sessionId 完全可能
  // 同时存在于多个工作区（把同一会话迁移到 A、B 两个项目）。此时按 convId 全局删
  // 会连带删掉另一个工作区的副本——那是不可恢复的数据丢失。
  //
  // 但 cwd 本身常常不可靠：deleteSession 里的 cwd 是从 CLI 侧 jsonl 目录名反解出来的，
  // 而目录名编码有损（路径分隔符与连字符无法区分），解出来的往往不是真实绝对路径，
  // findIdeHistoryDirs 会因此返回空数组。所以限定失败时必须回退到全局搜索——
  // 宁可多删，也绝不能让清理退化成 no-op 留下永久残留。
  // 需要精确定界时用 rollback --cwd <真实路径>。
  const scoped = cwd ? findIdeHistoryDirs(cwd, false) : [];
  const targets: Array<{ historyDir: string; convDir: string }> = scoped.length > 0
    ? scoped.map((historyDir) => ({ historyDir, convDir: path.join(historyDir, convId) }))
    : findIdeConversationDirs(convId);

  let cleaned = 0;
  for (const { historyDir, convDir } of targets) {
    // 目录删除与 index 条目清理必须分成两个 try。
    // 合在一个 try 里时，rm 一旦抛异常（大会话容易和运行中的 IDE 进程回写竞争），
    // 后面的 removeConversation 就被跳过，index 条目永远清不掉——
    // 结果是目录还在、侧边栏也还显示，用户以为回滚失败且无法补救。
    try {
      removeDirRecursive(convDir);
    } catch {
      // ignore：目录删不掉至少要让它从侧边栏消失
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
