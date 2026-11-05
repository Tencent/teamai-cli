import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── mock gray-matter ──────────────────────────────────────────────────────
vi.mock('gray-matter', () => ({
  default: vi.fn((content: string) => {
    // 简单模拟：识别 ---\ntags: [a, b]\n--- 格式
    const match = content.match(/^---\ntags:\s*\[([^\]]*)\]\n---/);
    if (match) {
      const tags = match[1]!.split(',').map((t) => t.trim()).filter(Boolean);
      return { data: { tags }, content };
    }
    return { data: {}, content };
  }),
}));

// ─── mock node:fs ──────────────────────────────────────────────────────────
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ''),
  },
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ''),
}));

// ─── mock node:child_process ───────────────────────────────────────────────
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

// ─── mock utils/git ────────────────────────────────────────────────────────
vi.mock('../utils/git.js', () => ({
  createGit: vi.fn(() => ({
    log: vi.fn(async () => ({ all: [] })),
  })),
}));

// ─── mock tool-launch/call ─────────────────────────────────────────────────
vi.mock('../tool-launch/call.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../tool-launch/call.js')>(),
  callTool: vi.fn(),
}));

import fs from 'node:fs';
import { callTool } from '../tool-launch/call.js';
import { generateCodebaseMd } from '../codebase.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const mockCallTool = vi.mocked(callTool);
const mockFsExistsSync = vi.mocked(fs.existsSync);
const mockFsReaddirSync = vi.mocked(fs.readdirSync);
const mockFsReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  // 默认：fs 调用都返回"不存在"
  mockFsExistsSync.mockReturnValue(false);
  mockFsReaddirSync.mockReturnValue([]);
  mockFsReadFileSync.mockReturnValue('');
});

// ─── generateCodebaseMd ────────────────────────────────────────────────────

describe('generateCodebaseMd', () => {
  it('输出顶部应包含标准 frontmatter（lastUpdated / source / generator）', async () => {
    mockCallTool.mockResolvedValue({ text: '# Codebase 概览\n\n## 项目概述\n内容', tool: 'claude' });

    const result = await generateCodebaseMd({ repoPath: '/repo/test' });

    expect(result).toMatch(/^---\n/);
    expect(result).toContain('lastUpdated:');
    expect(result).toContain('source: /repo/test');
    expect(result).toContain('generator: teamai-cli');
  });

  it('AI 输出已含 frontmatter 时应去重，最终只有一份 frontmatter', async () => {
    const aiOutputWithFrontmatter =
      '---\ntitle: 旧标题\n---\n\n# Codebase 概览\n\n## 项目概述\n内容';
    mockCallTool.mockResolvedValue({ text: aiOutputWithFrontmatter, tool: 'claude' });

    const result = await generateCodebaseMd({ repoPath: '/repo/test' });

    // 只应出现一次 `---\n`（即新 frontmatter 的开头）
    const frontmatterCount = (result.match(/^---$/gm) ?? []).length;
    expect(frontmatterCount).toBe(2); // 开头 --- 和结束 ---
    expect(result).toContain('generator: teamai-cli');
    // 旧 frontmatter 内容不应保留
    expect(result).not.toContain('旧标题');
  });

  it('有 learningsSuggestions 时，callTool 的 prompt 应包含建议内容', async () => {
    mockCallTool.mockResolvedValue({ text: '# Codebase 概览', tool: 'claude' });

    await generateCodebaseMd({
      repoPath: '/repo/test',
      learningsSuggestions: [
        { section: '技术栈', action: 'update', content: '新增 vitest 依赖' },
      ],
    });

    const prompt = mockCallTool.mock.calls[0]![0] as string;
    expect(prompt).toContain('最近 MR 提炼建议');
    expect(prompt).toContain('技术栈');
    expect(prompt).toContain('新增 vitest 依赖');
  });

  it('有 learningsDir 且目录存在时，prompt 应包含高频标签', async () => {
    // 模拟 learningsDir 存在并有两个 .md 文件
    mockFsExistsSync.mockImplementation((p: fs.PathLike) => {
      return String(p) === '/repo/test/learnings';
    });
    mockFsReaddirSync.mockImplementation((p: fs.PathLike | fs.PathOrFileDescriptor) => {
      if (String(p) === '/repo/test/learnings') {
        return ['a.md', 'b.md'] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      return [] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    mockFsReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p).endsWith('.md')) {
        return '---\ntags: [typescript, testing]\n---\n内容';
      }
      return '';
    });

    mockCallTool.mockResolvedValue({ text: '# Codebase 概览', tool: 'claude' });

    await generateCodebaseMd({
      repoPath: '/repo/test',
      learningsDir: '/repo/test/learnings',
    });

    const prompt = mockCallTool.mock.calls[0]![0] as string;
    expect(prompt).toContain('高频标签');
  });
});

