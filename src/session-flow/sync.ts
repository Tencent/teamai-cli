/**
 * sync.ts — 会话团队同步引擎。
 *
 * 管理团队仓中完整会话 IR 的存储布局、索引、Git 操作。
 *
 * 目录结构（团队仓或 reports branch）：
 *
 *   sessions/
 *   ├── repos/                                ← 按仓库标识隔离（与 AI agent 行为一致）
 *   │   ├── github.com_org_payment-service/   ← canonical remote（/ → _）
 *   │   │   ├── _index.json                   ← 该仓库所有会话的索引
 *   │   │   ├── alice/                        ← 按成员分子目录
 *   │   │   │   ├── claude-code_fix-port_20260910.jsonl
 *   │   │   │   └── claude-code_fix-port_20260910.meta.json
 *   │   │   └── bob/
 *   │   │       └── ...
 *   │   └── github.com_org_infra-tools/
 *   │       └── ...
 *   └── _unattributed/                        ← 非 git 仓库下的会话（降级）
 *       └── alice/
 *           └── ...
 *
 * 设计约束：
 * - repoIdentity 从 cwd 的 git remote 采集，canonical 化后不可变
 * - 隔离在下行（pull）时按 repoIdentity 过滤，与 AI agent 按 cwd 隔离一致
 * - _index.json 是 per-repo 的，rebuild_index 可从磁盘幂等重建
 * - 与 TeamAI projects.yaml 零耦合（可选增强，不阻塞核心功能）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Session } from './ir.js';
import { messageToDict, messageFromDict } from './ir.js';

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function utcNow(): string {
  return new Date().toISOString();
}

/**
 * 获取当前 git user.name 或 user.email 作为 author 标识。
 * 优先 user.name（更人类友好），fallback 到 user.email，再 fallback 'unknown'。
 */
export function getGitAuthor(cwd?: string): string {
  for (const key of ['user.name', 'user.email']) {
    try {
      const result = execFileSync('git', ['config', key], {
        cwd: cwd ?? process.cwd(),
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const val = result.trim();
      if (val) return val;
    } catch {
      // continue
    }
  }
  return 'unknown';
}

/**
 * 从 cwd 获取 git remote canonical 标识。
 *
 * 归一化规则：
 *   https://github.com/org/repo.git     → github.com/org/repo
 *   git@github.com:org/repo.git         → github.com/org/repo
 *   https://gitlab.company.com/g/repo   → gitlab.company.com/g/repo
 *
 * 非 git 仓库或无 remote 时返回 null。
 */
export function getRepoIdentity(cwd?: string): string | null {
  try {
    const raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!raw) return null;
    return canonicalizeRemote(raw);
  } catch {
    return null;
  }
}

/**
 * 归一化 git remote URL → `host/owner/repo`（去协议、去 .git 后缀）。
 */
export function canonicalizeRemote(remote: string): string {
  let s = remote.trim().replace(/\.git$/i, '');
  // https://github.com/org/repo → github.com/org/repo
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // git@github.com:org/repo → github.com/org/repo
  s = s.replace(/^git@([^:]+):/i, '$1/');
  // 去前导 /
  s = s.replace(/^\/+/, '');
  return s;
}

/**
 * Encode a canonical remote into a directory-safe string, reversibly.
 *
 * `_` is escaped to `__` first, then every other non-whitelisted char
 * (including `/`) becomes `_`. Without the escape step, `github.com/org/a_b`
 * and `github.com/org/a/b` would encode to the same directory and mix two
 * repositories' sessions together.
 *
 * Reversible via decodeRepoIdentity.
 */
export function encodeRepoIdentity(identity: string): string {
  const escaped = identity.replace(/_/g, '__');
  return escaped.replace(/[^a-zA-Z0-9.-]/g, '_');
}

/** Undo encodeRepoIdentity (used for display; the canonical id stays in meta). */
export function decodeRepoIdentity(encoded: string): string {
  return encoded.replace(/_(?!_)/g, '/').replace(/__/g, '_');
}

/**
 * Sanitize a path segment (git author names are free-form text and may
 * contain ':', '/', '..', trailing dots, or Windows-invalid characters).
 * Collisions are acceptable here -- the canonical identity lives in
 * meta/_index.json, not in the directory name.
 */
function sanitizePathSegment(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/\//g, '_')
    .replace(/^\.+$|^\.\.$/g, '_')
    .replace(/[. ]+$/g, '_')
    .trim();
  return cleaned || 'unknown';
}

/**
 * 将标题转为文件名安全的 slug。
 */
function slugify(title: string, maxLength = 50): string {
  const slug = title.toLowerCase().replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength) || 'untitled';
}

