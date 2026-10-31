/** @import { Context } from '@oxlint/plugins' */

import { defineRule } from '@oxlint/plugins';

import { isOneOf, lintedPath } from '../utils.js';

const SKILL = 'src/workflow/drivers/skill/';
const LOCAL = 'src/workflow/drivers/local/';
const PLACE = 'src/workflow/place/';
const DISCOVERY = 'src/workflow/discovery/';
const FLAT = 'src/workflow/';

/** @typedef {{ typeOnly?: true, valueNames?: readonly string[], names?: readonly string[] }} ImportAllowance */

/** The imports skill-driver modules may make outside their own folder. */
/** @type {Map<string, ImportAllowance>} */
const SKILL_IMPORTS = new Map([
  ['src/workflow/protocol.ts', {}],
  ['src/workflow/types.ts', { typeOnly: true }],
  ['src/workflow/requirements.ts', { typeOnly: true, valueNames: ['envAdvice'] }],
  ['src/workflow/describe.ts', { typeOnly: true }],
  ['src/workflow/attempt-marker.ts', {}],
  ['src/workflow/lease-wire.ts', { names: ['LeaseWireSchema'] }],
  ['src/workflow/step-state.ts', { names: ['FailureSchema'] }],
  ['src/workflow/store.ts', { names: ['takeRunLock', 'LockTaken', 'RunLock', 'attemptDir', 'attemptResultPath', 'skillStatePath', 'runsDir', 'RunIdSchema', 'RunId', 'AttemptIdSchema', 'AttemptId', 'withRunnerLock', 'runnerAlive'] }],
  ['src/workflow/step-model.ts', {}],
  ['src/env-resolution.ts', {}],
  ['src/env-exec.ts', { names: ['stepEnvironment'] }],
  ['src/utils/redact.ts', {}],
  ['src/utils/session-id.ts', {}],
  ['src/utils/canonical-json.ts', {}],
  ['src/resources/agent-format.ts', {}],
  ['src/tool-launch/process-stop.ts', {}],
  ['src/tool-launch/tools.ts', { names: ['isLaunchTool', 'LAUNCH_ORDER', 'LaunchTool'] }],
  ['src/builtin-hooks.ts', { names: ['resolveCliEntry'] }],
  ['src/tools.ts', { names: ['isToolId', 'TOOLS', 'isAgentToolId'] }],
  ['src/skill-content.ts', { names: ['packagedSkillRoots'] }],
  ['src/scorers/judge.ts', { names: ['isJudgeTool', 'judgeAccess'] }],
  ['src/scorers/label.ts', { typeOnly: true }],
  ['src/session-share.ts', { names: ['SessionShare'] }],
  ['src/driver-identity.ts', {}],
  ['src/launch-context.ts', { names: ['resolveRunMode', 'RunMode', 'RUN_MODES', 'RunModeSchema'] }],
  ['src/utils/fs.ts', {}],
  ['src/types.ts', { typeOnly: true }],
]);

/** @typedef {{ folder: string, entries: Map<string, string>, tests: Set<string> }} EntryRule */

/** Modules outside these folders must use their public entries. */
/** @type {readonly EntryRule[]} */
const ENTRY_RULES = [
  { folder: SKILL, entries: new Map([['skill-driver.ts', 'any'], ['literals.ts', 'src/workflow/discovery/render.ts']]), tests: new Set(['skill-driver.ts', 'literals.ts']) },
  { folder: PLACE, entries: new Map([['place.ts', 'src/workflow/protocol.ts|src/workflow/drivers/local/local-driver.ts']]), tests: new Set(['place.ts']) },
  { folder: LOCAL, entries: new Map([['local-driver.ts', 'src/workflow-commands.ts|src/workflow-published-runs.ts'], ['local-tool-adapter.ts', '']]), tests: new Set(['local-driver.ts', 'local-tool-adapter.ts']) },
  { folder: DISCOVERY, entries: new Map([['workflow-skills.ts', 'any'], ['generated-marker.ts', 'any']]), tests: new Set(['workflow-skills.ts', 'generated-marker.ts', 'render.ts']) },
];

/** Existing direct test imports whose unit cannot use the folder entry. */
const ALLOWED = new Set([
  'src/__tests__/workflow-setup.test.ts\u0000src/workflow/place/setup.ts',
  'src/__tests__/workflow-local-driver.test.ts\u0000src/workflow/place/worktree-snapshot.ts',
  'src/__tests__/workflow-skill-transitions.test.ts\u0000src/workflow/drivers/skill/transitions.ts',
]);

