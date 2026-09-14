/**
 * fs.ts — 路径解析与 JSONL 读写工具。
 *
 * 提供各平台会话存储路径的解析，以及 cwd 编码/解码（不同平台对工作目录
 * 的编码规则不同），还有流式 JSONL 读写。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// 平台默认存储路径
// ---------------------------------------------------------------------------

export function getClaudeCodeProjectsDir(): string {
  return path.join(homedir(), '.claude', 'projects');
}

/** TeamAI 变体: claude-internal */
export function getClaudeInternalProjectsDir(): string {
  return path.join(homedir(), '.claude-internal', 'projects');
}

/** TeamAI 变体: tclaude */
export function getTClaudeProjectsDir(): string {
  return path.join(homedir(), '.tclaude', 'projects');
}

export function getCodexSessionsDir(): string {
  return path.join(homedir(), '.codex', 'sessions');
}

/** TeamAI 变体: codex-internal */
export function getCodexInternalSessionsDir(): string {
  return path.join(homedir(), '.codex-internal', 'sessions');
}

/** TeamAI 变体: tcodex */
export function getTCodexSessionsDir(): string {
  return path.join(homedir(), '.tcodex', 'sessions');
}

export function getCodeBuddyProjectsDir(): string {
  return path.join(homedir(), '.codebuddy', 'projects');
}

/**
 * WorkBuddy 会话目录。与 CodeBuddy 同构（<encoded-cwd>/<uuid>.jsonl），
 * 但额外提供 <uuid>.meta.json，其中带真实 cwd —— 可绕开目录名反解的有损问题。
 */
export function getWorkBuddyProjectsDir(): string {
  return path.join(homedir(), '.workbuddy', 'projects');
}

export function getCursorProjectsDir(): string {
  return path.join(homedir(), '.cursor', 'projects');
}

// ---------------------------------------------------------------------------
// cwd 编码/解码
// ---------------------------------------------------------------------------

/**
 * Claude Code 的 cwd 编码: 所有非字母数字字符 → `-`，有前导 `-`。
 * 例: `/home/user/project` → `-home-user-project`
 *     `/Users/foo/my project` → `-Users-foo-my-project`
 */
export function encodeCwdClaude(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * CodeBuddy / Cursor 的 cwd 编码: 所有非字母数字字符 → `-`，无前导 `-`。
 * 例: `/home/user/project` → `home-user-project`
 *     `/Users/foo/my project` → `Users-foo-my-project`
 */
export function encodeCwdGeneric(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
}

/**
 * Claude Code 的 cwd 解码: 无法精确还原（`-` 可能来自 `/`、空格等），
 * 但目录名本身不需要解码为可用路径——仅用于显示。
 * 这里返回原始 encoded 字符串作为显示用 cwd。
 */
export function decodeCwdClaude(encoded: string): string {
  // 无法精确反推，返回 encoded 本身（调用方应从 session_meta 等获取真实 cwd）
  return encoded;
}

/**
 * CodeBuddy / Cursor 的 cwd 解码: 同上，无法精确还原。
 */
export function decodeCwdGeneric(encoded: string): string {
  return encoded;
}

// ---------------------------------------------------------------------------
// JSONL 流式读写
// ---------------------------------------------------------------------------

/**
 * 流式读取 JSONL 文件，逐行返回解析后的对象。
 * 空行自动跳过；解析失败的行抛出 SyntaxError。
 */
export function* readJsonl(filePath: string): Generator<Record<string, unknown>> {
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as Record<string, unknown>;
  }
}

/**
 * 逐行读取 JSONL 文件的前 N 行（用于提取元信息，避免加载大文件）。
 */
export function* readJsonlHead(filePath: string, maxLines: number): Generator<Record<string, unknown>> {
  const content = fs.readFileSync(filePath, 'utf-8');
  let count = 0;
  for (const line of content.split('\n')) {
    if (count >= maxLines) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    count++;
    yield JSON.parse(trimmed) as Record<string, unknown>;
  }
}

/**
 * 流式写入 JSONL 文件，每个对象写一行。
 * 自动创建父目录。
 */
export function writeJsonl(filePath: string, records: Iterable<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines: string[] = [];
  for (const record of records) {
    lines.push(JSON.stringify(record));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// 文件系统辅助
// ---------------------------------------------------------------------------

export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 递归扫描目录下所有匹配的文件，按修改时间降序排列。
 */
export function scanFiles(rootDir: string, pattern: RegExp): string[] {
  if (!dirExists(rootDir)) return [];
  const results: string[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  };
  walk(rootDir);
  results.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return results;
}

/**
 * 递归删除目录（用于 delete_session 清理子目录）。
 */
export function removeDirRecursive(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
