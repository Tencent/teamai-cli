/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { importedName } from '../imports.js';
import { inProductionSource, isOneOf, scopedFiles, stringLiteralValue, variableOf } from '../utils.js';

/** The one module that calls `process.kill`, behind `signalPid` and `signalGroup`, and a child's own kill, behind `signalChild`. */
export const OWNER = scopedFiles(['packages/shared/src/process-group.ts']);

/**
 * Programs node runs as they are, with no bundler or loader, so they cannot load the owner; each keeps the owner's
 * check inline: no signal to a pid below 2.
 */
export const RUN_AS_IS = scopedFiles(['packages/runtime-sandbox/src/testing/fake-engine.mjs']);

/**
 * Files whose string literals hold the source of a program a test runs, which signals its own process or the one that
 * started it, or lints: the text is that program's, which lint does not read as code.
 */
export const SCRIPT_TEXT = scopedFiles([
  'oxlint-plugin-teamai/rules/signal-owner.test.ts',
  'packages/runtime-sandbox/src/providers/containment.test.ts',
  'src/__tests__/e2e/benchmark-checks.test.ts',
  'src/__tests__/e2e/workflow-pass-scoring.test.ts',
  'src/__tests__/env-exec.test.ts',
  'src/__tests__/helpers/benchmark-fixture.ts',
]);

/**
 * The names whose `.kill` is not a local child's, by file: a remote sandbox's command, which no local process backs,
 * and a test harness's stop of a runtime, which signals the child through signalChild itself.
 */
export const NOT_A_CHILD = new Map([
  ['packages/runtime-sandbox/src/providers/vercel.ts', 'command'],
  ['packages/runtime-paseo/src/testing/suite.ts', 'runtime'],
]);

scopedFiles([...NOT_A_CHILD.keys()]);

const MESSAGE = 'Send a signal through signalPid or signalGroup from @teamai/shared/process-group, not process.kill: they send nothing to a pid below 2, which kill reads as the caller\'s own process group (0), every process it may signal (-1) or init (1), and they tell what the signal came to rather than throw for a process that is gone or another user\'s. A test observes signals with vi.spyOn(process, \'kill\').';

const CHILD_MESSAGE = 'Signal a child process through signalChild from @teamai/shared/process-group, not its own kill: until a failed spawn\'s error is delivered, Node 20 sends that kill to pid 0, the caller\'s whole process group, and signalChild sends nothing to a child with no pid. A remote sandbox\'s command is not a child: name its file in NOT_A_CHILD (oxlint-plugin-teamai/rules/signal-owner.js).';

const CHILD_TEXT_MESSAGE = 'This text kills a child with no check that it spawned, in a program production code writes for another tool to run, which cannot load @teamai/shared/process-group. Write each kill as `if (child.pid !== undefined) child.kill(…)`: until a failed spawn\'s error is delivered, Node 20 sends that kill to pid 0, the whole process group of the tool it runs in.';

/** A kill of a child in program text, and the same kill behind the pid check this rule asks for. */
const TEXT_KILL = /([\w$]+)\s*\.\s*kill\s*\(/g;
const GUARDED_TEXT_KILL = /if \(([\w$]+)\.pid !== undefined\) \1\.kill\(/g;

const TEXT_MESSAGE = 'This text calls process.kill in a program a test runs, which lint does not read as code. Signal through @teamai/shared/process-group in code, or name the file in SCRIPT_TEXT (oxlint-plugin-teamai/rules/signal-owner.js) and keep the pid it signals above 1.';

/** The modules `process` is also imported from. */
const PROCESS_MODULES = new Set(['process', 'node:process']);

/** The executables that signal a pid they are given. */
const KILL_EXECUTABLES = new Set(['kill', 'pkill', 'killall']);

/** The calls that start an executable named by their first argument. */
const STARTERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'spawnCommand', 'spawnCommandSync', 'execCommand']);

/** The calls that run their first argument as a shell command line. */
const SHELLS = new Set(['exec', 'execSync']);

/** The text of a string literal, or of a template literal with no placeholder. */
function textOf(/** @type {ESTree.Node | null | undefined} */ node) {
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;

  return stringLiteralValue(node);
}

/** The text a command line starts with: a string, or a template up to its first placeholder. */
function leadingTextOf(/** @type {ESTree.Node | undefined} */ node) {
  return node?.type === 'TemplateLiteral' ? node.quasis[0]?.value.cooked ?? undefined : stringLiteralValue(node);
}

/** The executable a path names: `kill` of `/bin/kill`. */
function executableOf(/** @type {string} */ command) {
  return command.split(/[\\/]/).at(-1) ?? '';
}

