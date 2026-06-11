import { z } from 'zod';
import { callClaude } from '../utils/ai-client.js';
import type { DomainsFile, RepoMeta } from './schema.js';

/** 单仓推荐结果。 */
export interface RecommendResult {
    domain: string;         // 推荐域名（可能是「未分类」）
    confidence: number;
    signal: string;         // 推荐依据
    alternatives: { domain: string; confidence: number }[];  // 备选 top-2
}

/** AI 返回的推荐 JSON 结构（内部使用）。 */
const RecommendOutputSchema = z.object({
    domain: z.string().min(1),
    confidence: z.number().min(0).max(1),
    signal: z.string(),
    alternatives: z.array(
        z.object({
            domain: z.string(),
            confidence: z.number().min(0).max(1),
        })
    ).default([]),
});

/**
 * 从 AI 返回文本中提取 JSON 字符串（去除代码围栏）。
 */
function extractJson(text: string): string {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        return fenceMatch[1].trim();
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.slice(start, end + 1);
    }
    return text.trim();
}

/**
 * 在已有域字典基础上，为单个新仓推荐归属。
 *
 * @param repo 仓库元信息
 * @param existing 现有 domains.yaml（用于让 AI 选择已有域而非新造）
 * @param opts.confidenceThreshold 默认沿用 existing.confidence_threshold
 */
export async function recommendDomain(
    repo: RepoMeta,
    existing: DomainsFile,
    opts?: { confidenceThreshold?: number }
): Promise<RecommendResult> {
    const threshold = opts?.confidenceThreshold ?? existing.confidence_threshold;

    // 构建已有域列表描述
    const domainList = existing.domains.map((d) => {
        const desc = d.description ? `（${d.description}）` : '';
        return `- ${d.name}${desc}`;
    }).join('\n');

    // 构建仓库描述
    const repoDesc: string[] = [`仓库名: ${repo.name}`, `URL: ${repo.url}`];
    if (repo.readme_excerpt) {
        repoDesc.push(`README首段: ${repo.readme_excerpt.slice(0, 500)}`);
    }
    if (repo.description) {
        repoDesc.push(`描述: ${repo.description}`);
    }
    if (repo.keywords && repo.keywords.length > 0) {
        repoDesc.push(`关键词: ${repo.keywords.join(', ')}`);
    }
    if (repo.primary_language) {
        repoDesc.push(`主要语言: ${repo.primary_language}`);
    }

    const prompt = `你是一位技术架构师，请为以下新仓库推荐归属的业务域。

## 现有业务域

${domainList || '（暂无已有域）'}

## 新仓库信息

${repoDesc.join('\n')}

## 推荐要求

1. 优先从已有业务域中选择最合适的。
2. 仅当没有任何已有域匹配，或置信度低于 ${threshold} 时，返回「未分类」作为推荐域。
3. 提供最多 2 个备选域（alternatives），按置信度降序排列。
4. signal 字段用一句话说明推荐依据。

## 输出格式

请严格输出以下 JSON 格式，不要输出任何其他内容：

{
  "domain": "推荐域名",
  "confidence": 0.85,
  "signal": "推荐依据说明",
  "alternatives": [
    { "domain": "备选域1", "confidence": 0.6 },
    { "domain": "备选域2", "confidence": 0.4 }
  ]
}`;

    const rawOutput = await callClaude(prompt);
    const jsonStr = extractJson(rawOutput);

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (err) {
        throw new Error(`recommendDomain: failed to parse AI output JSON — ${String(err)}`);
    }

    const validation = RecommendOutputSchema.safeParse(parsed);
    if (!validation.success) {
        const issues = validation.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
        throw new Error(`recommendDomain: AI output invalid — ${issues}`);
    }

    return validation.data;
}