/**
 * 生成 session_name: `{platform}_{title_slug}_{YYYYMMDD}`。
 */
export function generateSessionName(platform: string, title: string, createdAt: string): string {
  const date = createdAt.slice(0, 10).replace(/-/g, '');
  return `${platform}_${slugify(title)}_${date}`;
}

// ---------------------------------------------------------------------------
// SessionSyncMeta — meta.json 数据模型
// ---------------------------------------------------------------------------

export interface SessionSyncMeta {
  origin: {
    platform: string;
    author: string;
    cwd: string;
    repoIdentity: string | null;
    createdAt: string;
    sessionId: string;
    /** Persisted verbatim: the file name is a lossy slug, never a title source. */
    title?: string;
  };
  migration: {
    migratedAt: string | null;
    sourcePlatform: string | null;
    targetPlatform: string | null;
    fidelityScore: number;
    degradations: string[];
  };
  sync: {
    version: number;
    pushedAt: string | null;
  };
  status: 'active' | 'archived';
}

/**
 * 构造默认 meta。
 *
 * @param partial 基础字段
 * @param createdAt 会话原生创建时间（session.createdAt）。不传时降级为当前时间——
 *   但调用方（push / migrate --push）应始终传入，否则 origin.createdAt 记录的是
 *   推送时间而非会话创建时间，会破坏 search 的时间衰减排序（见设计文档 P7）。
 */
