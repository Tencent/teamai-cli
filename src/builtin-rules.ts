import path from 'node:path';
import { ensureDir, writeFile, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { ResourceHandler } from './resources/base.js';
import type { TeamaiConfig, LocalConfig } from './types.js';
import { resolveBaseDir } from './types.js';
import fs from 'node:fs/promises';

// ─── Built-in rules deployment ──────────────────────────
//
//  CLI ships with built-in rules that guide AI tool behavior.
//  Unlike team repo rules (managed by users), these are
//  maintained alongside the CLI code and deployed automatically
//  on each `teamai pull`.
//
//  teamai-recall.md instructs the AI to proactively search the team
//  knowledge base (via the `teamai-recall` subagent or `teamai recall`)
//  before starting a task — this replaced the old passive auto-recall
//  PostToolUse hook, which fired implicitly on every Bash/Grep/WebSearch/
//  WebFetch call but added noise without the benefit of the subagent's
//  codebase-graph drill-down and compact structured output.
//

/** Names of CLI built-in rules. Used by push to exclude them from team repo push. */
export const BUILTIN_RULE_NAMES = new Set<string>(['teamai-recall']);

/** Names of previously deployed rules that should be cleaned up. */
export const LEGACY_RULE_NAMES: string[] = [];

/**
 * Names that scanLocalForPush and stale-cleanup should skip.
 * Includes both current built-in rules and legacy rules (being cleaned up).
 */
export const EXCLUDED_RULE_NAMES = new Set<string>([
    ...BUILTIN_RULE_NAMES,
    ...LEGACY_RULE_NAMES,
]);

/**
 * Deploy CLI built-in rules to all configured AI tool rules directories.
 *
 * Also cleans up legacy built-in rules that are no longer deployed.
 *
 * @returns Number of tool directories that received built-in rules.
 */
export async function deployBuiltinRules(teamConfig: TeamaiConfig, localConfig?: LocalConfig): Promise<number> {
    const baseDir = localConfig ? resolveBaseDir(localConfig) : (process.env.HOME ?? '');
    let deployed = 0;

    const builtinRules: Array<{ name: string; content: string }> = [
        { name: 'teamai-recall', content: TEAMAI_RECALL_RULE_CONTENT },
    ];

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
        if (!toolPath.rules) continue;

        // Skip tools that are not installed
        if (!await ResourceHandler.isToolInstalled(toolPath.rules, baseDir)) {
            log.debug(`Skipping built-in rules for ${tool}: tool not installed`);
            continue;
        }

        const rulesDir = path.join(baseDir, toolPath.rules);
        if (!await pathExists(rulesDir)) continue;

        try {
            await ensureDir(rulesDir);

            // Deploy current built-in rules
            for (const rule of builtinRules) {
                const destFile = path.join(rulesDir, `${rule.name}.md`);
                await writeFile(destFile, rule.content);
                log.debug(`Deployed built-in rule ${rule.name} → ${tool}`);
            }

            // Clean up legacy rules no longer deployed
            for (const legacyName of LEGACY_RULE_NAMES) {
                const legacyFile = path.join(rulesDir, `${legacyName}.md`);
                try {
                    await fs.unlink(legacyFile);
                    log.debug(`Removed legacy built-in rule ${legacyName} from ${tool}`);
                } catch {
                    // File doesn't exist — that's fine
                }
            }

            deployed++;
        } catch (e) {
            log.error(`Failed to deploy built-in rules to ${tool}: ${(e as Error).message}`);
        }
    }

    return deployed;
}

// ─── Rule content ──────────────────────────────────────

const TEAMAI_RECALL_RULE_CONTENT = `# Team Knowledge Recall (teamai)

## 规则：任务开始前必须检索团队知识库

**Before** starting any task that involves code changes, debugging,
or design decisions, you **MUST** first search the team knowledge base.

### 方式一：通过 Subagent（推荐，适用于支持 Agent tool 的工具）

调用 \`teamai-recall\` subagent（位于 agents/ 目录），传入任务的自然语言描述。
Subagent 会返回结构化的团队知识摘要（skills、learnings、docs、rules、codebase）。

### 方式二：通过 Bash 命令（适用于所有工具）

\`\`\`bash
teamai recall "<关键词1> <关键词2> ..."
\`\`\`

从任务描述中提取 3-6 个高信号关键词进行检索。

### 检索后要求

完成任务后，在最终回复中声明实际引用了哪些知识条目：

\`\`\`
<!-- teamai:referenced-doc-ids: [doc-id-1, doc-id-2] -->
\`\`\`

如无相关命中则声明空列表：\`<!-- teamai:referenced-doc-ids: [] -->\`
`;

