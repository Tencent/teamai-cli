/** @import { Context, ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import path from 'node:path';
import { importVisitors, reachesSource, sourceImport } from '../imports.js';
import { lintedPath } from '../utils.js';

const SKILL = 'src/workflow/drivers/skill/';
const LOCAL = 'src/workflow/drivers/local/';
const PLACE = 'src/workflow/place/';
const DISCOVERY = 'src/workflow/discovery/';
const BENCHMARK = 'src/benchmark/';
const SCORERS = 'src/scorers/';
const FLAT = 'src/workflow/';

/** Rule 1: what a module under `drivers/skill/` may import, besides its siblings, `zod` and `node:*`. */
/** @type {Record<string, { typeOnly?: true; names?: string[]; values?: string[] }>} */
const SKILL_IMPORTS = {
  'src/workflow/protocol.ts': {},
  // Whether only a person answers a gate, the one rule the engine and the offers apply too.
  'src/workflow/types.ts': { typeOnly: true, values: ['onlyPersonAnswers'] },
  // The declared env facts, and the advice a missing key gets, which the preflight prints before a start.
  'src/workflow/requirements.ts': { typeOnly: true, values: ['envAdvice'] },
  'src/workflow/describe.ts': { typeOnly: true },
  // What a driver nobody attends says once it offered a run to a person, as the local driver logs it.
  'src/workflow/handoff.ts': { names: ['offeredToPerson'] },
  'src/workflow/attempt-marker.ts': {},
  // The wire shapes the engine answers with, which every driver parses with the same schema.
  'src/workflow/lease-wire.ts': { names: ['LeaseWireSchema', 'ConfinedLease'] },
  'src/workflow/step-state.ts': { names: ['FailureSchema', 'ConfinedRunReportSchema', 'TokenUsageSchema'] },
  // A step confined to a directory, which the background runner runs as the local driver does.
  'src/workflow/confined-step.ts': { names: ['runConfinedStep', 'ConfinedStepEnd', 'ConfinedStepLease'] },
  // An attempt's result file, which the driver masks once a child wrote it, as the local driver does once a tool did.
  'src/workflow/attempt-result.ts': { names: ['AttemptResult'] },
  // What a prompt step's output must be, as every driver's result instruction says it.
  'src/workflow/output.ts': { names: ['expectedOutput'] },
  'src/workflow/store.ts': { names: ['takeRunLock', 'LockTaken', 'RunLock', 'attemptDir', 'attemptResultPath', 'skillStatePath', 'runsDir', 'RunIdSchema', 'RunId', 'AttemptIdSchema', 'AttemptId', 'withRunnerLock', 'runnerAlive'] },
  'src/workflow/step-model.ts': {},
  'src/env-resolution.ts': {},
  'src/env-exec.ts': { names: ['stepEnvironment', 'withRunningCli'] },
  '@teamai/shared/redact': {},
  'src/utils/session-id.ts': {},
  // Equal values as equal text, so a kept end is compared with the engine's latest one.
  'src/utils/canonical-json.ts': {},
  'src/resources/agent-format.ts': {},
  'src/tool-launch/process-stop.ts': {},
  // Whether the local driver launches the session's tool, so a local start or resume can name it.
  'src/tool-launch/tools.ts': { names: ['isLaunchTool', 'LAUNCH_ORDER', 'LaunchTool'] },
  'src/builtin-hooks.ts': { names: ['resolveCliEntry'] },
  // The tools a session may name with `--tools default=<tool>`, a shipped tool or an instance of one, which of them a
  // child's model resolves for and a local run launches, and the skill-data root the host question's reference is under.
  'src/tool-registry.ts': { names: ['isToolId', 'TOOL_ORDER', 'toolOf', 'toolInstancesFor', 'agentFormatOf', 'baseToolOf'] },
  'src/skill-content.ts': { names: ['packagedSkillRoots'] },
  // The confined tools of this machine, what each can do there, and the level the session's tool reaches here.
  'src/tool-launch/confined.ts': { names: ['isConfinedTool', 'confinedAccess', 'confinedToolLevel'] },
  // The level a confined run reaches.
  'src/tool-launch/confined-level.ts': { typeOnly: true },
  // What describe proposes for the inputs of a workflow, for the calling session, without the driver naming one.
  'src/workflow-offers.ts': { names: ['WorkflowOffers'] },
  // What a teamai-score run the session drives gave each scorer, read from its outputs by the module that owns their shape.
  'src/scorers/engine-hooks.ts': { names: ['scoredLabels', 'ScoredLabels'] },
  // The identity every driver reports, the repository's atomic file writes, and the shared config types.
  'src/driver-identity.ts': {},
  // The run mode: whether a person attends the run, which describe answers for and every attempt's process gets.
  'src/launch-context.ts': { names: ['resolveRunMode', 'RunMode', 'RUN_MODES', 'RunModeSchema'] },
  'src/utils/fs.ts': {},
  'src/types.ts': { typeOnly: true },
};

