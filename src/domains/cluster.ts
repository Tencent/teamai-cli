import { callClaude } from '../utils/ai-client.js';
import { DomainsFileSchema } from './schema.js';
import type { DomainsFile, RepoMeta } from './schema.js';

/** AI 返回的域列表 JSON 结构（内部使用）。 */
interface AiClusterOutput {
    domains: Array<{
        name: string;
        description: string;
        confidence: number;
        repos: Array<{
            url: string;
            confidence: number;
            signal: string;
        }>;
    }>;
}

/**
 * 从 AI 返回的文本中提取 JSON 字符串（去除可能的 ```json 代码围栏）。
 */
function extractJson(text: string): string {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        return fenceMatch[1].trim();
    }
    // 尝试找到第一个 { 到最后一个 } 之间的内容
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.slice(start, end + 1);
    }
    return text.trim();
}

/**
 * 构建聚类 prompt，输入信号按权重排列：README > description/keywords > 仓库名 > 语言。
 */
function buildClusterPrompt(repos: RepoMeta[], confidenceThreshold: number): string {
    const repoList = repos.map((r) => {
        const parts: string[] = [`- URL: ${r.url}`, `  仓库名: ${r.name}`];
        if (r.readme_excerpt) {
            parts.push(`  README首段: ${r.readme_excerpt.slice(0, 500)}`);
        }
        if (r.description) {
            parts.push(`  描述: ${r.description}`);
        }
        if (r.keywords && r.keywords.length > 0) {
            parts.push(`  关键词: ${r.keywords.join(', ')}`);
        }
        if (r.primary_language) {
            parts.push(`  主要语言: ${r.primary_language}`);
        }
        return parts.join('\n');
    }).join('\n\n');

    return `你是一位技术架构师，请根据以下仓库信息进行业务域聚类分析。

## 仓库列表

${repoList}

## 聚类要求

1. 把相关仓库归入同一个业务域。
2. 置信度低于 ${confidenceThreshold} 的仓库必须放入名为「未分类」的域，不得放入其他域。
3. 每个仓库只能出现在一个域中，不能重复。
4. 域名用中文，简洁 2-4 字（如「基础设施」「前端应用」「数据处理」）。
5. confidence 字段为 0-1 之间的小数，表示归类把握程度。
6. signal 字段用一句话说明归类依据。

## 输出格式

请严格输出以下 JSON 格式，不要输出任何其他内容：

{
  "domains": [
    {
      "name": "域名（中文2-4字）",
      "description": "域的功能描述",
      "confidence": 0.9,
      "repos": [
        {
          "url": "仓库URL",
          "confidence": 0.85,
          "signal": "归类依据说明"
        }
      ]
    }
  ]
}`;
}

/**
 * 调用 AI 对仓库列表做业务域聚类。
 *
 * @param repos 仓库元信息列表（≥ 1 个）
 * @param opts.confidenceThreshold 默认 0.6；低于此阈值的仓必须进「未分类」域
 * @returns DomainsFile 草稿，generated_at/generator 已填好
 */
export async function clusterRepos(
    repos: RepoMeta[],
    opts?: { confidenceThreshold?: number }
): Promise<DomainsFile> {
    const confidenceThreshold = opts?.confidenceThreshold ?? 0.6;
    const prompt = buildClusterPrompt(repos, confidenceThreshold);

    const rawOutput = await callClaude(prompt);
    const jsonStr = extractJson(rawOutput);

    let aiOutput: AiClusterOutput;
    try {
        aiOutput = JSON.parse(jsonStr) as AiClusterOutput;
    } catch (err) {
        throw new Error(`AI cluster output invalid: failed to parse JSON — ${String(err)}`);
    }

    // 用 zod 校验 AI 输出结构
    const partialSchema = DomainsFileSchema.pick({ domains: true });
    const validation = partialSchema.safeParse(aiOutput);
    if (!validation.success) {
        const issues = validation.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
        throw new Error(`AI cluster output invalid: ${issues}`);
    }

    // 构造完整 DomainsFile
    const domainsFile: DomainsFile = DomainsFileSchema.parse({
        version: 1,
        generated_at: new Date().toISOString(),
        generator: 'import --bootstrap-domains',
        confidence_threshold: confidenceThreshold,
        domains: aiOutput.domains,
    });

    // 后置校验：确保所有输入 repos 都被分配到某个域
    const assignedUrls = new Set(
        domainsFile.domains.flatMap((d) => d.repos.map((r) => r.url))
    );

    const missingRepos = repos.filter((r) => !assignedUrls.has(r.url));
    if (missingRepos.length > 0) {
        // 将漏分配的仓库补入「未分类」域
        let unclassified = domainsFile.domains.find((d) => d.name === '未分类');
        if (!unclassified) {
            unclassified = {
                name: '未分类',
                description: 'AI 未能归类的仓库',
                repos: [],
            };
            domainsFile.domains.push(unclassified);
        }
        for (const repo of missingRepos) {
            unclassified.repos.push({
                url: repo.url,
                confidence: 0,
                signal: 'AI 聚类时未分配，自动补入未分类',
                locked: false,
            });
        }
    }

    return domainsFile;
}