/** The name a call is made by: `f` of `f(…)` and of `o.f(…)`. */
function calleeName(/** @type {ESTree.Node} */ callee) {
  if (callee.type === 'Identifier') return callee.name;

  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : undefined;
}

/** The variables whose values `isProcess` is judging. */
const judging = new Set();

/**
 * Whether `node` is Node's `process`: the global, `globalThis.process`, the `process` module imported or required
 * whole, or a name bound to one of these.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function isProcess(sourceCode, node) {
  switch (node.type) {
    case 'Identifier': {
      const def = variableOf(sourceCode, node, node.name)?.defs[0];

      if (def === undefined) return node.name === 'process';

      // The process module imported whole, or as its default; `import { kill }` is checked where it is imported.
      if (def.type === 'ImportBinding') {
        const specifier = def.node;

        return def.parent?.type === 'ImportDeclaration' && PROCESS_MODULES.has(String(def.parent.source.value))
          && (specifier.type === 'ImportSpecifier' || specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier') && ['default', '*'].includes(importedName(specifier));
      }

      // A parameter whose default is process: `(target = process) => …`.
      if (def.type === 'Parameter') return def.name.parent?.type === 'AssignmentPattern' && def.name.parent.left === def.name && isProcess(sourceCode, def.name.parent.right);

      if (def.type !== 'Variable') return false;

      const variable = variableOf(sourceCode, node, node.name);

      // A variable met again while its own values are judged (`a = b; b = a`) adds nothing to what they say.
      if (variable === undefined || judging.has(variable)) return false;
      judging.add(variable);

      try {
        // Its initial value, or any value assigned to it later: `let target; target = process;`.
        return variable.references.some((reference) => reference.isWrite() && reference.writeExpr !== null && reference.writeExpr !== undefined
          && isProcess(sourceCode, reference.writeExpr));
      } finally {
        judging.delete(variable);
      }
    }

    case 'MemberExpression': {
      const key = node.computed ? textOf(node.property) : node.property.type === 'Identifier' ? node.property.name : undefined;

      if (key === 'process') return node.object.type === 'Identifier' && (node.object.name === 'globalThis' || node.object.name === 'global');

      return key === 'default' && isProcess(sourceCode, node.object);
    }

    case 'LogicalExpression':
      return isProcess(sourceCode, node.left) || isProcess(sourceCode, node.right);
    case 'ConditionalExpression':
      return isProcess(sourceCode, node.consequent) || isProcess(sourceCode, node.alternate);

    case 'CallExpression':
      // `require('node:process')`, or the require `createRequire(…)` returns called at once.
      return ((node.callee.type === 'Identifier' && node.callee.name === 'require') || node.callee.type === 'CallExpression') && PROCESS_MODULES.has(textOf(node.arguments[0]) ?? '');
    case 'ImportExpression':
      return PROCESS_MODULES.has(textOf(node.source) ?? '');
    case 'AwaitExpression':
      return isProcess(sourceCode, node.argument);
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      return isProcess(sourceCode, node.expression);
    default:
      return false;
  }
}

/** Whether `node` reads key `kill`: `.kill`, `['kill']` or ``[`kill`]``. */
function readsKill(/** @type {ESTree.MemberExpression} */ node) {
  return node.computed ? textOf(node.property) === 'kill' : node.property.type === 'Identifier' && node.property.name === 'kill';
}

/** Whether `node` reads a key lint cannot read, as `[name]`, which may be `kill`. */
function readsUnknownKey(/** @type {ESTree.MemberExpression} */ node) {
  return node.computed && textOf(node.property) === undefined;
}

/** Whether `node` is the target of an assignment, as `child.kill = …` puts a kill of its own on a child. */
function isAssigned(/** @type {ESTree.MemberExpression} */ node) {
  return node.parent?.type === 'AssignmentExpression' && node.parent.left === node;
}

/**
 * Whether the object pattern `node` takes key `kill` from `value`, as `{ kill } = process`, or reaches it under key
 * `process` of the global object, as `{ process: { kill } } = globalThis`.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.ObjectPattern | ESTree.ObjectAssignmentTarget} node
 * @param {ESTree.Node} value
 */
function takesKillOf(sourceCode, node, value) {
  if (isProcess(sourceCode, value)) return takesKill(node);

  if (value.type !== 'Identifier' || (value.name !== 'globalThis' && value.name !== 'global')) return false;

  return node.properties.some((property) => property.type === 'Property' && !property.computed && property.key.type === 'Identifier' && property.key.name === 'process'
    && property.value.type === 'ObjectPattern' && takesKill(property.value));
}

