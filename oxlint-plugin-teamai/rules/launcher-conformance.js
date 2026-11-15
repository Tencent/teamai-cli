import { defineRule } from '@oxlint/plugins';
import fs from 'node:fs';
import { inProductionSource, isOneOf, scopedFiles } from '../utils.js';

// A ToolLauncher is branded: only the mint `toolLauncher` makes one, so the type check refuses a launcher from anywhere
// else. This rule keeps the mint's calls in the adapters below, one each, and refuses a cast that forges the brand: to
// the port by any name it goes by, or to never or any in a file that uses a launcher.

// Each ToolLauncher adapter, and the test that runs the launcher conformance suite (toolLauncherConformance) on it.
const ADAPTERS = {
  'packages/runtime-tools/src/step.ts': 'packages/runtime-tools/src/step.test.ts',
  'packages/runtime-sandbox/src/step.ts': 'packages/runtime-sandbox/src/step.test.ts',
  'src/workflow/steps/runtime-steps.ts': 'src/__tests__/workflow-runtime-launcher.test.ts',
};

// The port's own file, where the mint casts.
const PORT = 'packages/tool-launch/src/run-step-launch.ts';

const MINT = 'toolLauncher';

scopedFiles([PORT, ...Object.keys(ADAPTERS), ...Object.values(ADAPTERS)]);

const readRepositoryFile = (/** @type {string} */ file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// A call on a line of its own: one in a comment or a string does not run the suite. An adapter that no longer mints
// leaves an entry that guards nothing.
const unchecked = [
  ...Object.values(ADAPTERS).filter((test) => !/^\s*toolLauncherConformance\(/mu.test(readRepositoryFile(test))).map((test) => `${test} calls no toolLauncherConformance`),
  ...Object.keys(ADAPTERS).filter((adapter) => !new RegExp(`\\b${MINT}\\(`, 'u').test(readRepositoryFile(adapter))).map((adapter) => `${adapter} calls no ${MINT}`),
];

if (unchecked.length > 0) throw new Error(`teamai/launcher-conformance: ${unchecked.join('; ')}. Run the suite on the adapter again, or point ADAPTERS at the adapter and the test that runs it.`);

const OUTSIDE = `A ToolLauncher is made only in an adapter the launcher conformance suite runs on: call ${MINT} there, run toolLauncherConformance on it in a test, and add this file and that test to ADAPTERS in oxlint-plugin-teamai/rules/launcher-conformance.js.`;

const SECOND = `An adapter makes one ToolLauncher, the one its conformance test runs: build this launch on that one, or move this launcher to an adapter of its own with its own conformance test.`;

const CAST = `A cast to ToolLauncher forges a launcher the conformance suite never ran on: make it with ${MINT} in an adapter the suite runs on.`;

const RENAMED = `ToolLauncher under another name lets a cast to that name forge a launcher the conformance suite never ran on: call it ToolLauncher, and make the launcher with ${MINT} in an adapter the suite runs on.`;

const ERASED = `A cast to never or any where a launcher is used forges a ToolLauncher the conformance suite never ran on, since the compiler takes either for the port: make the launcher with ${MINT} in an adapter the suite runs on, or cast to the type you mean.`;

const PORT_NAME = 'ToolLauncher';

// The package the port and runStepLaunch come from: a file that imports it may hand a launcher on unnamed.
const LAUNCH_PACKAGE = /(?:^@teamai\/tool-launch(?:\/|$))|(?:\/tool-launch\/src\/)/u;

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep every ToolLauncher adapter under the launcher conformance suite.' } },
  create(context) {
    if (!inProductionSource(context)) return {};
    const isAdapter = isOneOf(context, Object.keys(ADAPTERS));
    const isPort = isOneOf(context, [PORT]);
    /** @type {Set<string>} the names the mint goes by in this file */
    const mints = new Set([MINT]);
    let minted = 0;
    // Whether the file names the port or imports its package, where a cast to never or any can stand for the port.
    let usesLauncher = false;
    /** @type {any[]} */
    const erasing = [];

    const isPortName = (/** @type {any} */ name) => (name?.type === 'Identifier' && name.name === PORT_NAME) || (name?.type === 'TSQualifiedName' && name.right.name === PORT_NAME);

    const erase = (/** @type {any} */ node) => {
      if (!isPort && (node.typeAnnotation.type === 'TSNeverKeyword' || node.typeAnnotation.type === 'TSAnyKeyword')) erasing.push(node);
    };

    return {
      ImportDeclaration(node) {
        if (LAUNCH_PACKAGE.test(node.source.value)) usesLauncher = true;
      },
      ImportSpecifier(node) {
        if (node.imported.type === 'Identifier' && node.imported.name === MINT) mints.add(node.local.name);

        if (!isPort && node.imported.type === 'Identifier' && node.imported.name === PORT_NAME && node.local.name !== PORT_NAME) context.report({ node, message: RENAMED });
      },
      ExportSpecifier(node) {
        if (!isPort && node.local.type === 'Identifier' && node.local.name === PORT_NAME && node.exported.type === 'Identifier' && node.exported.name !== PORT_NAME) context.report({ node, message: RENAMED });
      },
      TSInterfaceHeritage(node) {
        if (!isPort && isPortName(node.expression)) context.report({ node, message: RENAMED });
      },
      TSAsExpression: erase,
      TSTypeAssertion: erase,
      'Program:exit'() {
        if (usesLauncher) for (const node of erasing) context.report({ node, message: ERASED });
      },
      CallExpression(node) {
        const { callee } = node;
        const isMint = (callee.type === 'Identifier' && mints.has(callee.name)) || (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === MINT);

        if (!isMint || isPort) return;

        minted++;

        if (!isAdapter) context.report({ node, message: OUTSIDE });
        else if (minted > 1) context.report({ node, message: SECOND });
      },
      // The mint held or exported under another name makes launchers no call above sees.
      Identifier(node) {
        const { parent } = node;

        const isCalled = (/** @type {any} */ at) => at.parent?.type === 'CallExpression' && at.parent.callee === at;

        if (isPort || !mints.has(node.name) || parent.type === 'ImportSpecifier' || isCalled(node) || (parent.type === 'MemberExpression' && parent.property === node && isCalled(parent))) return;

        context.report({ node, message: OUTSIDE });
      },
      TSTypeReference(node) {
        if (!isPortName(node.typeName)) return;
        usesLauncher = true;

        if (isPort) return;

        // Up through the type's own nodes only: a launcher's return type inside a cast expression is no cast to the port.
        for (let /** @type {any} */ at = node.parent; at?.type.startsWith('TS'); at = at.parent) {
          if (at.type === 'TSAsExpression' || at.type === 'TSTypeAssertion' || at.type === 'TSTypeAliasDeclaration') {
            context.report({ node, message: at.type === 'TSTypeAliasDeclaration' ? RENAMED : CAST });

            return;
          }
        }
      },
    };
  },
});
