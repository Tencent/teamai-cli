import path from 'node:path';
import { ensureDir, writeFile, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { ResourceHandler } from './resources/base.js';
import type { TeamaiConfig } from './types.js';

// ─── Built-in rules deployment ──────────────────────────
//
//  CLI ships with built-in rules that guide AI tool behavior.
//  Unlike team repo rules (managed by users), these are
//  maintained alongside the CLI code and deployed automatically
//  on each `teamai pull`.
//
//  Built-in rules are generated in-memory (no external files).
//  On each `teamai pull` / `teamai init`:
//    → ~/.claude/rules/teamai-recall.md
//    → ~/.claude-internal/rules/teamai-recall.md
//    → ~/.cursor/rules/teamai-recall.md
//    → ...
//

/** Names of CLI built-in rules. Used by push to exclude them from team repo push. */
export const BUILTIN_RULE_NAMES = new Set(['teamai-recall']);

/**
 * Generate the content of the teamai-recall rule.
 *
 * This rule instructs AI tools to search team learnings
 * before tackling problems that teammates may have solved before.
 */
function generateRecallRule(): string {
    return `# Team Knowledge Auto-Recall

When you encounter errors, bugs, deployment issues, or unfamiliar patterns during this session, **search the team knowledge base first** before attempting to solve from scratch.

## How to Search

Run the following command via Bash:

\`\`\`bash
teamai recall "<search query>"
\`\`\`

## When to Search

- Encountering an error message or stack trace
- Debugging deployment or infrastructure issues
- Working with unfamiliar APIs, services, or configurations
- Before implementing a workaround for a known problem area

## How to Use Results

- Results are ranked by relevance (title ×3, tags ×2, body ×1) plus team votes
- Use the \`Read\` tool to read the full document at the path shown in results
- Apply the solution or pattern described, adapting to your current context
- If no results are found, proceed normally — the knowledge base is still growing

## Example

\`\`\`bash
teamai recall "API timeout retry"
teamai recall "K8s OOM pod restart"
teamai recall "SGLang deployment"
\`\`\`
`;
}

/**
 * Deploy CLI built-in rules to all configured AI tool rules directories.
 *
 * Writes each built-in rule to every tool's rules/ path defined in teamai.yaml.
 * Skips tools whose rules directory does not exist (tool not installed).
 *
 * @returns Number of tool directories that received built-in rules.
 */
export async function deployBuiltinRules(teamConfig: TeamaiConfig): Promise<number> {
    const home = process.env.HOME ?? '';
    let deployed = 0;

    const builtinRules = [
        { name: 'teamai-recall', content: generateRecallRule() },
    ];

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
        if (!toolPath.rules) continue;

        // Skip tools that are not installed
        if (!await ResourceHandler.isToolInstalled(toolPath.rules)) {
            log.debug(`Skipping built-in rules for ${tool}: tool not installed`);
            continue;
        }

        const rulesDir = path.join(home, toolPath.rules);
        if (!await pathExists(rulesDir)) continue;

        try {
            await ensureDir(rulesDir);

            for (const rule of builtinRules) {
                const destFile = path.join(rulesDir, `${rule.name}.md`);
                await writeFile(destFile, rule.content);
                log.debug(`Deployed built-in rule ${rule.name} → ${tool}`);
            }

            deployed++;
        } catch (e) {
            log.error(`Failed to deploy built-in rules to ${tool}: ${(e as Error).message}`);
        }
    }

    return deployed;
}
