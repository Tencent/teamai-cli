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
const FLAT = 'src/workflow/';

/** Rule 1: what a module under `drivers/skill/` may import, besides its siblings, `zod` and `node:*`. */
/** @type {Record<string, { typeOnly?: true; names?: string[]; values?: string[] }>} */
const SKILL_IMPORTS = {
  'src/workflow/protocol.ts': {},
  'src/workflow/types.ts': { typeOnly: true },
  // The declared env facts, and the advice a missing key gets, which the preflight prints before a start.
  'src/workflow/requirements.ts': { typeOnly: true, values: ['envAdvice'] },
  'src/workflow/describe.ts': { typeOnly: true },
  'src/workflow/attempt-marker.ts': {},
  // The wire shapes the engine answers with, which every driver parses with the same schema.
  'src/workflow/lease-wire.ts': { names: ['LeaseWireSchema'] },
  'src/workflow/step-state.ts': { names: ['FailureSchema'] },
  'src/workflow/store.ts': { names: ['takeRunLock', 'LockTaken', 'RunLock', 'attemptDir', 'attemptResultPath', 'skillStatePath', 'runsDir', 'RunIdSchema', 'RunId', 'AttemptIdSchema', 'AttemptId', 'withRunnerLock', 'runnerAlive'] },
  'src/workflow/step-model.ts': {},
  'src/env-resolution.ts': {},
  'src/env-exec.ts': { names: ['stepEnvironment', 'withRunningCli'] },
  'src/utils/redact.ts': {},
  'src/utils/session-id.ts': {},
  // Equal values as equal text, so a kept end is compared with the engine's latest one.
  'src/utils/canonical-json.ts': {},
  'src/resources/agent-format.ts': {},
  'src/tool-launch/process-stop.ts': {},
  // Whether the local driver launches the session's tool, so a local start or resume can name it.
  'src/tool-launch/tools.ts': { names: ['isLaunchTool', 'LAUNCH_ORDER', 'LaunchTool'] },
  'src/builtin-hooks.ts': { names: ['resolveCliEntry'] },
  // The tools a session may name with `--tools default=<tool>`, which of them a child's model resolves for, and the
  // skill-data root the host question's reference is under.
  'src/tools.ts': { names: ['isToolId', 'TOOLS', 'isAgentToolId'] },
  'src/skill-content.ts': { names: ['packagedSkillRoots'] },
  // What the confined judge of the session tool can do, which the driver declares on `score --next`.
  'src/scorers/judge.ts': { names: ['isJudgeTool', 'judgeAccess'] },
  'src/scorers/label.ts': { typeOnly: true },
  // What describe proposes for the inputs of teamai's default share workflows, for the calling session.
  'src/session-share.ts': { names: ['SessionShare'] },
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
    entries: { 'place.ts': ['src/workflow/engine.ts', 'src/workflow/protocol.ts', 'src/workflow/drivers/local/local-driver.ts', `${BENCHMARK}trial.ts`, `${BENCHMARK}start.ts`], 'setup.ts': [`${BENCHMARK}trial.ts`] },
    testEntries: ['place.ts', 'team-without.ts'],
  },
  // workflow-published-runs.ts judges an offered run by the tool the local driver would launch for its prompt steps.
  { folder: LOCAL, entries: { 'local-driver.ts': ['src/workflow-commands.ts', 'src/workflow-published-runs.ts'], 'local-tool-adapter.ts': [] }, testEntries: ['local-driver.ts', 'local-tool-adapter.ts'] },
  { folder: DISCOVERY, entries: { 'workflow-skills.ts': 'any', 'generated-marker.ts': 'any' }, testEntries: ['workflow-skills.ts', 'generated-marker.ts', 'render.ts'] },
  // A suite's checks, start and report change state, so only the commands reach them. Pull, push and their checks sync suites with the team's other definitions.
  {
    folder: BENCHMARK,
    entries: {
      'plan.ts': 'any', 'terms.ts': 'any', 'suite.ts': 'any', 'check.ts': 'any', 'table.ts': 'any', 'result.ts': 'any', 'history.ts': 'any', 'suite-cache.ts': 'any',
      'trial.ts': ['src/workflow-commands.ts'],
      'start.ts': ['src/workflow-commands.ts'],
      'report.ts': ['src/workflow-commands.ts'],
    },
    testEntries: ['plan.ts', 'terms.ts', 'suite.ts', 'check.ts', 'table.ts', 'result.ts', 'trial.ts', 'start.ts', 'history.ts', 'run-plan.ts', 'conformance.ts', 'suite-cache.ts', 'arm-workflow.ts', 'team-without.ts'],
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
