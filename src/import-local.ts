import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { callClaudeParallel } from './utils/ai-client.js';
import { listFilesRecursive, readFileSafe, writeFile, expandHome, ensureDir } from './utils/fs.js';
import { log } from './utils/logger.js';
import { assertSafePath, defaultAllowedRoots } from './utils/path-safety.js';
import type { ClassifiedItem, ImportSession, ImportSessionItem } from './types.js';

// ─── 常量 ──────────────────────────────────────────────────

/** 扫描时跳过超过此大小（字节）的文件。 */
const MAX_FILE_SIZE_BYTES = 50 * 1024;

/** AI 分类时截取的最大内容长度（字符）。 */
const MAX_CONTENT_CHARS = 3000;

/** import 会话文件默认路径。 */
const DEFAULT_SESSION_PATH = `${process.env.HOME}/.teamai/import-session.json`;

/** 并发调用 Claude 的最大数量。 */
const AI_CONCURRENCY = 3;

// ─── 内部辅助 ──────────────────────────────────────────────

/**
 * 将字符串转换为 kebab-case slug，去除特殊字符，最长 60 字符。
 *
 * @param title  原始标题
 * @returns      slug 字符串
 */
function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * 获取当前日期的 YYYY-MM-DD 字符串。
 *
 * @returns  日期字符串
 */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 生成目标文件名：`<YYYY-MM-DD>-<slug>.md`。
 *
 * @param title  文档标题
 * @returns      文件名字符串
 */
function buildFilename(title: string): string {
  const slug = toSlug(title) || 'untitled';
  return `${todayStr()}-${slug}.md`;
}

/**
 * 构造 AI 分类提示词。
 *
 * @param filePath    候选文件路径
 * @param rawContent  文件内容（前 3000 字符）
 * @returns           提示词字符串
 */
function buildClassifyPrompt(filePath: string, rawContent: string): string {
  return (
    `你是团队知识库管理员。分析以下文件内容，返回严格 JSON（不要加 markdown 代码块）：\n` +
    `{"type":"rule|doc|learning","title":"<简短标题，<60字符>","summary":"<一句话摘要>",` +
    `"tags":["tag1","tag2"],"confidence":0.8,"isPersonal":false}\n\n` +
    `判断规则：\n` +
    `- type="rule"：编码规范、团队约定、最佳实践文档\n` +
    `- type="doc"：技术文档、设计文档、API 说明\n` +
    `- type="learning"：经验总结、踩坑记录、解决方案\n` +
    `- isPersonal=true：个人偏好/环境配置（如本地路径、个人 token、个人习惯），不应进入团队库\n\n` +
    `文件路径：${filePath}\n` +
    `文件内容（前${MAX_CONTENT_CHARS}字）：\n` +
    rawContent
  );
}

/**
 * 解析 AI 返回的 JSON 为 ClassifiedItem，解析失败时返回保守默认值。
 *
 * 保守策略：isPersonal=true、confidence=0，确保不会意外将无法判断的文件写入团队库。
 *
 * @param sourcePath  源文件路径
 * @param rawContent  原始文件内容
 * @param output      AI 输出文本
 * @returns           ClassifiedItem
 */
function parseClassifyOutput(
  sourcePath: string,
  rawContent: string,
  output: string,
): ClassifiedItem {
  // 去掉可能残留的 markdown 代码块标记
  const cleaned = output.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as {
      type?: string;
      title?: string;
      summary?: string;
      tags?: unknown[];
      confidence?: number;
      isPersonal?: boolean;
    };
    const typeValue = parsed.type;
    const knownType: 'rule' | 'doc' | 'learning' =
      typeValue === 'rule' || typeValue === 'doc' || typeValue === 'learning'
        ? typeValue
        : 'learning';
    return {
      sourcePath,
      rawContent,
      type: knownType,
      title: typeof parsed.title === 'string' ? parsed.title : path.basename(sourcePath),
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      tags: Array.isArray(parsed.tags)
        ? (parsed.tags as string[]).filter((t) => typeof t === 'string')
        : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      isPersonal: typeof parsed.isPersonal === 'boolean' ? parsed.isPersonal : false,
    };
  } catch (parseErr: unknown) {
    // 解析失败 → 保守策略：标记为个人（不导入团队库），confidence=0
    log.warn(`AI classification parse failed, using conservative default (isPersonal=true): ${String(parseErr)}`);
    return {
      sourcePath,
      rawContent,
      type: 'learning',
      title: path.basename(sourcePath),
      summary: '',
      tags: [],
      confidence: 0,
      isPersonal: true,
    };
  }
}

