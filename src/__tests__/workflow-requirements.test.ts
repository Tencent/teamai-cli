import { describe, expect, it } from 'vitest';
import { DefaultWorkflows } from '../default-workflows.js';
import { RESOURCE_LAYOUTS, Resources } from '../resources/resolver.js';
import { parseWorkflow } from '../workflow/parse.js';
import { envAdvice, isPinnedToHost, mergeRequirements, negotiate, type DriverCan, type Executor, type InEffect, type Offer } from '../workflow/requirements.js';
import { stepWorkflow, type WorkflowDefinition, type WorkflowStep } from '../workflow/types.js';

describe('envAdvice', () => {
  it('offers env set alone for a key the team declares', () => {
    expect(envAdvice(['SIGNING_KEY'], new Set(['SIGNING_KEY'])))
      .toBe('run teamai env set SIGNING_KEY, or set it in the environment');
  });

  it('names the declare step and the value step for a key the team does not declare', () => {
    expect(envAdvice(['SIGNING_KEY'], new Set()))
      .toBe('set SIGNING_KEY in the environment, or declare it in the team repo with teamai env add SIGNING_KEY --secret and give it a value with teamai env set SIGNING_KEY');
  });

  it('keeps a mixed list to both remedies, each for its own keys', () => {
    expect(envAdvice(['SIGNING_KEY', 'API_TOKEN'], new Set(['SIGNING_KEY'])))
      .toBe('run teamai env set SIGNING_KEY, or set it in the environment; set API_TOKEN in the environment, or declare it in the team repo with teamai env add API_TOKEN --secret and give it a value with teamai env set API_TOKEN');
  });
});

