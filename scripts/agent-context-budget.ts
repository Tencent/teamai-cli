/**
 * Reports how much text teamai's defaults put in an agent's context, split by when it enters: always, through
 * progressive disclosure, or on a hook event. Report only: CI prints the change against main and never fails on it.
 *
 *   node scripts/agent-context-budget.mjs                       the measured budget as JSON
 *   node scripts/agent-context-budget.mjs --compare <base.json> a Markdown report of the change from base
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { shippedAgentRender } from '../src/builtin-agents.js';
import { recallTexts } from '../src/builtin-rules.js';
import { DefaultWorkflows } from '../src/default-workflows.js';
import { compileDirectRecallRulesBlock, compileRecallRulesBlock } from '../src/pull.js';
import { RESOURCE_LAYOUTS, Resources } from '../src/resources/resolver.js';
import { renderRuleForTool } from '../src/resources/rule-format.js';
import { packagedSkillRoots } from '../src/skill-content.js';
import { parseFrontmatter } from '../src/utils/frontmatter.js';
import { renderWorkflowSkill } from '../src/workflow/discovery/render.js';

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

const PointerSchema = z.object({ name: z.string().default(''), description: z.string().default('') });

/** What a tool lists for a skill or agent before loading it, its name and description, and the body it loads after. */
function pointerAndBody(document: string) {
  const { data, body } = parseFrontmatter(document);
  const { name, description } = PointerSchema.parse(data);

  return { pointer: utf8Bytes(`${name}: ${description}`), body: utf8Bytes(body) };
}

function markdownBytes(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return sum + markdownBytes(full);

    return entry.name.endsWith('.md') ? sum + utf8Bytes(fs.readFileSync(full, 'utf8')) : sum;
  }, 0);
}

// The texts each default hook prints, as default-hooks-golden.test.ts keeps them equal to the code: hook, then case,
// then language. A hook counts at its largest case, in the default language.
const GOLDEN_HINTS = path.join(import.meta.dirname, '..', 'src', '__tests__', 'fixtures', 'default-hooks', 'golden.json');
const GoldenHintsSchema = z.record(z.string(), z.record(z.string(), z.object({ unset: z.string() })));

function hookEventBytes() {
  const golden = GoldenHintsSchema.parse(JSON.parse(fs.readFileSync(GOLDEN_HINTS, 'utf8')));

  return Object.fromEntries(
    Object.entries(golden).map(([hook, cases]) => [
      `${hook}Bytes`,
      Math.max(0, ...Object.values(cases).map((byLanguage) => utf8Bytes(byLanguage.unset))),
    ]),
  );
}

/**
 * The skills pull generates for teamai's default workflows an agent may start (`invoke: allow` or `ask`), rendered by
 * the code pull uses, for Claude Code and without aliases. This is the most it delivers: while `share` is withheld,
 * pull leaves out the workflows that run teamai-share-learnings. A team workflow adds its own.
 */
async function workflowSkillBytes() {
  const defaults = await Resources.list(RESOURCE_LAYOUTS.workflows, { teamai: DefaultWorkflows.layer });
  let pointer = 0;
  let body = 0;

  for (const resolution of defaults) {
    if (resolution.kind !== 'resolved' || resolution.item.layer !== 'teamai') continue;
    const { name, description, invoke } = resolution.item.shipped.definition;

    if (invoke !== 'allow' && invoke !== 'ask') continue;
    const skill = pointerAndBody(renderWorkflowSkill({ name, description, invoke, source: 'default', skill: name }, 'claude'));

    pointer += skill.pointer;
    body += skill.body;
  }

  return { pointer, body };
}

/** Bytes of text teamai's defaults put in a member's agent context, measured from the code that delivers it. */
export async function measureAgentContext() {
  const { rule } = await recallTexts(undefined);
  const skill = pointerAndBody(fs.readFileSync(path.join(packagedSkillRoots().deployRoot, 'teamai', 'SKILL.md'), 'utf8'));
  const agent = pointerAndBody(shippedAgentRender('teamai-recall', 'claude', 'user')?.content ?? '');
  const workflowSkills = await workflowSkillBytes();

  return {
    // In context from the first prompt of every session.
    alwaysLoaded: {
      recallRuleBytes: utf8Bytes(renderRuleForTool('claude', rule)),
      recallBlockBytes: utf8Bytes(await compileRecallRulesBlock(undefined)),
      directRecallBlockBytes: utf8Bytes(await compileDirectRecallRulesBlock(undefined)),
      teamaiSkillPointerBytes: skill.pointer,
      recallAgentPointerBytes: agent.pointer,
      workflowSkillPointerBytes: workflowSkills.pointer,
    },
    // In context only after the agent loads it through a context pointer.
    progressiveDisclosure: {
      teamaiSkillBodyBytes: skill.body,
      recallAgentBodyBytes: agent.body,
      workflowSkillBodyBytes: workflowSkills.body,
      skillDataBytes: markdownBytes(packagedSkillRoots().dataRoot),
    },
    // In context when the hook's event fires.
    onHookEvent: hookEventBytes(),
  };
}