/**
 * 根据 ClassifiedItem 构建带 YAML frontmatter 的 Markdown 字符串。
 *
 * 仅写入摘要作为正文，完整原始内容不重新格式化。
 *
 * @param item  分类结果
 * @returns     完整 Markdown 内容
 */
function buildMarkdown(item: ClassifiedItem): string {
  const tagsYaml =
    item.tags.length > 0
      ? `[${item.tags.map((t) => `"${t}"`).join(', ')}]`
      : '[]';
  return [
    '---',
    `title: "${item.title}"`,
    `author: import`,
    `date: ${todayStr()}`,
    `tags: ${tagsYaml}`,
    '---',
    '',
    item.summary,
    '',
  ].join('\n');
}

/**
 * 从 Markdown frontmatter 内容中粗略检测 type 字段。
 *
 * @param content  Markdown 文本
 * @returns        'rule' | 'doc' | 'learning'
 */
function detectTypeFromContent(content: string): 'rule' | 'doc' | 'learning' {
  if (/\btype:\s*rule\b/.test(content)) return 'rule';
  if (/\btype:\s*doc\b/.test(content)) return 'doc';
  return 'learning';
}

/**
 * 将 ImportSession 持久化到指定路径。
 *
 * @param session     会话对象
 * @param sessionPath 目标文件路径
 */
async function persistSession(session: ImportSession, sessionPath: string): Promise<void> {
  try {
    await writeFile(sessionPath, JSON.stringify(session, null, 2) + '\n');
  } catch (err: unknown) {
    log.error(`session persist failed [${sessionPath}]: ${String(err)}`);
  }
}

// ─── 公开导出函数 ──────────────────────────────────────────

/**
 * 扫描候选文件列表，返回路径与内容数组。
 *
 * 支持两种模式：
 * - dir 模式：扫描指定目录下的 .md/.txt 文件（跳过隐藏文件和 >50KB 文件）
 * - fromClaude 模式：扫描 ~/.claude/rules/ 和 ~/.cursor/rules/ 下的 .md 文件
 *
 * rawContent 只取前 3000 字符（用于 AI 分类，节省 token）。
 *
 * @param opts             扫描选项
 * @param opts.dir         要扫描的目录路径（可含 ~ 展开）
 * @param opts.fromClaude  为 true 时扫描 claude/cursor rules 目录
 * @returns                候选文件列表，每项包含 path 和 rawContent
 */
