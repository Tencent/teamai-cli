import path from 'node:path';
import { ensureDir, writeFile, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { renderRuleForTool, ruleFileExtensionForTool } from './resources/rule-format.js';
import type { TeamaiConfig, LocalConfig } from './types.js';
import { installOf, locate, ownOf, writable, type Install } from './locate.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { DeliveryRecorder } from './git-exclude-delivered.js';

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
 * The rule file a pull writes the culture, claudemd and recall blocks into
 * for tools whose rules directory is their instruction target (#945).
 */
export const TEAMAI_CONTEXT_RULE_NAME = 'teamai-context';

/**
 * Names that scanLocalForPush and stale-cleanup should skip.
 * Includes both current built-in rules and legacy rules (being cleaned up).
 */
export const EXCLUDED_RULE_NAMES = new Set<string>([
    ...BUILTIN_RULE_NAMES,
    ...LEGACY_RULE_NAMES,
    TEAMAI_CONTEXT_RULE_NAME,
]);

/**
 * Deploy CLI built-in rules to all configured AI tool rules directories.
 *
 * Also cleans up legacy built-in rules that are no longer deployed.
 *
 * @returns Number of tool directories that received built-in rules.
 */
export async function deployBuiltinRules(
    teamConfig: TeamaiConfig,
    localConfig?: LocalConfig,
    options?: {
        skipRecall?: boolean; recorder?: DeliveryRecorder; dryRun?: boolean;
        /** Gets each tool that did not take every built-in rule (`DeliveryLedger.toolsMissingRules`). */
        toolsMissingRules?: Set<string>;
    },
): Promise<number> {
    const install: Install = localConfig === undefined
        ? { toolPaths: teamConfig.toolPaths, agents: {}, toolRoots: {}, gitExclude: false, scope: 'user' }
        : installOf(teamConfig, localConfig);
    let deployed = 0;

    const builtinRules: Array<{ name: string; content: string }> = [
        { name: 'teamai-recall', content: recallRuleContent(teamConfig.language) },
    ].filter(r => !(options?.skipRecall && r.name === 'teamai-recall'));

    for (const tool of Object.keys(install.toolPaths)) {
        const location = await locate(tool, 'rules', install);
        if (ownOf(location)?.kind !== 'dir') continue;
        const own = writable(location);
        if (own === null) {
            log.debug(`Skipping built-in rules for ${tool}: tool not installed`);
            continue;
        }

        const rulesDir = own.path;
        if (!await pathExists(rulesDir)) continue;
        // A dry run writes nothing: it reports where each rule would land (#915).
        if (options?.dryRun) {
            const ext = ruleFileExtensionForTool(tool);
            for (const rule of builtinRules) options.recorder?.report('builtin', path.join(rulesDir, `${rule.name}${ext}`));
            deployed++;
            continue;
        }

        try {
            await ensureDir(rulesDir);

            // Deploy current built-in rules in each tool's own rules format
            // (`.mdc` for Cursor, Kiro's and Qoder's frontmatter, …); a tool
            // without one gets the canonical `.md`.
            const ext = ruleFileExtensionForTool(tool);
            for (const rule of builtinRules) {
                const destFile = path.join(rulesDir, `${rule.name}${ext}`);
                const content = renderRuleForTool(tool, rule.content);
                await writeFile(destFile, content);
                options?.recorder?.report('builtin', destFile);
                log.debug(`Deployed built-in rule ${rule.name} → ${tool}`);

                // Drop the `.md` copy an older layout left in an `.mdc` rules dir.
                if (ext !== '.md') {
                    try {
                        await fs.unlink(path.join(rulesDir, `${rule.name}.md`));
                        log.debug(`Removed legacy .md built-in rule ${rule.name} from ${tool}`);
                    } catch {
                        // File doesn't exist — that's fine
                    }
                }
            }

            // Clean up legacy rules no longer deployed (both extensions)
            for (const legacyName of LEGACY_RULE_NAMES) {
                for (const legacyExt of new Set<string>([ext, '.md'])) {
                    const legacyFile = path.join(rulesDir, `${legacyName}${legacyExt}`);
                    try {
                        await fs.unlink(legacyFile);
                        log.debug(`Removed legacy built-in rule ${legacyName} from ${tool}`);
                    } catch {
                        // File doesn't exist — that's fine
                    }
                }
            }

            deployed++;
        } catch (e) {
            options?.recorder?.failed('builtin');
            options?.toolsMissingRules?.add(tool);
            log.error(`Failed to deploy built-in rules to ${tool}: ${(e as Error).message}`);
        }
    }

    return deployed;
}

// ─── Rule content ──────────────────────────────────────

const TEAMAI_RECALL_RULE_HEADING = '# Team Knowledge Recall (teamai)';

/**
 * SHA-256 of every `teamai-recall` rule body a teamai version deployed under
 * TEAMAI_RECALL_RULE_HEADING, newest first (from `git log origin/main --
 * src/builtin-rules.ts`). The built-ins are not in the delivery ledger, so
 * these hashes are what proves a copy in a Codex legacy rules dir unedited.
 * Add the new hash when either deployed body changes (the historical bilingual
 * text, or the English `language: en` body, #1014): a team `toolPaths` that
 * still names such a dir keeps receiving the current body.
 */
const DEPLOYED_RECALL_RULE_HASHES = new Set<string>([
    '37d1a34f733bfb15e291b08bd17951f2764b91047117d1b2c396e7d01c67c038',
    '9fbe3cc0b5bd39b9418ab2672a38cac831f2d4a3ab31ad539ce4de51d0bcab7f',
    '564b9e8369fbc0009580f0174af119144da6b07ee4e1030f75bc5a03e9c60015',
    '11698b506859049b7dc7ceb7ea149c371ae42dfc0db9a512763d9295f4af480e',
    '37af125211b657cb81d5d3b11ef1c3a1daaa38d3f3323255258033c18ebd03d8',
    '6ef190b7ac41d95357dc3de82791c4cea97203409972a53f6cbae21fe23b4f33',
    'c15adbb1b6d9a96ebe71eed179edbe150ea840505169068af8ae3b79429a83f6',
    '0c9fc1c9c026f5625f42062e8116bc6f8985a6177ecc5ed7328a74159b2ba525',
    '168278feb1a0b5d936497bc8e29cc5652dc472b69ddaba3ee9737fff90bb2c91',
    '1929d8f639410e94315450548ab4a063cce0ace9415e48f0444666d8bc33c680',
    'ed52f7cd1c2baa891e83b285bd5dd1347a2e7b31b613b1b2843fdaea6ff0d140',
]);

/**
 * True when `content` is the `teamai-recall` rule exactly as some teamai
 * version deployed it. A member's edit since the last pull that wrote the
 * file makes it false, so the copy is kept.
 */
export function isDeployedRecallRule(content: string): boolean {
    return DEPLOYED_RECALL_RULE_HASHES.has(crypto.createHash('sha256').update(content).digest('hex'));
}

const TEAMAI_RECALL_RULE_CONTENT = `${TEAMAI_RECALL_RULE_HEADING}

> **Self-exemption (must read first):** If you ARE the \`teamai-recall\` subagent yourself, this rule does NOT apply to you — do not invoke \`teamai-recall\` (or any recall) again. Proceed directly to performing the knowledge search that is your task. This prevents infinite subagent recursion in tools (e.g. Cursor) whose always-apply rules leak into subagent sessions.
>
> **自豁免（务必先读）：** 如果你自己就是 \`teamai-recall\` subagent，本规则对你不适用——不要再调用 \`teamai-recall\`（或任何 recall），直接执行你本职的知识检索任务。此举防止在（如 Cursor 等）会把 always-apply 规则泄漏进 subagent 会话的工具中发生无限递归。

## 规则：任务开始前检索团队知识库（推荐）

**Before** starting a task that involves code changes, debugging,
or design decisions, you **SHOULD** search the team knowledge base
— unless one of the skip conditions below applies.

### 跳过条件（满足任一即可跳过检索）

1. **用户已提供上下文** — 用户在消息中明确引用了文件、给出了解决方案、或说明"答案在当前目录/这个文件里"
2. **本地文件已有答案** — 任务信息可直接从当前工作区文件获得（如修复当前文件中明显的 bug）
3. **简单/局部改动** — 对已知文件做小范围修改（修 typo、调整参数值、改格式），无需额外知识背景

### 方式一：通过 Subagent（推荐，适用于支持 Agent tool 的工具）

调用 \`teamai-recall\` subagent（位于 agents/ 目录），传入任务的自然语言描述。
Subagent 会返回结构化的团队知识摘要（skills、learnings、docs、rules、codebase）。

### 方式二：通过 Bash 命令（适用于所有工具）

\`\`\`bash
teamai recall "<关键词1> <关键词2> ..."
\`\`\`

从任务描述中提取 3-6 个高信号关键词进行检索。

If the output contains \`Nothing was searched:\`, this project's teamai config cannot be
read and no team knowledge was searched: show that line to the user rather than
concluding the team has no knowledge, and do not move the file or run \`teamai init\`
without their consent. If it contains \`Recall skips the older index\`, that scope was not
searched: relay that warning rather than conclude the team has no knowledge there.

**务必中英双语检索（跨语言召回）**：知识库中英文混杂，检索是纯词法匹配，
中文 query 无法命中纯英文文档，反之亦然。因此每个领域术语都应**同时给出中英两种写法**
一起检索，例如「重启推理集群」应扩展为 \`重启 推理 集群 restart inference cluster\`；
只翻译中英确实不同的术语；任何**语言无关的 token**（中英写法相同、或无实际译法者）一律保持原样，
例如专有名词、品牌与产品名、缩写、代码标识符与符号、错误码、版本号、文件路径、命令与 API 名
（\`AppID\`、\`Kubernetes\`、\`GPU\`、\`RuntimeError\`、\`v2.1.3\`、\`oauth\`）——翻译它们只会损害匹配。
`;

const TEAMAI_RECALL_RULE_CONTENT_EN = `${TEAMAI_RECALL_RULE_HEADING}\n\n> **Self-exemption (must read first):** If you ARE the \`teamai-recall\` subagent yourself, this rule does NOT apply to you — do not invoke \`teamai-recall\` (or any recall) again. Proceed directly to performing the knowledge search that is your task. This prevents infinite subagent recursion in tools (e.g. Cursor) whose always-apply rules leak into subagent sessions.

## Rule: search the team knowledge base before a task (recommended)

**Before** starting a task that involves code changes, debugging,
or design decisions, you **SHOULD** search the team knowledge base
— unless one of the skip conditions below applies.

### Skip conditions (any one is enough to skip the search)

1. **The user already provided context** — the message names files, gives a solution, or says the answer is in the current directory or this file
2. **The local files already have the answer** — the task can be done from the current workspace (for example, an obvious bug in the file being edited)
3. **A small or local change** — a narrow edit to a known file (a typo, a parameter value, formatting) that needs no extra background

### Option 1: Subagent (preferred when the tool has an Agent tool)

Call the \`teamai-recall\` subagent (in the agents/ directory) with a natural-language description of the task.
It returns a structured summary of team knowledge (skills, learnings, docs, rules, codebase).

### Option 2: Bash command (works in every tool)

\`\`\`bash
teamai recall "<keyword1> <keyword2> ..."
\`\`\`

Extract 3-6 high-signal keywords from the task description.

If the output contains \`Nothing was searched:\`, this project's teamai config cannot be
read and no team knowledge was searched: show that line to the user rather than
concluding the team has no knowledge, and do not move the file or run \`teamai init\`
without their consent. If it contains \`Recall skips the older index\`, that scope was not
searched: relay that warning rather than conclude the team has no knowledge there.

**Search in both languages (cross-language recall):** the knowledge base mixes English and Chinese, and search is lexical, so a query in one language misses documents written only in the other. Give each domain term in both languages in the same query. Translate only terms whose English and Chinese forms actually differ. Leave every language-independent token unchanged — proper nouns, brand and product names, abbreviations, code identifiers and symbols, error codes, versions, file paths, commands, and API names (\`AppID\`, \`Kubernetes\`, \`GPU\`, \`RuntimeError\`, \`v2.1.3\`, \`oauth\`). Translating those only hurts matching.
`;

/** Recall rule body for `teamai.yaml` `language`. `en` is English only; anything else is the historical bilingual text (#1014). */
export function recallRuleContent(language?: 'en' | 'zh'): string {
    return language === 'en' ? TEAMAI_RECALL_RULE_CONTENT_EN : TEAMAI_RECALL_RULE_CONTENT;
}