/** @param {Context} context */
function repoPath(context) {
  const normalized = lintedPath(context);
  const marker = normalized.lastIndexOf('/src/');
  return marker === -1 ? normalized : normalized.slice(marker + 1);
}
/** @param {string} file @param {string} folder */
function under(file, folder) { return file.startsWith(folder); }
/** @param {string} file */
function isTest(file) { return under(file, 'src/__tests__/'); }
/** @param {string} file */
function isFlat(file) { return under(file, FLAT) && ![`${FLAT}drivers/`, PLACE, DISCOVERY].some((folder) => under(file, folder)); }
/** @param {string} from @param {string} to */
function edgeKey(from, to) { return `${from}\u0000${to}`; }

/** Resolve the repository-relative TypeScript path an import specifier names. */
/** @param {string} file @param {string} value */
function pathFromSpecifier(file, value) {
  if (!value.startsWith('.')) return value;
  const parts = value.replace(/\.js$/, '').split('/');
  const out = file.split('/').slice(0, -1);
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return `${out.join('/')}.ts`;
}
/** @param {any} node @returns {string | undefined} */
function sourceValue(node) {
  const source = node.source;
  const value = source?.value ?? source?.rawValue;
  return typeof value === 'string' ? value : undefined;
}
/** @param {any} node @returns {string[]} */
function namesOf(node) {
  return (node.specifiers ?? []).map(/** @param {any} specifier */ (specifier) => specifier.local?.name ?? specifier.imported?.name ?? specifier.exported?.name ?? '').filter(Boolean);
}
/** @param {any} node */
function typeOnly(node) {
  const specifiers = node.specifiers ?? [];
  return node.importKind === 'type' || node.exportKind === 'type'
    || (specifiers.length > 0 && specifiers.every(/** @param {any} specifier */ (specifier) => specifier.importKind === 'type' || specifier.exportKind === 'type'));
}
/** @param {string} from @param {string} to @param {boolean} typeOnlyValue @param {string[]} names */
function violatesBoundary(from, to, typeOnlyValue, names) {
  if (to === 'zod' || to.startsWith('node:') || !to.startsWith('src/')) return false;
  const fromDir = from.slice(0, from.lastIndexOf('/'));
  const toDir = to.slice(0, to.lastIndexOf('/'));
  if (fromDir === toDir) return false;

  if (under(from, SKILL)) {
    const allowed = SKILL_IMPORTS.get(to);
    if (allowed === undefined) return true;
    if (allowed.typeOnly && !typeOnlyValue && names.some((name) => !allowed.valueNames?.includes(name))) return true;
    return allowed.names !== undefined && names.some((name) => !allowed.names?.includes(name));
  }

  for (const guard of ENTRY_RULES) {
    if (!under(to, guard.folder) || under(from, guard.folder)) continue;
    const entry = to.slice(guard.folder.length);
    if (isTest(from)) return !guard.tests.has(entry);
    const allowed = guard.entries.get(entry);
    return allowed === undefined || (allowed !== 'any' && !allowed.split('|').includes(from));
  }

  if (isFlat(from) && under(to, FLAT)) {
    return under(to, `${FLAT}drivers/`) || under(to, DISCOVERY)
      || (under(to, PLACE) && !(from === 'src/workflow/protocol.ts' && to === `${PLACE}place.ts`));
  }
  return false;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Keep workflow module boundaries in the engine and drivers.' },
  },
  create(context) {
    if (!lintedPath(context).includes('/src/') || isOneOf(context, ['src/__tests__/workflow-module-boundaries.test.ts'])) return {};

    /** @param {any} node */
    const check = (node) => {
      const value = sourceValue(node);
      if (value === undefined) return;
      const from = repoPath(context);
      const to = pathFromSpecifier(from, value);
      if (violatesBoundary(from, to, typeOnly(node), namesOf(node)) && !ALLOWED.has(edgeKey(from, to))) {
        context.report({
          node,
          message: `Workflow module boundary: ${from} must not import ${to}. Keep the engine, drivers and feature modules separated.`,
        });
      }
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression'
          || node.callee.object.type !== 'Identifier' || node.callee.object.name !== 'vi'
          || node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'mock') return;
        const source = node.arguments[0];
        if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
        check({ source });
      },
    };
  },
});
