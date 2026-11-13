import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { defineRule } from '@oxlint/plugins';

import { importVisitors } from '../imports.js';
import { FAMILY, PROCESS_STARTERS, isTestSupportPath, lintedPath, manifest, workspaceRoot } from '../utils.js';

/** @type {Map<string, Map<string, string>>} */
const packageNames = new Map();

/**
 * Each workspace package's name, mapped to its folder under `packages/`.
 * @param {string} root
 * @returns {Map<string, string>}
 */
function packagesByName(root) {
  const cached = packageNames.get(root);

  if (cached) return cached;
  /** @type {Map<string, string>} */
  const names = new Map();
  const dir = `${root}/packages`;

  for (const folder of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const name = manifest(`${dir}/${folder}`)?.name;

    if (name !== undefined) names.set(name, folder);
  }

  packageNames.set(root, names);

  return names;
}

/** The one package that imports the families. */
const DEFINITIONS = 'tool-definitions';

/** The conformance kit families test with. */
const TEST_KIT = 'tool-testing';

/** The launch library: it runs a tool's launch over a process port it is given, so it starts no process and knows no runtime. */
const LAUNCH_LIBRARY = 'tool-launch';

/** The runtime protocol, which teamai and every runtime parse with: the one runtime package src/ imports. */
const RUNTIME_PROTOCOL = 'runtime-protocol';

/** What every runtime process runs of the protocol: the request loop, each op's one end, its journal. */
const RUNTIME_KIT = 'runtime-kit';

/** The test support every runtime's tests share. */
const RUNTIME_TEST_KIT = 'runtime-testing';

/** The runtimes teamai runs in its own process, which src/ imports by name: they ship inside teamai-cli. */
const IN_PROCESS = new Set(['runtime-tools']);

/**
 * The workspace imports the protocol may make: the levels and the home it names, and the usage it carries. Anything
 * more would put a tool's or a runtime's facts in the contract every runtime and teamai parse with.
 */
const PROTOCOL_IMPORTS = new Set(['@teamai/shared', '@teamai/shared/home', '@teamai/tool-core/launch', '@teamai/tool-core/stdout']);

/** The workspace packages the kit may import: it is bundled into every runtime, so it stays below all of them. */
const KIT_IMPORTS = new Set([RUNTIME_PROTOCOL, 'shared']);

/**
 * The package a bare specifier names: `@scope/name` or `name`, without a subpath.
 * @param {string} specifier
 */
function packageOf(specifier) {
  const parts = specifier.split('/');

  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier;
}

/**
 * Whether src/ may load `specifier` at run time: one of Node's modules, a workspace package, or a dependency of
 * teamai-cli. tsup bundles whatever src/ loads, so anything else would ship inside dist/, as a runtime's provider SDK
 * that the member installs would. Every new package fails until teamai-cli depends on it.
 * @param {string} root
 * @param {string} specifier
 */
function shipsWithTeamai(root, specifier) {
  const name = packageOf(specifier);

  if (isBuiltin(specifier)) return true;

  if (packagesByName(root).has(name)) return true;
  const dependencies = manifest(root)?.dependencies;

  return dependencies !== undefined && Object.hasOwn(dependencies, name);
}

/**
 * The `packages/<folder>` a path relative to the workspace root sits in, if any.
 * @param {string} relative
 */