describe('requires.host', () => {
  const flow = (requires: string): ReturnType<typeof parseWorkflow> => parseWorkflow('.teamai/workflows/pinned.yaml', `schemaVersion: v1alpha1
name: pinned
description: pinned
steps:
  - id: build
    command: make
    requires: ${requires}
`);

  it('parses as a step requirement, and refuses any value but true', () => {
    const parsed = flow('{ host: true }');
    expect(parsed.ok && parsed.definition.steps[0]?.requires).toEqual({ host: true });

    const refused = flow('{ host: false }');
    expect(!refused.ok && refused.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(['steps[0].requires.host']);
  });

  it('holds from every level below it, as defaults.requires does for every step', () => {
    expect(mergeRequirements({ host: true }, { env: ['TOKEN'] })).toEqual({ host: true, env: ['TOKEN'] });
    expect(mergeRequirements({ env: ['TOKEN'] })).toEqual({ env: ['TOKEN'] });
  });

  it('pins a step to this host, on top of the pins teamai derives', () => {
    const step = { step: {}, executor: 'command' as const, inShippedWorkflow: false };
    expect(isPinnedToHost({ ...step, requires: {} })).toBe(false);
    expect(isPinnedToHost({ ...step, requires: { host: true } })).toBe(true);
    expect(isPinnedToHost({ ...step, executor: 'prompt', requires: { host: true } })).toBe(true);
    // The derived pin stays a floor: a shipped command step that forgets the key is still pinned.
    expect(isPinnedToHost({ ...step, inShippedWorkflow: true, requires: {} })).toBe(true);
  });

  const offer = (requires: InEffect, executor: Offer['executor']): Offer => ({
    step: 'build', executor, requires, interactive: false, hasContract: false, envKeys: [], runEnvKeys: new Set(), budgeted: false,
    unattended: false, clone: false, prepare: false, tool: executor === 'prompt' ? 'claude' : undefined,
  });
  const env = { declared: new Set<string>(), secrets: new Set<string>(), present: new Set<string>() };
  const remote: DriverCan = { exec: true, tools: ['claude'], remote: true };
  const here: DriverCan = { exec: true, tools: ['claude'] };

  it.each(['command', 'prompt'] as const)('holds a %s step that requires the host from a runtime off this machine, and grants it here', (executor) => {
    expect(negotiate(offer({ host: true }, executor), remote, {}, env)).toEqual({ kind: 'hold', missing: ['host'] });
    expect(negotiate(offer({ host: true }, executor), here, {}, env)).toMatchObject({ kind: 'grant' });
  });
});

describe('the workflows teamai ships', () => {
  type Shipped = WorkflowDefinition;
  type Reached = { path: string; step: WorkflowStep; requires: InEffect };

  const shippedWorkflows = async (): Promise<Shipped[]> => (await Resources.list(RESOURCE_LAYOUTS.workflows, { teamai: DefaultWorkflows.layer }))
    .flatMap((found) => (found.kind === 'resolved' && found.item.layer === 'teamai' ? [found.item.shipped.definition] : []));

  /**
   * Every step `root` reaches, with the requirements in effect on it on that route, as the engine's scopes merge them:
   * the steps around it, the step that runs a workflow file by name, then that file's `defaults.requires`.
   */
  const reached = (root: Shipped, byName: ReadonlyMap<string, Shipped>): Reached[] => {
    const visit = (steps: readonly WorkflowStep[], around: InEffect, prefix: string, seen: ReadonlySet<string>): Reached[] => steps.flatMap((step) => {
      const requires = mergeRequirements(around, step.requires);
      const path = `${prefix}${step.id}`;
      const child = stepWorkflow(step);
      const named = child?.kind === 'named' && !seen.has(child.name) ? byName.get(child.name) : undefined;
      const inner = child?.kind === 'inline' ? visit(child.workflow.steps, requires, `${path}.`, seen)
        : named ? visit([...named.steps, ...named.finally ?? []], mergeRequirements(requires, named.defaults?.requires), `${path}>${named.name}:`, new Set([...seen, named.name])) : [];

      return [{ path, step, requires }, ...inner];
    });

    return visit([...root.steps, ...root.finally ?? []], mergeRequirements(root.defaults?.requires), `${root.name}:`, new Set([root.name]));
  };

  /** Whether a step is meant to move off this machine: it runs in a sandbox, or it is the judge of teamai-score. */
  const movable = ({ path, requires }: Reached): boolean => requires.isolation === 'sandbox' || /(?:^|>)teamai-score:score\.judge$/.test(path);
  const executorOf = (step: WorkflowStep): Executor => (step.command !== undefined ? 'command' : 'prompt');

  /** The steps meant to move that some route still pins to this machine. */
  const pinnedMovable = (roots: readonly Shipped[], byName: ReadonlyMap<string, Shipped>): string[] => roots.flatMap((root) => reached(root, byName))
    .filter((at) => movable(at) && (at.requires.host === true || isPinnedToHost({ step: at.step, executor: executorOf(at.step), inShippedWorkflow: false, requires: at.requires })))
    .map((at) => at.path);

  it('pin no step meant to move, a sandboxed step or the judge of teamai-score, by any route', async () => {
    const shipped = await shippedWorkflows();
    const byName = new Map(shipped.map((definition) => [definition.name, definition]));

    expect(shipped.length).toBeGreaterThan(0);
    expect(pinnedMovable(shipped, byName)).toEqual([]);
  });

  it('would pin the sandboxed trials of teamai-benchmark if its file pinned every step, which a sandbox runtime could then never take', async () => {
    const shipped = await shippedWorkflows();
    const benchmark = shipped.find((definition) => definition.name === 'teamai-benchmark');
    if (!benchmark) throw new Error('teamai-benchmark is not shipped');
    const pinnedFile: Shipped = { ...benchmark, defaults: { ...benchmark.defaults, requires: { ...benchmark.defaults?.requires, host: true } } };
    const byName = new Map(shipped.map((definition) => [definition.name, definition]));
    const trials = reached(pinnedFile, byName).find((at) => at.path === 'teamai-benchmark:trials');

    expect(pinnedMovable([pinnedFile], byName)).toContain('teamai-benchmark:trials');
    expect(trials?.requires).toMatchObject({ host: true, isolation: 'sandbox' });
  });

  it('pin every command step, by the file\'s defaults.requires where every step it reaches belongs here and it runs no workflow by name, a team may replace that file, and by the step\'s own key otherwise, so a team copy under another name keeps the pin teamai derives by name', async () => {
    const shipped = await shippedWorkflows();
    /** The steps written in `definition` itself, inline workflows included and files it runs by name left out. */
    const ownSteps = (definition: Shipped): Reached[] => reached(definition, new Map());
    const shape = shipped.map((definition) => {
      const own = ownSteps(definition);
      const wholeHere = !own.some((at) => {
        const child = stepWorkflow(at.step);

        return movable(at) || child?.kind === 'named' || child?.kind === 'from';
      });
      const declared = own.filter((at) => at.step.requires?.host === true).map((at) => at.path);

      return { file: definition.name, wholeHere, fileDefault: definition.defaults?.requires?.host === true, declared };
    });
    const unpinned = shipped.flatMap(ownSteps).filter((at) => at.step.command !== undefined && at.requires.host !== true).map((at) => at.path);

    expect(unpinned).toEqual([]);
    expect(shape.filter((file) => file.wholeHere && (!file.fileDefault || file.declared.length > 0)).map(({ file, declared }) => ({ file, declared }))).toEqual([]);
    expect(shape.filter((file) => !file.wholeHere && file.fileDefault).map((file) => file.file)).toEqual([]);
  });
});
