/**
 * The team workflow an arm's trials run on each task, pinned for a plan: read at the arm's team revision with every
 * workflow it runs by name, refused when a trial could not run it unattended in its clone, and copied as workflow files
 * whose prompts all run on the arm's tool, model and effort. Each copy is keyed `<name>.<12 hex>` by a hash of the copy,
 * so two arms that run one workflow on different tools get two copies, and a copy runs the keys of its sub-workflows.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { getKnowledgeDir, type LocalConfig } from '../types.js';
import { loadCachedWorkflow, loadWorkflowTree, syncWorkflowDefinitions, withTeamRevision, workflowsRunBy, type SyncWorkflowResult } from '../workflow/cache.js';
import { parseWorkflow } from '../workflow/parse.js';
import { stepWorkflow, type InlineWorkflow, type WorkflowStep } from '../workflow/types.js';
import type { PlannedArm } from './plan.js';

/** An arm's workflow as the plan pins it: the workflow and its sub-workflows, as copies keyed for a bundle. */
export interface PinnedArmWorkflow {
  name: string;
  /** Over the sources of the workflow and every workflow it runs, as the team revision stores them. */
  sourceHash: string;
  /** The key of the copy a trial runs. */
  key: string;
  /** Every copy, the workflow's and its sub-workflows', by key, as workflow files write them. */
  files: Record<string, Record<string, unknown>>;
}

const FileSchema = z.object({ steps: z.array(z.record(z.string(), z.unknown())) }).passthrough();
type FileStep = Record<string, unknown>;

/** Why plan refuses an arm's workflow: the member receives two versions of a workflow it runs, or a trial cannot run it. */
type Refusal = { ok: false; code: 'workflow_namespace_conflict' | 'arm_workflow_unrunnable'; message: string };

/**
 * Workflow `name` of `arm` at team commit `revision`, pinned with its copies; or why a trial could not run it. The
 * workflow and every workflow it runs by name resolve as any team workflow does for this member, through the namespaces
 * the member receives. Refused when two of those namespaces define one of them, when it has no runnable version there,
 * takes no input `task`, or a step of it, or of a workflow it runs, delivers, asks a person, or works outside the
 * trial's clone.
 */