export async function scanCandidates(opts: {
  dir?: string;
  fromClaude?: boolean;
}): Promise<Array<{ path: string; rawContent: string }>> {
  const results: Array<{ path: string; rawContent: string }> = [];

  if (opts.dir) {
    const expandedDir = expandHome(opts.dir);
    // 安全校验：拒绝用户目录之外的路径（防止路径遍历）
    try {
      assertSafePath(expandedDir, defaultAllowedRoots());
    } catch (err: unknown) {
      throw new Error(`拒绝扫描目录：${String(err)}`);
    }
    const relPaths = await listFilesRecursive(expandedDir);
    for (const relPath of relPaths) {
      // 跳过路径中含隐藏段（以 . 开头）的文件
      if (relPath.split('/').some((seg) => seg.startsWith('.'))) continue;
      const ext = path.extname(relPath).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') continue;
      const absPath = path.join(expandedDir, relPath);
      try {
        const stat = fs.statSync(absPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;
      } catch (statErr: unknown) {
        log.warn(`cannot stat file, skipped: ${absPath} (${String(statErr)})`);
        continue;
      }
      const raw = await readFileSafe(absPath);
      if (raw === null) continue;
      results.push({ path: absPath, rawContent: raw.slice(0, MAX_CONTENT_CHARS) });
    }
  }

  if (opts.fromClaude) {
    const rulesBaseDirs = [
      expandHome('~/.claude/rules'),
      expandHome('~/.cursor/rules'),
    ];
    for (const baseDir of rulesBaseDirs) {
      if (!fs.existsSync(baseDir)) continue;
      const relPaths = await listFilesRecursive(baseDir);
      for (const relPath of relPaths) {
        if (path.extname(relPath).toLowerCase() !== '.md') continue;
        const absPath = path.join(baseDir, relPath);
        try {
          const stat = fs.statSync(absPath);
          if (stat.size > MAX_FILE_SIZE_BYTES) continue;
        } catch (statErr: unknown) {
          log.warn(`cannot stat file, skipped: ${absPath} (${String(statErr)})`);
          continue;
        }
        const raw = await readFileSafe(absPath);
        if (raw === null) continue;
        results.push({ path: absPath, rawContent: raw.slice(0, MAX_CONTENT_CHARS) });
      }
    }
  }

  return results;
}

/**
 * 用 AI 批量分类候选文件，过滤个人配置，并发 ≤ 3。
 *
 * 某个条目 AI 调用失败时，该条目以 isPersonal=true、confidence=0 保守处理；
 * 最终返回列表中已过滤掉 isPersonal=true 的条目。
 *
 * @param candidates  候选文件列表
 * @returns           过滤个人配置后的分类结果
 */
export async function classifyWithAI(
  candidates: Array<{ path: string; rawContent: string }>,
): Promise<ClassifiedItem[]> {
  if (candidates.length === 0) return [];

  const tasks = candidates.map((candidate) => ({
    prompt: buildClassifyPrompt(candidate.path, candidate.rawContent),
    parse: (output: string): ClassifiedItem =>
      parseClassifyOutput(candidate.path, candidate.rawContent, output),
  }));

  let classified: ClassifiedItem[];
  try {
    classified = await callClaudeParallel(tasks, AI_CONCURRENCY);
  } catch (err: unknown) {
    // AggregateError：部分失败，已在 parse 阶段尝试降级处理；此处全量 fallback 保守处理
    log.error(`AI classification partially failed, using conservative strategy for all entries: ${String(err)}`);
    classified = candidates.map((c) => ({
      sourcePath: c.path,
      rawContent: c.rawContent,
      type: 'learning' as const,
      title: path.basename(c.path),
      summary: '',
      tags: [],
      confidence: 0,
      isPersonal: true,
    }));
  }

  // 过滤个人配置条目
  return classified.filter((item) => !item.isPersonal);
}

/**
 * 交互式审查每个候选条目，支持 --resume 从已有会话继续。
 *
 * 用户选项：
 * - [A]ccept / Enter → 接受
 * - [S]kip           → 跳过
 * - [E]dit           → 提示用户输入新标题后接受（edited 状态）
 *
 * 每次选择后立即将会话状态持久化到 sessionPath，支持中断恢复。
 *
 * @param items             已分类的候选条目列表
 * @param opts              交互选项
 * @param opts.all          true 时跳过交互，全部接受
 * @param opts.sessionPath  会话状态文件路径，默认 ~/.teamai/import-session.json
 * @param opts.resume       true 时从已有会话继续（跳过非 pending 条目）
 * @returns                 完整的 ImportSession
 */
export async function interactiveReview(
  items: ClassifiedItem[],
  opts: {
    all?: boolean;
    sessionPath?: string;
    resume?: boolean;
  },
): Promise<ImportSession> {
  const sessionPath = opts.sessionPath ?? DEFAULT_SESSION_PATH;

  // 尝试加载已有会话（resume 模式）
  let session: ImportSession | null = null;
  if (opts.resume) {
    try {
      const raw = fs.readFileSync(expandHome(sessionPath), 'utf-8');
      session = JSON.parse(raw) as ImportSession;
    } catch (loadErr: unknown) {
      // 文件不存在或解析失败 → 新建会话
      log.warn(`failed to load session file, creating new session: ${String(loadErr)}`);
    }
  }

  if (session === null) {
    // 新建会话：将所有候选项映射为 pending 条目
    const sessionItems: ImportSessionItem[] = items.map((item, idx) => ({
      id: `item-${idx}`,
      sourcePath: item.sourcePath,
      status: 'pending' as const,
      learningDraft: {
        title: item.title,
        content: buildMarkdown(item),
      },
    }));
    session = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      mode: 'local',
      items: sessionItems,
      progress: 0,
    };
  } else {
    // resume 模式：补充新增条目（以 sourcePath 去重，避免重复）
    const existingPaths = new Set(session.items.map((i) => i.sourcePath ?? ''));
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!existingPaths.has(item.sourcePath)) {
        session.items.push({
          id: `item-${session.items.length}`,
          sourcePath: item.sourcePath,
          status: 'pending' as const,
          learningDraft: {
            title: item.title,
            content: buildMarkdown(item),
          },
        });
      }
    }
  }

  // 构建 sourcePath → ClassifiedItem 的快速查找表
  const classifiedMap = new Map<string, ClassifiedItem>(
    items.map((item) => [item.sourcePath, item]),
  );

  // 过滤出待处理条目
  const pendingItems = session.items.filter((item) => item.status === 'pending');
  const total = session.items.length;

  if (pendingItems.length === 0) {
    log.info('all entries processed, no further interaction needed.');
    return session;
  }

  // all 模式：全部自动接受，不读 stdin
  if (opts.all) {
    for (const item of pendingItems) {
      item.status = 'accepted';
    }
    session.progress = session.items.filter((i) => i.status !== 'pending').length;
    await persistSession(session, sessionPath);
    return session;
  }

  // 交互模式：逐条审查
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  let processedCount = session.items.filter((i) => i.status !== 'pending').length;

  for (const sessionItem of pendingItems) {
    const currentIndex = session.items.indexOf(sessionItem) + 1;
    const classified = classifiedMap.get(sessionItem.sourcePath ?? '');
    const title = sessionItem.learningDraft?.title
      ?? classified?.title
      ?? path.basename(sessionItem.sourcePath ?? '');
    const itemType = classified?.type ?? 'learning';
    const summary = classified?.summary ?? '';
    const tags = classified?.tags ?? [];

    process.stdout.write('\n');
    process.stdout.write(`[${currentIndex}/${total}] 📄 ${title} (${itemType})\n`);
    process.stdout.write(`  路径: ${sessionItem.sourcePath ?? ''}\n`);
    process.stdout.write(`  摘要: ${summary}\n`);
    process.stdout.write(`  Tags: ${tags.join(', ')}\n`);

    let answered = false;
    while (!answered) {
      // eslint-disable-next-line no-await-in-loop
      const input = await question('[A]ccept  [E]dit  [S]kip  > ');
      const choice = input.trim().toLowerCase();

      if (choice === 'a' || choice === '') {
        sessionItem.status = 'accepted';
        answered = true;
      } else if (choice === 's') {
        sessionItem.status = 'skipped';
        answered = true;
      } else if (choice === 'e') {
        // eslint-disable-next-line no-await-in-loop
        const newTitle = await question('  新标题: ');
        const trimmedTitle = newTitle.trim();
        if (trimmedTitle.length > 0 && sessionItem.learningDraft) {
          sessionItem.learningDraft.title = trimmedTitle;
          if (classified !== undefined) {
            // 用新标题重建 content 的 frontmatter
            sessionItem.learningDraft.content = buildMarkdown({ ...classified, title: trimmedTitle });
          }
        }
        sessionItem.status = 'edited';
        answered = true;
      } else {
        process.stdout.write('  请输入 A（接受）、E（编辑）或 S（跳过）\n');
      }
    }

    processedCount++;
    session.progress = processedCount;
    // 每次选择后立即持久化，支持中断恢复
    // eslint-disable-next-line no-await-in-loop
    await persistSession(session, sessionPath);
  }

  rl.close();
  return session;
}