function packageFolder(relative) {
  return /^packages\/([^/]+)\//.exec(relative)?.[1];
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Keep workspace packages and src/ on their sides of the package boundary.' },
  },
  create(context) {
    const file = lintedPath(context);
    const root = workspaceRoot(path.posix.dirname(file));

    if (root === undefined) return {};
    const from = path.posix.relative(root, file);
    const own = packageFolder(from);
    const inApp = from.startsWith('src/');
    const isTest = from.startsWith('src/__tests__/') || /\.test\.[cm]?[jt]sx?$/.test(from);
    // A package's src/testing/ holds the harness its tests run, which nothing that ships loads.
    const isTestSupport = isTest || isTestSupportPath(from);

    if (own === undefined && !inApp) return {};

    return {
      Program(node) {
        if (own !== undefined && manifest(`${root}/packages/${own}`)?.private !== true) {
          context.report({ node, message: `A workspace package is private: set "private": true in packages/${own}/package.json, so it ships only inside teamai-cli.` });
        }
      },
      ...importVisitors(({ node, specifier, typeOnly }) => {
        if (inApp && !isTest && !typeOnly && !specifier.startsWith('.') && !shipsWithTeamai(root, specifier)) {
          context.report({ node, message: `src/ imports values only from Node, the workspace packages and the dependencies in package.json, since tsup bundles whatever src/ loads into dist/: ${from} -> ${specifier}. Import only its types (import type), or add it to dependencies if teamai-cli ships it.` });
        }

        if (own === LAUNCH_LIBRARY && !isTestSupport && !typeOnly && PROCESS_STARTERS.has(specifier)) {
          context.report({ node, message: `@teamai/tool-launch starts no process: it runs a launch through the port its caller gives, the host's spawn or a sandbox's exec. ${from} -> ${specifier}.` });
        }

        if (specifier.startsWith('.')) {
          const to = path.posix.relative(root, path.posix.resolve(path.posix.dirname(file), specifier));
          const target = packageFolder(to);

          if (!isTestSupport && isTestSupportPath(to)) {
            context.report({ node, message: `${to} is test support: import it from a *.test.ts file or from src/testing/, so nothing that ships loads it. ${from} -> ${to}.` });
          }

          if (target === own) return;

          if (target === undefined) {
            context.report({ node, message: `A workspace package imports only its own files and other workspace packages by name, never src/ or other repository files: ${from} -> ${to}.` });
          } else {
            const name = [...packagesByName(root)].find(([, folder]) => folder === target)?.[0] ?? `the name in packages/${target}/package.json`;
            context.report({ node, message: `Import a workspace package by its package name, so only its exports map is reachable: ${from} -> ${to}. Use '${name}'.` });
          }

          return;
        }

        for (const [name, folder] of packagesByName(root)) {
          if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;

          if (inApp && folder.startsWith('runtime-') && folder !== RUNTIME_PROTOCOL && !IN_PROCESS.has(folder) && !(folder === RUNTIME_TEST_KIT && isTest)) {
            context.report({ node, message: `src/ never imports a runtime package but ${[...IN_PROCESS].map((runtime) => `@teamai/${runtime}`).join(', ')}, which runs in teamai's process: teamai reaches any other runtime only through its executable over stdio, and reads its lines with @teamai/runtime-protocol. ${from} -> ${specifier}.` });
          }

          // A family's ./testing entry holds its recordings for the fake agents tests run; nothing that ships loads it, and
          // another family's tests stay off it, as a family depends on tool-core alone.
          const familyTesting = FAMILY.test(folder) && specifier === `${name}/testing`;

          if (familyTesting && !isTest && !(own === folder && isTestSupport)) {
            context.report({ node, message: `${specifier} is test-only: import it from a *.test.ts file, so a family's recordings never ship in teamai-cli. ${from} -> ${specifier}.` });
          }

          if (FAMILY.test(folder) && own !== DEFINITIONS && own !== folder && !(familyTesting && isTest && !FAMILY.test(own ?? ''))) {
            context.report({ node, message: `Only @teamai/tool-definitions imports a tool family: the app reads tools through it, and a family depends on tool-core alone. ${from} -> ${specifier}.` });
          }

          if (folder === TEST_KIT && !isTest) {
            context.report({ node, message: `@teamai/tool-testing is test-only: import it from a *.test.ts file, so the conformance kit and vitest never ship in teamai-cli. ${from} -> ${specifier}.` });
          }

          if (folder === RUNTIME_TEST_KIT && !isTestSupport) {
            context.report({ node, message: `@teamai/runtime-testing is test-only: import it from a *.test.ts file or a package's src/testing/, so its harness never ships in a runtime or teamai-cli. ${from} -> ${specifier}.` });
          }

          if (own?.startsWith('runtime-') && folder.startsWith('runtime-') && folder !== own && folder !== RUNTIME_PROTOCOL && folder !== RUNTIME_KIT && folder !== RUNTIME_TEST_KIT) {
            context.report({ node, message: `A runtime package imports no other runtime but the protocol, the kit and, from its tests, @teamai/runtime-testing: each runtime ships as an executable of its own. ${from} -> ${specifier}.` });
          }

          if (own === RUNTIME_PROTOCOL && !PROTOCOL_IMPORTS.has(specifier)) {
            context.report({ node, message: `@teamai/runtime-protocol imports only ${[...PROTOCOL_IMPORTS].join(', ')}, so the contract teamai and every runtime parse with carries no tool's or runtime's facts. ${from} -> ${specifier}.` });
          }

          if (own === LAUNCH_LIBRARY && folder.startsWith('runtime-')) {
            context.report({ node, message: `@teamai/tool-launch imports no runtime package: the host and every runtime that launches a tool use it, so it stays below them all. ${from} -> ${specifier}.` });
          }

          if (own === LAUNCH_LIBRARY && folder === DEFINITIONS && !isTestSupport) {
            context.report({ node, message: `@teamai/tool-launch runs the tool its caller resolved, so it reads no tool registry: a runtime that bundles it would carry every family. Take the tool from the caller; tests may read @teamai/tool-definitions. ${from} -> ${specifier}.` });
          }

          if (own === RUNTIME_KIT && !KIT_IMPORTS.has(folder)) {
            context.report({ node, message: `@teamai/runtime-kit imports only @teamai/runtime-protocol and @teamai/shared: it is bundled into every runtime, so it stays below them all. ${from} -> ${specifier}.` });
          }
        }
      }, (node) => {
        if (own !== undefined || (inApp && !isTest)) {
          context.report({ node, message: `${from} loads a module whose name is computed, so teamai/package-boundaries cannot check which side of the package boundary it is on. Name the module with a string literal, or disable this line saying why the module is outside the repository.` });
        }
      }),
    };
  },
});