export async function pinArmWorkflow(
  config: LocalConfig, { arm, name, revision, unattended }: { arm: PlannedArm; name: string; revision: string; unattended: boolean },
): Promise<{ ok: true; pinned: PinnedArmWorkflow } | Refusal> {
  const runs = `Arm "${arm.name}" runs workflow "${name}"`;
  const refuse = (message: string, code: Refusal['code'] = 'arm_workflow_unrunnable'): Refusal => ({ ok: false, code, message });
  const read = await withTeamRevision(config, revision, async (at) => {
    const synced = await syncWorkflowDefinitions(at, { scopeLabel: `team commit ${revision.slice(0, 7)}` });
    const conflicted = await namespaceConflict(at, name, synced);
    if (conflicted) {
      const through = conflicted.workflow === name ? '' : `, which runs workflow "${conflicted.workflow}"`;
      return { conflict: `${runs}${through}, which this member receives from more than one namespace: ${conflicted.message}` };
    }
    const top = await loadCachedWorkflow(at, name);
    if (!top) return { missing: `${runs}, which has no runnable version at team commit ${revision.slice(0, 7)}` };
    const tree = await loadWorkflowTree(at, top);
    if ('failed' in tree) return { missing: `${runs}, which cannot run: ${tree.failed.message}` };
    const children = await Promise.all(Object.keys(tree.workflows).map(async (child) => [child, await loadCachedWorkflow(at, child)] as const));
    return { top, tree, children };
  });
  if ('failed' in read) return refuse(`${runs}, and team commit ${revision.slice(0, 7)} could not be read: ${read.failed}. Repair the team repo, or run teamai pull, and start again.`);
  if ('conflict' in read) return refuse(`${read.conflict}. Keep it in one namespace, push it, run teamai pull, and start again.`, 'workflow_namespace_conflict');
  if ('missing' in read) return refuse(`${read.missing}. Fix the arm's workflow, push it, run teamai pull, and start again.`);
  const { top, tree, children } = read;
  if (top.definition.inputs?.task?.type !== 'string') {
    return refuse(`${runs}, which takes no input task, the task's prompt each trial passes it. Add inputs: { task: string } to it, push it, run teamai pull, and start again.`);
  }
  // Every input is required, and a trial passes only task.
  const otherInputs = Object.keys(top.definition.inputs).filter((input) => input !== 'task');
  if (otherInputs.length > 0) {
    return refuse(`${runs}, which also requires inputs ${otherInputs.join(', ')}, and a trial passes only task. Remove them from its inputs, push it, run teamai pull, and start again.`);
  }
  // A trial runs it by name, and only a run of a workflow runs its finally steps.
  if (top.definition.finally) {
    return refuse(`${runs}, which has finally steps, and a trial runs it as a step, where they would not run. Move them into its steps, push it, run teamai pull, and start again.`);
  }
  const sources = new Map([[top.definition.name, top], ...children.flatMap(([child, cached]) => (cached ? [[child, cached] as const] : []))]);
  for (const [file, cached] of sources) {
    const refused = unrunnableStep(cached.definition.steps);
    if (refused !== undefined) {
      const holder = file === top.definition.name ? '' : `, which runs workflow "${file}"`;
      return refuse(`${runs}${holder}, whose step "${refused.step}" ${refused.why}. A trial runs unattended in its own clone: change the workflow, push it, run teamai pull, and start again.`);
    }
  }
  // With no model, the arm runs on its tool's default, which the model an agent's definition sets would replace.
  for (const [file, cached] of arm.model === undefined ? sources : []) {
    const found = agentPrompt(cached.definition.steps);
    if (found !== undefined) {
      const holder = file === top.definition.name ? '' : `, which runs workflow "${file}"`;
      return refuse(`${runs}${holder}, whose step "${found.step}" runs agent "${found.agent}", and the arm sets no model, so the agent's own model could replace the tool's default it compares. Set model in the suite's defaults, which the arm inherits, and start again.`);
    }
  }
  const raws = new Map<string, { raw: z.infer<typeof FileSchema>; parsed: readonly WorkflowStep[] }>();
  for (const [file, cached] of sources) {
    const raw = FileSchema.safeParse(cached.content === undefined ? undefined : parse(cached.content));
    if (!raw.success) return refuse(`${runs}, and this member's cache holds no source of workflows/${file}.yaml to copy. Run teamai pull, and start again.`);
    raws.set(file, { raw: raw.data, parsed: cached.definition.steps });
  }
  const files: Record<string, Record<string, unknown>> = {};
  const keys = new Map<string, string>();
  // Sub-workflows first, so a copy names the keys of the copies it runs; the tree has no cycle, and holds every file.
  const keyOf = (file: string): string => {
    const known = keys.get(file);
    const source = raws.get(file);
    if (known !== undefined || !source) return known ?? file;
    const { name: _name, defaults, ...header } = source.raw;
    const { model: _model, ...keptDefaults } = z.record(z.string(), z.unknown()).catch({}).parse(defaults ?? {});
    const body = { ...header, ...(Object.keys(keptDefaults).length > 0 ? { defaults: keptDefaults } : {}), steps: copySteps(source.raw.steps, source.parsed, { arm, unattended }, keyOf) };
    const key = `${file}.${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)}`;
    files[key] = { ...body, name: key };
    keys.set(file, key);
    return key;
  };
  return { ok: true, pinned: { name, sourceHash: tree.sourceHash, key: keyOf(top.definition.name), files } };
}

/**
 * The first workflow `name` runs, itself included, that has no runnable version because two namespaces the member
 * receives define it, with the diagnostic the sync gave it. Walked through the versions `config`'s cache holds, and
 * through the files the sync left unrunnable, `synced.unrunnable`, since a workflow that runs a conflicting one is one.
 */
