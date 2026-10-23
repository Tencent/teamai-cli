import type { LocalConfig } from '../types.js';
import { listCachedWorkflows } from './cache.js';

export const WORKFLOW_HINT_LIMIT = 2400;

/** Metadata only: the session never receives the workflow graph or command bodies. */
export async function workflowHint(config: LocalConfig): Promise<string | null> {
  const cached = await listCachedWorkflows(config);
  const advertised = cached.filter(({ definition }) => definition.invocable === true);
  if (!advertised.length) return null;
  const names = new Set(cached.map(({ definition }) => definition.name));
  const aliases = new Map<string, number>();
  for (const { definition } of cached) if (definition.alias) aliases.set(definition.alias, (aliases.get(definition.alias) ?? 0) + 1);
  const lines = ['Team workflows. For a requested task, read `teamai skill get workflow`; inspect inputs with `teamai workflow start <name> --describe`.'];
  for (const { definition } of advertised) {
    const alias = definition.alias && definition.alias.length <= 64 && !names.has(definition.alias) && aliases.get(definition.alias) === 1
      ? ` (alias ${definition.alias})` : '';
    const title = `${definition.name}${alias}: `;
    const description = definition.description.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    const line = title + description.slice(0, Math.max(0, 400 - title.length));
    if (lines.join('\n').length + line.length + 1 > WORKFLOW_HINT_LIMIT) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join('\n') : null;
}