export function defaultSyncMeta(
  partial: {
    platform: string;
    author: string;
    cwd: string;
    sessionId: string;
    repoIdentity?: string | null;
    /** Persisted verbatim into origin.title (the file name slug is lossy). */
    title?: string;
  },
  createdAt?: string,
): SessionSyncMeta {
  return {
    origin: {
      platform: partial.platform,
      title: partial.title,
      author: partial.author,
      cwd: partial.cwd,
      repoIdentity: partial.repoIdentity ?? null,
      createdAt: createdAt ?? utcNow(),
      sessionId: partial.sessionId,
    },
    migration: {
      migratedAt: null,
      sourcePlatform: null,
      targetPlatform: null,
      fidelityScore: 1.0,
      degradations: [],
    },
    sync: {
      version: 1,
      pushedAt: null,
    },
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// IndexEntry
// ---------------------------------------------------------------------------

export interface IndexEntry {
  sessionName: string;
  author: string;
  platform: string;
  title: string;
  cwd: string;
  repoIdentity: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  /**
   * 源平台的会话 ID（origin.sessionId）。
   *
   * push 去重键（P8）= sessionId + author：重复推送同一会话时更新既有条目，
   * 而不是 resolveNameConflict 生成 `xxx_1` 副本。可选项——旧索引/损坏索引
   * 重建前没有该字段，此时去重退化为旧的名冲突行为。
   */
  sessionId?: string;
}

interface RepoIndex {
  version: number;
  repoIdentity: string | null;
  updatedAt: string;
  sessions: IndexEntry[];
}

// ---------------------------------------------------------------------------
// SyncManager
// ---------------------------------------------------------------------------

/**
 * 管理团队仓 `sessions/` 目录下的完整会话存储。
 *
 * 与 AI agent 行为一致：
 * - 同一 git 仓库（remote）的会话聚在一起
 * - 不同仓库的会话天然隔离
 * - pull 时只拉当前 cwd 匹配的 repo 子目录
 */
export class SyncManager {
  private readonly sessionsDir: string;

  constructor(private readonly repoRoot: string) {
    this.sessionsDir = path.join(repoRoot, 'sessions');
  }

  // ------------------------------------------------------------------
  // 路径解析
  // ------------------------------------------------------------------

  /** 获取 repo 子目录路径。null identity → _unattributed */
  private repoDir(repoIdentity: string | null): string {
    if (!repoIdentity) {
      return path.join(this.sessionsDir, '_unattributed');
    }
    return path.join(this.sessionsDir, 'repos', encodeRepoIdentity(repoIdentity));
  }

  private indexPath(repoIdentity: string | null): string {
    return path.join(this.repoDir(repoIdentity), '_index.json');
  }

  private authorDir(repoIdentity: string | null, author: string): string {
    return path.join(this.repoDir(repoIdentity), sanitizePathSegment(author));
  }

  private sessionPaths(repoIdentity: string | null, author: string, sessionName: string) {
    const dir = this.authorDir(repoIdentity, author);
    return {
      jsonl: path.join(dir, `${sessionName}.jsonl`),
      meta: path.join(dir, `${sessionName}.meta.json`),
    };
  }

  // ------------------------------------------------------------------
  // 索引操作
  // ------------------------------------------------------------------

  private readIndex(repoIdentity: string | null): RepoIndex {
    const p = this.indexPath(repoIdentity);
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as RepoIndex;
      }
    } catch {
      // 索引损坏（解析失败）时静默重建会让 dedup 键丢失——同一会话再推
      // 会生成 _1 副本而用户毫无感知。至少喊一声，并给出自救命令。
      console.warn(`Warning: corrupted session index at ${p}, treating as empty.`);
      console.warn(`Run 'teamai session pull --all --repo-root <repo>' to rebuild indexes.`);
    }
    return { version: 1, repoIdentity, updatedAt: utcNow(), sessions: [] };
  }

  private writeIndex(repoIdentity: string | null, index: RepoIndex): void {
    const dir = this.repoDir(repoIdentity);
    fs.mkdirSync(dir, { recursive: true });
    index.updatedAt = utcNow();
    fs.writeFileSync(this.indexPath(repoIdentity), JSON.stringify(index, null, 2), 'utf-8');
  }

  private upsertIndexEntry(repoIdentity: string | null, entry: IndexEntry): void {
    const index = this.readIndex(repoIdentity);
    const key = `${entry.sessionName}:${entry.author}`;
    const idx = index.sessions.findIndex((s) => `${s.sessionName}:${s.author}` === key);
    if (idx >= 0) {
      index.sessions[idx] = entry;
    } else {
      index.sessions.push(entry);
    }
    this.writeIndex(repoIdentity, index);
  }

  private removeIndexEntry(repoIdentity: string | null, sessionName: string, author: string): void {
    const index = this.readIndex(repoIdentity);
    index.sessions = index.sessions.filter(
      (s) => !(s.sessionName === sessionName && s.author === author),
    );
    this.writeIndex(repoIdentity, index);
  }

  // ------------------------------------------------------------------
  // 名字冲突处理
  // ------------------------------------------------------------------

  private resolveNameConflict(repoIdentity: string | null, author: string, baseName: string): string {
    const { jsonl } = this.sessionPaths(repoIdentity, author, baseName);
    if (!fs.existsSync(jsonl)) return baseName;
    for (let i = 1; ; i++) {
      const candidate = `${baseName}_${i}`;
      const { jsonl: cJsonl } = this.sessionPaths(repoIdentity, author, candidate);
      if (!fs.existsSync(cJsonl)) return candidate;
    }
  }

  // ------------------------------------------------------------------
  // 保存 / 加载
  // ------------------------------------------------------------------

  /**
   * 按源平台 sessionId（+可选 author）在 repo 索引中查找既有条目。
   *
   * push 去重键（P8）：origin.sessionId + author。命中说明该会话曾推送过，
   * 应更新既有条目与文件，而不是再写一个 `_1` 副本。
   */
  private findByOriginSessionId(
    repoIdentity: string | null,
    sessionId: string,
    author?: string,
    platform?: string,
  ): IndexEntry | undefined {
    const index = this.readIndex(repoIdentity);
    return index.sessions.find(
      (s) =>
        s.sessionId === sessionId &&
        (!author || s.author === author) &&
        // platform 参与去重键：同一 sessionId 迁移到不同平台是不同的归档物
        // （meta.platform 各自独立），不能互相顶替——否则先 push codebuddy
        // 再 migrate --push 到 claude-code 会把前一条归档覆盖掉。
        (!platform || s.platform === platform),
    );
  }

  /**
   * 保存会话到团队仓。
   *
   * @param session IR Session
   * @param meta 同步元数据
   * @returns 写入的 jsonl 文件路径（相对于 repoRoot）
   */
  saveSession(session: Session, meta: SessionSyncMeta): string {
    const repoId = meta.origin.repoIdentity;
    const author = meta.origin.author;

    let sessionName = generateSessionName(session.platform, session.title, session.createdAt);
    // P8 去重：同一 origin.sessionId + author 重复推送时，复用原 sessionName
    // 覆盖写（upsertIndexEntry 按 sessionName:author 命中既有条目原地更新），
    // 而不是 resolveNameConflict 生成 `xxx_1` 副本。
    const existing = this.findByOriginSessionId(repoId, meta.origin.sessionId, author, session.platform);
    if (existing) {
      sessionName = existing.sessionName;
    } else {
      sessionName = this.resolveNameConflict(repoId, author, sessionName);
    }

    const paths = this.sessionPaths(repoId, author, sessionName);
    fs.mkdirSync(path.dirname(paths.jsonl), { recursive: true });

    // 写 JSONL — 每条消息一行
    const lines = session.messages.map((m) => JSON.stringify(messageToDict(m)));
    fs.writeFileSync(paths.jsonl, lines.join('\n') + '\n', 'utf-8');

    // 写 meta.json
    meta.sync.pushedAt = utcNow();
    fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2), 'utf-8');

    // 更新索引
    this.upsertIndexEntry(repoId, {
      sessionName,
      author,
      platform: session.platform,
      title: session.title,
      cwd: session.cwd,
      repoIdentity: repoId,
      messageCount: session.messages.length,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: meta.status,
      sessionId: meta.origin.sessionId,
    });

    return path.relative(this.repoRoot, paths.jsonl);
  }

  /**
   * 从团队仓加载会话。
   */
  loadSession(
    repoIdentity: string | null,
    sessionName: string,
    author?: string,
  ): { session: Session; meta: SessionSyncMeta } {
    const resolvedAuthor = author ?? this.findAuthor(repoIdentity, sessionName);
    const paths = this.sessionPaths(repoIdentity, resolvedAuthor, sessionName);

    if (!fs.existsSync(paths.jsonl)) {
      throw new Error(`Session file not found: ${paths.jsonl}`);
    }
    if (!fs.existsSync(paths.meta)) {
      throw new Error(`Meta file not found: ${paths.meta}`);
    }

    // 读 meta
    const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf-8')) as SessionSyncMeta;

    // 读 JSONL → 重建 Session
    const content = fs.readFileSync(paths.jsonl, 'utf-8');
    const messages = content
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => messageFromDict(JSON.parse(l) as Record<string, unknown>));

    // 从 meta + sessionName 提取标题
    // Prefer the persisted title; the file name slug is truncated + lowercased
    // and would otherwise rewrite every restored session's title.
    const title = meta.origin.title || this.extractTitleFromSessionName(sessionName);

    const session: Session = {
      sessionId: meta.origin.sessionId,
      title,
      cwd: meta.origin.cwd,
      platform: meta.origin.platform,
      createdAt: meta.origin.createdAt,
      updatedAt: utcNow(),
      messages,
      metadata: { originator: meta.migration.sourcePlatform ?? undefined },
    };

    return { session, meta };
  }

  /** 在 repo 目录下搜索 sessionName 属于哪个 author */
  private findAuthor(repoIdentity: string | null, sessionName: string): string {
    const dir = this.repoDir(repoIdentity);
    if (!fs.existsSync(dir)) throw new Error(`Repo directory not found: ${dir}`);
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('_')) continue;
      const candidate = path.join(dir, entry);
      if (!fs.statSync(candidate).isDirectory()) continue;
      if (fs.existsSync(path.join(candidate, `${sessionName}.jsonl`))) {
        return entry;
      }
    }
    throw new Error(`Session ${sessionName} not found (searched all author directories)`);
  }

  private extractTitleFromSessionName(sessionName: string): string {
    // 格式: {platform}_{title_slug}_{YYYYMMDD}
    const parts = sessionName.split('_');
    if (parts.length >= 3) {
      // 去掉首段(platform)和末段(date)
      return parts.slice(1, -1).join('_').replace(/-/g, ' ');
    }
    return sessionName;
  }

  // ------------------------------------------------------------------
  // 列表 / 删除
  // ------------------------------------------------------------------

  /**
   * 列出指定 repo 下的会话。
   * repoIdentity=null → _unattributed。
   * author 可选过滤。
   */
  listSessions(repoIdentity: string | null, author?: string): IndexEntry[] {
    const index = this.readIndex(repoIdentity);
    let sessions = index.sessions;
    if (author) {
      sessions = sessions.filter((s) => s.author === author);
    }
    return sessions;
  }

  /**
   * 列出所有 repo 的 repoIdentity。
   */
  listRepos(): string[] {
    const reposDir = path.join(this.sessionsDir, 'repos');
    if (!fs.existsSync(reposDir)) return [];
    return fs.readdirSync(reposDir).filter((d) => {
      return fs.statSync(path.join(reposDir, d)).isDirectory();
    });
  }

  /**
   * 列出团队仓中**所有** repo 的 canonical identity（含 `_unattributed` → null）。
   *
   * 目录名是编码后的（`/` → `_`）且解码有损，不能反推 canonical 原文——
   * 每个 repo 目录的 `_index.json` 存有 RepoIndex.repoIdentity（canonical 原文），
   * 从索引反查。目录损坏 / 无索引 / 无 identity 的目录跳过。
   *
   * `_unattributed` 在其 `_index.json` 存在或目录下有会话文件时以 null 一并返回。
   */
  listAllRepoIdentities(): Array<string | null> {
    const identities: Array<string | null> = [];
    const reposDir = path.join(this.sessionsDir, 'repos');
    if (fs.existsSync(reposDir)) {
      for (const dir of fs.readdirSync(reposDir)) {
        const full = path.join(reposDir, dir);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
          const idxPath = path.join(full, '_index.json');
          if (!fs.existsSync(idxPath)) continue;
          const index = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as RepoIndex;
          if (index.repoIdentity) identities.push(index.repoIdentity);
        } catch {
          // corrupted index / unreadable directory → skip
        }
      }
    }

    // _unattributed：索引存在，或目录下有会话内容（author 子目录）时纳入
    const unattrDir = path.join(this.sessionsDir, '_unattributed');
    if (fs.existsSync(unattrDir)) {
      let hasContent = fs.existsSync(path.join(unattrDir, '_index.json'));
      if (!hasContent) {
        try {
          hasContent = fs.readdirSync(unattrDir).some((e) => {
            if (e.startsWith('_')) return false;
            try {
              return fs.statSync(path.join(unattrDir, e)).isDirectory();
            } catch {
              return false;
            }
          });
        } catch {
          hasContent = false;
        }
      }
      if (hasContent) identities.push(null);
    }

    return identities;
  }

  /**
   * 跨 repo 列出全部会话（`list --all` / `search --all` 的数据源）。
   *
   * 对 listAllRepoIdentities() 的每个 identity 调 listSessions 并合并。
   * 每个条目的 repoIdentity 字段标识来源 repo（null → `_unattributed`），
   * 供展示层输出「来源」列；旧索引条目缺该值时用所在 repo 的 identity 回填。
   */
  listSessionsAcrossRepos(author?: string): IndexEntry[] {
    const out: IndexEntry[] = [];
    for (const identity of this.listAllRepoIdentities()) {
      for (const entry of this.listSessions(identity, author)) {
        out.push({ ...entry, repoIdentity: entry.repoIdentity ?? identity });
      }
    }
    return out;
  }

  deleteSession(repoIdentity: string | null, sessionName: string, author?: string): void {
    const resolvedAuthor = author ?? this.findAuthor(repoIdentity, sessionName);
    const paths = this.sessionPaths(repoIdentity, resolvedAuthor, sessionName);

    if (fs.existsSync(paths.jsonl)) fs.unlinkSync(paths.jsonl);
    if (fs.existsSync(paths.meta)) fs.unlinkSync(paths.meta);

    this.removeIndexEntry(repoIdentity, sessionName, resolvedAuthor);
  }

  // ------------------------------------------------------------------
  // 索引重建
  // ------------------------------------------------------------------

  /**
   * 扫描 repo 目录，幂等重建 _index.json。
   */
  rebuildIndex(repoIdentity: string | null): number {
    const dir = this.repoDir(repoIdentity);
    if (!fs.existsSync(dir)) return 0;

    const entries: IndexEntry[] = [];

    for (const authorName of fs.readdirSync(dir)) {
      if (authorName.startsWith('_')) continue;
      const authorDir = path.join(dir, authorName);
      if (!fs.statSync(authorDir).isDirectory()) continue;

      for (const file of fs.readdirSync(authorDir)) {
        if (!file.endsWith('.meta.json')) continue;
        const sessionName = file.replace('.meta.json', '');
        const metaPath = path.join(authorDir, file);
        const jsonlPath = path.join(authorDir, `${sessionName}.jsonl`);

        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionSyncMeta;
          const msgCount = fs.existsSync(jsonlPath)
            ? fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter((l) => l.trim()).length
            : 0;

          entries.push({
            sessionName,
            author: authorName,
            platform: meta.origin.platform,
            title: this.extractTitleFromSessionName(sessionName),
            cwd: meta.origin.cwd,
            repoIdentity: meta.origin.repoIdentity,
            messageCount: msgCount,
            createdAt: meta.origin.createdAt,
            updatedAt: meta.sync.pushedAt ?? meta.origin.createdAt,
            status: meta.status,
            sessionId: meta.origin.sessionId,
          });
        } catch {
          // skip corrupted entries
        }
      }
    }

    this.writeIndex(repoIdentity, {
      version: 1,
      repoIdentity,
      updatedAt: utcNow(),
      sessions: entries,
    });

    return entries.length;
  }

  // ------------------------------------------------------------------
  // Git 操作
  // ------------------------------------------------------------------

  private runGit(args: string[], check = true): string {
    try {
      return execFileSync('git', args, {
        cwd: this.repoRoot,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      if (check) throw e;
      return '';
    }
  }

  /**
   * git add sessions/ && git commit → 返回 commit hash。
   *
   * 无变更时 commit 静默失败，而 `rev-parse HEAD` 仍会返回旧 HEAD——调用方会
   * 误报 "Pushed N"。因此 commit 前先用 `status --porcelain -- sessions/`
   * 检测暂存区是否有变更，无变更返回 null，由调用方打印 "No changes to push"。
   */
  gitCommit(message: string): string | null {
    this.runGit(['add', 'sessions/']);
    const staged = this.runGit(['status', '--porcelain', '--', 'sessions/'], false);
    if (!staged.trim()) return null;

    // Only ever commit the archive paths: `git commit -m` without a pathspec
    // would also commit whatever else the user happened to have staged.
    const before = this.runGit(['rev-parse', 'HEAD'], false);
    const commit = this.runGit(['commit', '-m', message, '--', 'sessions/'], false);
    const after = this.runGit(['rev-parse', 'HEAD'], false);

    // A failed commit (hooks, gpg signing, identity config) must not be
    // reported as a successful push: no new HEAD means nothing was committed.
    if (!commit.trim() || (before && after === before)) return null;
    return after;
  }

  gitPush(remote = 'origin', branch?: string): void {
    const args = ['push', remote];
    if (branch) args.push(branch);
    this.runGit(args);
  }

  gitPull(remote = 'origin', branch?: string): void {
    const args = ['pull', remote];
    if (branch) args.push(branch);
    this.runGit(args);
  }

  getSyncStatus(): { uncommitted: number; ahead: number; behind: number } {
    const status = this.runGit(['status', '--porcelain'], false);
    const uncommitted = status ? status.split('\n').filter((l) => l.trim()).length : 0;

    let ahead = 0;
    let behind = 0;
    const revResult = this.runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], false);
    if (revResult) {
      const parts = revResult.split(/\s+/);
      if (parts.length === 2) {
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    }

    return { uncommitted, ahead, behind };
  }
}