/** Rule 3: the modules through which code outside a folder reaches it; tests may also import the entries of their unit. */
/** @type {Array<{ folder: string; entries: Record<string, string[] | 'any'>; testEntries: string[] }>} */
const ENTRIES = [
  { folder: SKILL, entries: { 'skill-driver.ts': 'any', 'literals.ts': ['src/workflow/discovery/render.ts'] }, testEntries: ['skill-driver.ts', 'literals.ts'] },
  {
    folder: PLACE,
    // engine.ts stages, before it saves a run, the evidence a step that settled there left in its clone.
    // index.ts moves the home of a command a step started in its clone to that clone's own install.
    // check-run.ts clones and sets up the commit a check runs on, for a benchmark and a scorer alike.
    entries: { 'place.ts': ['src/index.ts', 'src/workflow/engine.ts', 'src/workflow/protocol.ts', 'src/workflow/drivers/local/local-driver.ts', `${BENCHMARK}trial.ts`, `${BENCHMARK}start.ts`, 'src/scorers/check-run.ts', 'src/session-flow/task-candidates.ts'], 'setup.ts': ['src/scorers/check-run.ts'] },
    testEntries: ['place.ts', 'team-without.ts', 'role-copy.ts', 'data.ts'],
  },
  // workflow-published-runs.ts judges an offered run by the tool the local driver would launch for its prompt steps.
  { folder: LOCAL, entries: { 'local-driver.ts': ['src/workflow-commands.ts', 'src/workflow-published-runs.ts', 'src/workflow-drive.ts'], 'local-tool-adapter.ts': [] }, testEntries: ['local-driver.ts', 'local-tool-adapter.ts'] },
  { folder: DISCOVERY, entries: { 'workflow-skills.ts': 'any', 'generated-marker.ts': 'any' }, testEntries: ['workflow-skills.ts', 'generated-marker.ts', 'render.ts'] },
  // A suite's checks, start and report change state, so only the commands reach them. Pull, push and their checks sync suites with the team's other definitions.
  // A benchmark run's judge calls are planned and confined to the judge tool its plan pins for every arm.
  {
    folder: BENCHMARK,
    entries: {
      'plan.ts': 'any', 'terms.ts': 'any', 'suite.ts': 'any', 'table.ts': 'any', 'result.ts': 'any', 'history.ts': 'any', 'suite-cache.ts': 'any',
      'run-plan.ts': ['src/scorers/score-plan.ts', 'src/scorers/evidence-dir.ts', 'src/scorers/score-subjects.ts'],
      'calibration.ts': ['src/scorers/score-subjects.ts'],
      'trial.ts': ['src/workflow-commands.ts'],
      'start.ts': ['src/workflow-commands.ts'],
      'report.ts': ['src/workflow-commands.ts'],
      'estimate.ts': ['src/workflow-commands.ts'],
    },
    testEntries: ['plan.ts', 'terms.ts', 'suite.ts', 'table.ts', 'result.ts', 'trial.ts', 'start.ts', 'history.ts', 'run-plan.ts', 'conformance.ts', 'suite-cache.ts', 'arm-workflow.ts', 'team-without.ts', 'verdicts.ts', 'pairing.ts', 'calibration.ts', 'estimate.ts'],
  },
];

