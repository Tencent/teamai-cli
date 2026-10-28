/** The skill `teamai pull` generates for a workflow an agent may start: it routes to the guide and names the workflow. */
import { generatedStartPatterns } from '../drivers/skill/literals.js';
import { markerLines, signGenerated } from './generated-marker.js';
import type { ToolId } from '../../types.js';

export interface AdvertisedWorkflow {
  name: string;
  description: string;
  invoke: 'allow' | 'ask';
  /** Left out when it does not start this workflow: another workflow has it as its name or alias. */
  alias?: string;
}

/** The tools whose skills take `allowed-tools`, so an `invoke: allow` start runs without a permission prompt. */
const PREAPPROVING_TOOLS = new Set<string>(['claude', 'codebuddy'] satisfies ToolId[]);

const DESCRIPTION_LIMIT = 400;

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trim();
}

/** The SKILL.md of `workflow` for `tool`, signed with its marker. */
export function renderWorkflowSkill(workflow: AdvertisedWorkflow, tool: string): string {
  const { name, alias, invoke } = workflow;
  const suffix = `${alias ? ` Alias: ${alias}.` : ''} A team workflow: prefer it over doing the task ad hoc.`;
  const description = `${oneLine(workflow.description, DESCRIPTION_LIMIT - suffix.length)}.${suffix}`;
  const preapproves = PREAPPROVING_TOOLS.has(tool);
  return signGenerated([
    '---',
    `name: workflow-${name}`,
    `description: ${JSON.stringify(description)}`,
    ...(preapproves && invoke === 'allow' ? [`allowed-tools: ${generatedStartPatterns(name, alias).join(', ')}`] : []),
    ...markerLines(name),
    '---',
    `Run \`teamai skill get workflow\` and follow it for the workflow \`${name}\`.`,
    invoke === 'allow'
      ? 'You may start it when the task matches; the person need not confirm.'
      : 'Propose it when the task matches, and start it only after the person says yes: the describe step of the guide asks them.',
    ...(preapproves ? [] : ['Your host may ask the person to approve each command.']),
    '',
  ].join('\n'), name);
}