/** Whether the object pattern `node`, of a declaration or an assignment, takes key `kill`. */
function takesKill(/** @type {ESTree.ObjectPattern | ESTree.ObjectAssignmentTarget} */ node) {
  return node.properties.some((property) => property.type === 'Property' && (property.computed ? textOf(property.key) === 'kill' : property.key.type === 'Identifier' && property.key.name === 'kill'));
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Send every signal by pid through @teamai/shared/process-group, which refuses a pid below 2.' },
  },
  create(context) {
    if (isOneOf(context, OWNER)) return {};
    // A program run as it is keeps the owner's check inline, so only its own process.kill is let off.
    const mayCallKill = isOneOf(context, RUN_AS_IS);
    const { sourceCode } = context;
    const report = (/** @type {ESTree.Node} */ node) => { context.report({ node, message: MESSAGE }); };
    const isScriptText = isOneOf(context, SCRIPT_TEXT);
    // A test may kill a child it saw spawn; production code cannot tell a failed spawn from a live one by timing.
    const checksChildren = inProductionSource(context);
    const notAChild = [...NOT_A_CHILD].find(([file]) => isOneOf(context, [file]))?.[1];
    /** @param {ESTree.Node} object */
    const isChild = (object) => checksChildren && !(object.type === 'Identifier' && object.name === notAChild);

    /** @param {ESTree.Node} node */
    const checkText = (node) => {
      const text = node.type === 'TemplateLiteral' ? node.quasis.map((quasi) => quasi.value.cooked ?? '').join('') : stringLiteralValue(node);

      if (text === undefined) return;

      if (!isScriptText && /\bprocess\s*\.\s*kill\s*\(/.test(text)) context.report({ node, message: TEXT_MESSAGE });
      const kills = [...text.matchAll(TEXT_KILL)].filter(([, name]) => name !== 'process').length;

      if (checksChildren && kills > [...text.matchAll(GUARDED_TEXT_KILL)].length) context.report({ node, message: CHILD_TEXT_MESSAGE });
    };

    return {
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        if (readsUnknownKey(node) && isProcess(sourceCode, node.object)) report(node);

        if (!readsKill(node)) return;

        if (isProcess(sourceCode, node.object)) {
          if (!mayCallKill) report(node);
        }
        else if (isChild(node.object) && !isAssigned(node)) context.report({ node, message: CHILD_MESSAGE });
      },
      /** @param {ESTree.VariableDeclarator} node */
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || !node.init) return;

        if (takesKillOf(sourceCode, node.id, node.init)) report(node);
        else if (takesKill(node.id) && isChild(node.init)) context.report({ node, message: CHILD_MESSAGE });
      },
      /** @param {ESTree.AssignmentExpression} node */
      AssignmentExpression(node) {
        if (node.left.type !== 'ObjectPattern') return;

        if (takesKillOf(sourceCode, node.left, node.right)) report(node);
        else if (takesKill(node.left) && isChild(node.right)) context.report({ node, message: CHILD_MESSAGE });
      },
      /** @param {ESTree.AssignmentPattern} node */
      AssignmentPattern(node) {
        // A destructured parameter whose default is process: `({ kill } = process) => …`.
        if (node.left.type === 'ObjectPattern' && takesKillOf(sourceCode, node.left, node.right)) report(node);
      },
      /** @param {ESTree.ExportNamedDeclaration} node */
      ExportNamedDeclaration(node) {
        if (!PROCESS_MODULES.has(String(node.source?.value))) return;

        for (const specifier of node.specifiers) if (specifier.local.type === 'Identifier' ? specifier.local.name === 'kill' : specifier.local.value === 'kill') report(specifier);
      },
      /** @param {ESTree.ImportDeclaration} node */
      ImportDeclaration(node) {
        if (!PROCESS_MODULES.has(String(node.source.value))) return;

        for (const specifier of node.specifiers) if (importedName(specifier) === 'kill') report(specifier);
      },
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        const { callee } = node;
        const name = calleeName(callee);

        // A call given process and the key `kill` reads it with no member expression: Reflect.get, a property descriptor.
        // A spy is how a test observes a signal, and sends none once it is mocked.
        if (name !== 'spyOn' && node.arguments.some((argument) => textOf(argument) === 'kill') && node.arguments.some((argument) => isProcess(sourceCode, argument))) report(node);
        const first = leadingTextOf(node.arguments[0]);

        if (first === undefined || name === undefined || (!STARTERS.has(name) && !SHELLS.has(name))) return;
        // The first word: a command line under `shell: true` or exec names its executable first.
        const executable = executableOf(first.trim().split(/\s+/)[0] ?? '');
        const second = node.arguments[1];
        // `env kill …` runs kill.
        const launched = executable === 'env' && second?.type === 'ArrayExpression' ? executableOf(textOf(second.elements[0] ?? undefined) ?? '') : executable;

        if (KILL_EXECUTABLES.has(launched)) report(node);
      },
      Literal: checkText,
      TemplateLiteral: checkText,
    };
  },
});
