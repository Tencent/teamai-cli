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

// ─── mock utils/ai-client ─────────────────────────────────────────────────
vi.mock('../utils/ai-client.js', () => ({
  callClaude: vi.fn(),
}));

import fs from 'node:fs';
import { callClaude } from '../utils/ai-client.js';
import {
  generateCodebaseMd,
  generateCodebaseIndex,
  lintCodebaseMd,
} from '../codebase.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const mockCallClaude = vi.mocked(callClaude);
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
    mockCallClaude.mockResolvedValue('# Codebase 概览\n\n## 项目概述\n内容');

    const result = await generateCodebaseMd({ repoPath: '/repo/test' });

    expect(result).toMatch(/^---\n/);
    expect(result).toContain('lastUpdated:');
    expect(result).toContain('source: /repo/test');
    expect(result).toContain('generator: teamai-cli');
  });

  it('AI 输出已含 frontmatter 时应去重，最终只有一份 frontmatter', async () => {
    const aiOutputWithFrontmatter =
      '---\ntitle: 旧标题\n---\n\n# Codebase 概览\n\n## 项目概述\n内容';
    mockCallClaude.mockResolvedValue(aiOutputWithFrontmatter);

    const result = await generateCodebaseMd({ repoPath: '/repo/test' });

    // 只应出现一次 `---\n`（即新 frontmatter 的开头）
    const frontmatterCount = (result.match(/^---$/gm) ?? []).length;
    expect(frontmatterCount).toBe(2); // 开头 --- 和结束 ---
    expect(result).toContain('generator: teamai-cli');
    // 旧 frontmatter 内容不应保留
    expect(result).not.toContain('旧标题');
  });

  it('有 learningsSuggestions 时，callClaude 的 prompt 应包含建议内容', async () => {
    mockCallClaude.mockResolvedValue('# Codebase 概览');

    await generateCodebaseMd({
      repoPath: '/repo/test',
      learningsSuggestions: [
        { section: '技术栈', action: 'update', content: '新增 vitest 依赖' },
      ],
    });

    const prompt = mockCallClaude.mock.calls[0]![0] as string;
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

    mockCallClaude.mockResolvedValue('# Codebase 概览');

    await generateCodebaseMd({
      repoPath: '/repo/test',
      learningsDir: '/repo/test/learnings',
    });

    const prompt = mockCallClaude.mock.calls[0]![0] as string;
    expect(prompt).toContain('高频标签');
  });
});

// ─── generateCodebaseIndex ─────────────────────────────────────────────────

describe('generateCodebaseIndex', () => {
  it('happy path：AI 返回合法 JSON，输出应含表格行', async () => {
    const validJson = JSON.stringify([
      { section: '项目概述', summary: '描述项目背景', keywords: ['CLI', 'TypeScript'] },
      { section: '技术栈', summary: '列出使用的技术', keywords: ['Node.js', 'vitest', 'tsup'] },
    ]);
    mockCallClaude.mockResolvedValue(validJson);

    const result = await generateCodebaseIndex('# Codebase\n\n## 项目概述\n内容');

    expect(result).toContain('| 章节 | 摘要 | 关键词 |');
    expect(result).toContain('项目概述');
    expect(result).toContain('技术栈');
    expect(result).toContain('lastUpdated:');
  });

  it('AI 返回非 JSON 时，应不抛异常并返回兜底 markdown', async () => {
    mockCallClaude.mockResolvedValue('抱歉，我无法生成索引。');

    const result = await generateCodebaseIndex('# Codebase');

    expect(result).not.toThrow;
    expect(result).toContain('title: Codebase 索引');
    expect(result).toContain('⚠️');
  });

  it('AI 返回包裹在代码块中的 JSON 时，应能正确解析', async () => {
    const validJson = JSON.stringify([
      { section: '测试覆盖', summary: '测试策略与覆盖率', keywords: ['unit', 'e2e'] },
    ]);
    mockCallClaude.mockResolvedValue(`\`\`\`json\n${validJson}\n\`\`\``);

    const result = await generateCodebaseIndex('# Codebase\n\n## 测试覆盖\n内容');

    expect(result).toContain('测试覆盖');
  });
});

// ─── lintCodebaseMd ────────────────────────────────────────────────────────

describe('lintCodebaseMd', () => {
  it('happy path：AI 返回合法 JSON，应正确解析 issues 列表', async () => {
    const validJson = JSON.stringify({
      summary: '发现 2 个问题',
      issues: [
        {
          severity: 'high',
          category: 'outdated',
          location: '技术栈',
          description: 'Node 版本已过时',
          suggestion: '更新至 Node 20',
        },
        {
          severity: 'medium',
          category: 'missing',
          location: '测试覆盖',
          description: '缺少 E2E 测试说明',
          suggestion: '补充 E2E 章节',
        },
      ],
    });
    mockCallClaude.mockResolvedValue(validJson);

    const report = await lintCodebaseMd('# Codebase');

    expect(report.summary).toBe('发现 2 个问题');
    expect(report.issues).toHaveLength(2);
    expect(report.issues[0]!.severity).toBe('high');
    expect(report.issues[0]!.category).toBe('outdated');
  });

  it('AI 返回非 JSON 时，应不抛异常并返回兜底 report', async () => {
    mockCallClaude.mockResolvedValue('文档看起来不错！');

    const report = await lintCodebaseMd('# Codebase');

    expect(report.issues).toEqual([]);
    expect(report.summary).toBe('解析失败，无法 lint');
  });

  it('callClaude 抛出异常时，应不向上传播并返回兜底 report', async () => {
    mockCallClaude.mockRejectedValue(new Error('AI 服务不可用'));

    const report = await lintCodebaseMd('# Codebase');

    expect(report.issues).toEqual([]);
    expect(report.summary).toBe('解析失败，无法 lint');
  });

  it('AI 返回包含 JSON 的混合文本时，应能提取 JSON', async () => {
    const validJson = JSON.stringify({
      summary: '无问题',
      issues: [],
    });
    mockCallClaude.mockResolvedValue(`以下是检查结果：\n${validJson}\n感谢使用。`);

    const report = await lintCodebaseMd('# Codebase');

    expect(report.summary).toBe('无问题');
    expect(report.issues).toHaveLength(0);
  });
});