/** Whether ENTRIES names `from` among the importers of the entry `to`. */
const namedEntry = (/** @type {string} */ from, /** @type {string} */ to) => ENTRIES.some(({ folder, entries }) => {
  const importers = to.startsWith(folder) ? entries[to.slice(folder.length)] : undefined;

  return Array.isArray(importers) && importers.includes(from);
});


export default defineRule({
  meta: { type: 'problem', docs: { description: 'Preserve workflow driver and entry module boundaries.' } },
  create(context) {
    const absolute = lintedPath(context);
    const index = absolute.lastIndexOf('/src/');

    if (index < 0) return {};
    const from = absolute.slice(index + 1);
    const root = absolute.slice(0, index + 1);
    const isTest = from.startsWith('src/__tests__/');

    return importVisitors(({ node, specifier, typeOnly, names }) => {
      const resolved = sourceImport(context.filename, specifier);
      const to = specifier.startsWith('.') ? (resolved ? resolved.split('\\').join('/').slice(root.length) : path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\.js$/, '.ts')) : specifier;
      const skill = from.startsWith(SKILL);
      let violation = false;

      if (skill && to !== 'zod' && !to.startsWith('node:') && path.posix.dirname(to) !== path.posix.dirname(from)) {
        const allowed = SKILL_IMPORTS[to];
        violation = !allowed || (allowed.typeOnly && !typeOnly ? names.some((name) => !(allowed.values ?? []).includes(name)) : allowed.names !== undefined && names.some((name) => !allowed.names?.includes(name)));
      }

      const entry = ENTRIES.find(({ folder }) => to.startsWith(folder) && !from.startsWith(folder));

      if (entry) {
        const name = to.slice(entry.folder.length);
        const importers = entry.entries[name];
        violation ||= isTest ? !entry.testEntries.includes(name) : importers === undefined || (importers !== 'any' && !importers.includes(from));
      }

      if (from === SKILL + 'transitions.ts' && !typeOnly) violation = true;
      const flat = from.startsWith(FLAT) && ![FLAT + 'drivers/', PLACE, DISCOVERY].some((folder) => from.startsWith(folder));

      if (flat && (to.startsWith(FLAT + 'drivers/') || to.startsWith(DISCOVERY) || (to.startsWith(PLACE) && !namedEntry(from, to)))) violation = true;

      // The engine, the protocol and the drivers never import a feature built on them, such as benchmarks.
      if (from.startsWith(FLAT) && to.startsWith(BENCHMARK)) violation = true;

      // They reach scoring only through its hooks, so the engine never learns how a pass is scored.
      if (from.startsWith(FLAT) && to.startsWith(SCORERS) && to !== SCORERS + 'engine-hooks.ts') violation = true;

      if (from === 'src/workflow/pr-delivery.ts' && to === 'src/workflow/engine.ts') violation = true;

      if (violation) context.report({ node, message: `Workflow module boundary forbids ${from} -> ${to}. Use the declared entry module or an explained inline disable.` });

      if (from === 'src/workflow/snapshot.ts' && !typeOnly && resolved) {
        const reached = reachesSource(resolved, (native) => {
          const file = native.split('\\').join('/');

          return file.includes('/src/providers/') || file.endsWith('/src/workflow/pr-delivery.ts');
        }, false);

        if (reached) context.report({ node, message: `Run snapshot must not load delivery or provider code: ${reached.slice(root.length)}.` });
      }

      if (skill && resolved) {
        const reached = reachesSource(resolved, (file) => file.split('\\').join('/').includes('/' + LOCAL));

        if (reached) context.report({ node, message: `Skill driver dependency reaches the local driver through ${to}: ${reached.slice(root.length)}.` });
      }
    });
  },
});
