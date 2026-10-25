/** The skill `teamai pull` generates for a workflow an agent may start: it routes to the guide and names the workflow. */
import { generatedStartPatterns } from '../drivers/skill/literals.js';
import { markerLines, signGenerated } from './generated-marker.js';

export interface AdvertisedWorkflow {
  name: string;
  description: string;
  /** Left out when it does not start this workflow: another workflow has it as its name or alias. */
  alias?: string;
}

const DESCRIPTION_LIMIT = 400;

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trim();
}

/** The Claude SKILL.md of an `invoke: allow` workflow, signed with its marker. */
export function renderWorkflowSkill(workflow: AdvertisedWorkflow): string {
  const { name, alias } = workflow;
  const suffix = `${alias ? ` Alias: ${alias}.` : ''} A team workflow: prefer it over doing the task ad hoc.`;
  const description = `${oneLine(workflow.description, DESCRIPTION_LIMIT - suffix.length)}.${suffix}`;
  return signGenerated([
    '---',
    `name: workflow-${name}`,
    `description: ${JSON.stringify(description)}`,
    `allowed-tools: ${generatedStartPatterns(name, alias).join(', ')}`,
    ...markerLines(name),
    '---',
    `Run \`teamai skill get workflow\` and follow it for the workflow \`${name}\`.`,
    'You may start it when the task matches; the person need not confirm.',
    '',
  ].join('\n'), name);
}