const BudgetSchema = z.record(z.string(), z.record(z.string(), z.number()));

type Budget = z.infer<typeof BudgetSchema>;

const GROUP_LABELS: Record<keyof Awaited<ReturnType<typeof measureAgentContext>>, string> = {
  alwaysLoaded: 'Always loaded, in every session',
  progressiveDisclosure: 'Through progressive disclosure',
  onHookEvent: 'On hook events, largest hint each',
};

/** `recallRuleBytes` reads as "Recall rule"; a hook key keeps its hook name. */
function textLabel(key: string): string {
  const words = key.replace(/Bytes$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

  return words.startsWith('teamai') ? words : words.charAt(0).toUpperCase() + words.slice(1);
}

function groupLabel(group: string): string {
  return Object.entries(GROUP_LABELS).find(([known]) => known === group)?.[1] ?? textLabel(group);
}

const bytes = (value: number | undefined): string => (value === undefined ? '—' : value.toLocaleString('en-US'));

function change(before: number, after: number, percent: boolean): string {
  const delta = after - before;

  if (delta === 0) return '0';
  const signed = `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString('en-US')}`;
  const ratio = Math.abs(delta) / before * 100;
  const share = percent && before > 0 ? ` (${ratio < 0.1 ? '<0.1' : `${delta > 0 ? '+' : '−'}${ratio.toFixed(1)}`}%)` : '';

  return delta > 0 ? `**${signed}${share}**` : `${signed}${share}`;
}

/** A Markdown report of the change from `base`, and a warning when always-loaded text grew. */
export function compareAgentContext(head: Budget, base: Budget) {
  const totals: string[] = [];
  const changed: string[] = [];
  const all: string[] = [];
  const grewAlways: string[] = [];
  let alwaysDelta = 0;

  for (const group of new Set([...Object.keys(base), ...Object.keys(head)])) {
    let before = 0;
    let after = 0;

    for (const key of new Set([...Object.keys(base[group] ?? {}), ...Object.keys(head[group] ?? {})])) {
      const was = base[group]?.[key];
      const now = head[group]?.[key];
      const row = `| ${textLabel(key)} | ${bytes(was)} | ${bytes(now)} | ${change(was ?? 0, now ?? 0, false)} |`;

      before += was ?? 0;
      after += now ?? 0;
      all.push(row);

      if (was === now) continue;
      changed.push(row);

      if (group === 'alwaysLoaded' && (now ?? 0) > (was ?? 0)) grewAlways.push(textLabel(key));
    }

    if (group === 'alwaysLoaded') alwaysDelta = after - before;
    totals.push(`| ${groupLabel(group)} | ${bytes(before)} B | ${bytes(after)} B | ${change(before, after, true)} |`);
  }

  const header = (first: string) => [`| ${first} | main | this PR | Change |`, '| --- | ---: | ---: | ---: |'];

  const warning = alwaysDelta > 0
    ? `Always-loaded agent context grew by ${alwaysDelta.toLocaleString('en-US')} B (${grewAlways.join(', ')}). Say why in the PR.`
    : undefined;

  const markdown = changed.length === 0
    ? '### Agent context against main\n\nAgent context is unchanged from main.'
    : [
        '### Agent context against main',
        '',
        ...header('When it loads'),
        ...totals,
        '',
        ...(warning === undefined ? [] : ['Always loaded grew. Say why in the PR.', '']),
        ...header('Text that changed'),
        ...changed,
        '',
        `<details><summary>All ${all.length} texts</summary>`,
        '',
        ...header('Text'),
        ...all,
        '',
        '</details>',
      ].join('\n');

  return { markdown, warning };
}

const [flag, baseFile] = process.argv.slice(2);
const measured = BudgetSchema.parse(await measureAgentContext());

if (flag === '--compare' && baseFile) {
  const { markdown, warning } = compareAgentContext(measured, BudgetSchema.parse(JSON.parse(fs.readFileSync(baseFile, 'utf8'))));

  console.log(markdown);

  if (warning !== undefined) console.error(warning);
} else {
  console.log(JSON.stringify(measured, null, 2));
}