/**
 * 将已接受的条目写入目标目录（团队 repo 或指定 outputDir）。
 *
 * 文件名格式：`<YYYY-MM-DD>-<slug>.md`
 * 文件内容：Markdown（含 YAML frontmatter）
 * dryRun=true 时只打印路径，不实际写文件。
 *
 * @param session        import 会话（含所有条目及状态）
 * @param repoPath       团队 repo 本地路径
 * @param opts           推送选项
 * @param opts.dryRun    true 时仅打印不写文件
 * @param opts.outputDir 指定统一输出目录（优先于 repoPath 子目录）
 * @returns              pushed 和 skipped 数量统计
 */
export async function pushAccepted(
  session: ImportSession,
  repoPath: string,
  opts: { dryRun?: boolean; outputDir?: string },
): Promise<{ pushed: number; skipped: number }> {
  let pushed = 0;
  let skipped = 0;

  const acceptedItems = session.items.filter(
    (item) => (item.status === 'accepted' || item.status === 'edited') && item.learningDraft,
  );

  for (const item of acceptedItems) {
    const draft = item.learningDraft!;
    const filename = buildFilename(draft.title);

    let destDir: string;
    if (opts.outputDir) {
      destDir = expandHome(opts.outputDir);
      // 安全校验：防止写出到用户目录范围之外
      try {
        assertSafePath(destDir, defaultAllowedRoots());
      } catch (err: unknown) {
        log.error(`refused to write to directory [${destDir}]: ${String(err)}`);
        skipped++;
        continue;
      }
    } else {
      // 根据 content frontmatter 判断 type，决定写入子目录
      const typeInContent = detectTypeFromContent(draft.content);
      const subDir =
        typeInContent === 'rule' ? 'rules'
        : typeInContent === 'doc' ? 'docs'
        : 'learnings';
      destDir = path.join(expandHome(repoPath), subDir);
    }

    const destPath = path.join(destDir, filename);

    if (opts.dryRun) {
      log.info(`[dry-run] would write: ${destPath}`);
      pushed++;
      continue;
    }

    try {
      await ensureDir(destDir);
      await writeFile(destPath, draft.content);
      log.info(`已写入: ${destPath}`);
      pushed++;
    } catch (err: unknown) {
      log.error(`写入失败 [${destPath}]: ${String(err)}`);
      skipped++;
    }
  }

  return { pushed, skipped };
}