async function namespaceConflict(config: LocalConfig, name: string, synced: Pick<SyncWorkflowResult, 'invalid' | 'unrunnable'>, seen = new Set<string>()): Promise<{ workflow: string; message: string } | undefined> {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const conflict = synced.invalid.find((diagnostic) => diagnostic.code === 'workflow_namespace_conflict' && path.posix.basename(diagnostic.file, '.yaml') === name);
  if (conflict) return { workflow: name, message: conflict.message };
  const cached = await loadCachedWorkflow(config, name);
  const unrunnable = cached ? undefined : synced.unrunnable.find((file) => path.posix.basename(file, '.yaml') === name);
  const content = unrunnable === undefined ? undefined : await fs.readFile(path.join(getKnowledgeDir(config), unrunnable), 'utf8').catch(() => undefined);
  const parsed = content === undefined ? undefined : parseWorkflow(unrunnable ?? '', content);
  const definition = cached?.definition ?? (parsed?.ok ? parsed.definition : undefined);
  for (const { workflow } of definition ? workflowsRunBy(definition) : []) {
    const found = await namespaceConflict(config, workflow, synced, seen);
    if (found) return found;
  }
  return undefined;
}

/** The first step of `steps`, inline workflows included, that a trial cannot run, and why. */
function unrunnableStep(steps: readonly WorkflowStep[], prefix = ''): { step: string; why: string } | undefined {
  for (const step of steps) {
    const id = `${prefix}${step.id}`;
    if (step.deliver !== undefined) return { step: id, why: 'delivers a pull request' };
    if (step.hitl !== undefined || step.interactive === true) return { step: id, why: 'asks a person' };
    if (step.workspace !== undefined && step.workspace !== 'continue') return { step: id, why: 'opens a workspace other than continue' };
    if (step.command !== undefined && step.workspace === undefined) return { step: id, why: 'runs a command in the member\'s checkout; give it workspace: continue' };
    const child = stepWorkflow(step);
    // A trial runs the arm's workflow from the benchmark plan's output, which may run no `from` step.
    if (child?.kind === 'from') return { step: id, why: `runs a workflow step "${child.step}" makes, which a trial cannot run` };
    const inner = child?.kind === 'inline' ? unrunnableStep(child.workflow.steps, `${id}.`) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** The first prompt step of `steps`, inline workflows included, that runs an agent, and the agent. */
function agentPrompt(steps: readonly WorkflowStep[], prefix = ''): { step: string; agent: string } | undefined {
  for (const step of steps) {
    const id = `${prefix}${step.id}`;
    if (step.prompt !== undefined && step.agent !== undefined) return { step: id, agent: step.agent };
    const child = stepWorkflow(step);
    const inner = child?.kind === 'inline' ? agentPrompt(child.workflow.steps, `${id}.`) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** What every prompt of an arm's workflow copy runs as: the arm's tool, model and effort, and unattended in a strict sandbox. */
interface CopiedPrompt {
  arm: PlannedArm;
  unattended: boolean;
}

/**
 * `raw`, the steps as the file writes them, with every prompt run as `prompts` says and its prompt file's text inline,
 * and every workflow it runs by name run by its copy's key. `parsed` are the same steps as the cache holds them, in the
 * same order.
 */
function copySteps(raw: readonly FileStep[], parsed: readonly WorkflowStep[], prompts: CopiedPrompt, keyOf: (file: string) => string): FileStep[] {
  const { arm, unattended } = prompts;
  return raw.map((step, index) => {
    const definition = parsed[index];
    if (!definition) return step;
    if (definition.prompt !== undefined) {
      const { prompt_file: _file, model: _model, ...rest } = step;
      const { permissions: _permissions, ...written } = rest;
      return {
        ...written, prompt: definition.prompt, tool: arm.tool, ...(arm.model ? { model: { name: arm.model, ...(arm.effort ? { effort: arm.effort } : {}) } } : {}),
        ...(unattended ? { permissions: 'unattended' } : {}),
      };
    }
    const child = stepWorkflow(definition);
    if (child?.kind === 'named') return { ...step, workflow: keyOf(child.name) };
    if (child?.kind === 'inline') return { ...step, workflow: copyInline(step.workflow, child.workflow, prompts, keyOf) };
    return step;
  });
}

function copyInline(raw: unknown, parsed: InlineWorkflow, prompts: CopiedPrompt, keyOf: (file: string) => string): unknown {
  const file = FileSchema.safeParse(raw);
  return file.success ? { ...file.data, steps: copySteps(file.data.steps, parsed.steps, prompts, keyOf) } : raw;
}
