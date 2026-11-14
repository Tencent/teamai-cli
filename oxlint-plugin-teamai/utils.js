/** @import { Context, ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * A tool family's folder under `packages/`: every `tool-*` package but the contract, the test kit, the list of families
 * and the launch library. A new `tool-<name>` package is a family with no rule edit.
 */
export const FAMILY = /^tool-(?!(?:core|testing|definitions|launch)$)/;

/**
 * The modules whose values start a process: Node's and `cross-spawn`, and every workspace module but a family's that
 * reaches one of them, which `tool-family-shape.test.ts` derives from the source graph so a new wrapper fails until it is listed here.
 */
export const PROCESS_STARTERS = new Set([
  'child_process',
  'node:child_process',
  'cross-spawn',
  '@teamai/runtime-kit/journal',
  '@teamai/runtime-testing/connect',
  '@teamai/runtime-testing/leaks',
  '@teamai/runtime-tools',
  '@teamai/runtime-tools/answer',
  '@teamai/runtime-tools/confined',
  '@teamai/runtime-tools/headless',
  '@teamai/shared/cli-path',
  '@teamai/shared/exec',
  '@teamai/shared/process-group',
  '@teamai/tool-testing/conformance',
  '@teamai/tool-testing/fake-agent',
]);

/**
 * The linted file's path with `/` separators, so a rule can scope itself on any platform.
 * @param {Context} context
 * @returns {string}
 */
export function lintedPath(context) {
  return context.filename.split('\\').join('/');
}

/**
 * Whether the linted file is one of `files`, given relative to the repository root.
 * @param {Context} context
 * @param {readonly string[]} files
 * @returns {boolean}
 */
export function isOneOf(context, files) {
  const file = lintedPath(context);

  return files.some((relative) => file.endsWith(`/${relative}`));
}

/** @type {Map<string, string | undefined>} */
const packageRoots = new Map();

/**
 * The nearest directory at or above `dir` holding a `package.json`.
 * @param {string} dir
 * @returns {string | undefined}
 */
function packageRoot(dir) {
  if (packageRoots.has(dir)) return packageRoots.get(dir);
  const parent = path.posix.dirname(dir);
  const root = fs.existsSync(`${dir}/package.json`) ? dir : parent === dir ? undefined : packageRoot(parent);
  packageRoots.set(dir, root);

  return root;
}

const ManifestSchema = z.object({ name: z.string().optional(), private: z.boolean().optional(), workspaces: z.unknown().optional(), dependencies: z.record(z.string(), z.string()).optional() });

/**
 * The package.json at `dir`, or undefined when it is missing or unreadable.
 * @param {string} dir
 */
export function manifest(dir) {
  const file = `${dir}/package.json`;

  if (!fs.existsSync(file)) return undefined;
  const parsed = ManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));

  return parsed.success ? parsed.data : undefined;
}

/** @type {Map<string, string | undefined>} */
const roots = new Map();

/**
 * The nearest directory at or above `dir` whose package.json declares workspaces.
 * @param {string} dir
 * @returns {string | undefined}
 */
export function workspaceRoot(dir) {
  if (roots.has(dir)) return roots.get(dir);
  const parent = path.posix.dirname(dir);
  const root = manifest(dir)?.workspaces !== undefined ? dir : parent === dir ? undefined : workspaceRoot(parent);
  roots.set(dir, root);

  return root;
}

const ExportsSchema = z.object({ name: z.string(), exports: z.record(z.string(), z.unknown()).optional() });

/**
 * The file a workspace package specifier names through its package's exports map, from the repository root
 * (`@teamai/shared/home` -> `packages/shared/src/home.ts`, `@teamai/tool-core/formats/codex` through `./formats/*`);
 * undefined for any other specifier, and for a subpath the exports map does not name.
 * @param {string} root
 * @param {string} specifier
 * @returns {string | undefined}
 */
export function workspaceFile(root, specifier) {
  const dir = `${root}/packages`;

  for (const folder of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = `${dir}/${folder}/package.json`;

    if (!fs.existsSync(file)) continue;
    const parsed = ExportsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));

    if (!parsed.success || (specifier !== parsed.data.name && !specifier.startsWith(`${parsed.data.name}/`))) continue;
    const subpath = `.${specifier.slice(parsed.data.name.length)}`;

    for (const [key, value] of Object.entries(parsed.data.exports ?? {})) {
      const target = z.string().safeParse(value);

      if (!target.success) continue;
      const [prefix = '', suffix] = key.split('*');

      const matched = suffix === undefined
        ? (key === subpath ? target.data : undefined)
        : (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length
          ? target.data.replace('*', subpath.slice(prefix.length, subpath.length - suffix.length)) : undefined);

      if (matched !== undefined) return path.posix.join('packages', folder, matched);
    }

    return undefined;
  }

  return undefined;
}

/**
 * The linted file's path from its package root, so a checkout cloned under some `src/` directory does not count all its files as `src/`.
 * @param {Context} context
 * @returns {string}
 */
export function sourcePath(context) {
  const file = lintedPath(context);
  const root = packageRoot(path.posix.dirname(file));

  return root === undefined ? file : path.posix.relative(root, file);
}

/**
 * The linted file as `{ root, relative }`: the repository's directory (the workspace root, else the nearest package
 * root) and the file's path from it, so `packages/<name>/src/x.ts` keeps its package folder.
 * @param {Context} context
 * @returns {{ root: string, relative: string }}
 */
export function repositoryPath(context) {
  const file = lintedPath(context);
  const dir = path.posix.dirname(file);
  const root = workspaceRoot(dir) ?? packageRoot(dir) ?? path.posix.dirname(file);

  return { root, relative: path.posix.relative(root, file) };
}

/**
 * Whether `file`, relative to the workspace root, is test support: under `src/testing/` of the root package or of a
 * `packages/<name>/` folder, the harness its tests run, which `teamai/package-boundaries` keeps everything that ships
 * from importing.
 * @param {string} file
 * @returns {boolean}
 */
export function isTestSupportPath(file) {
  return /^(?:packages\/[^/]+\/)?src\/testing\//.test(file);
}

/**
 * Whether the linted file is test support (see {@link isTestSupportPath}).
 * @param {Context} context
 * @returns {boolean}
 */
export function inTestSupport(context) {
  return isTestSupportPath(sourcePath(context));
}

/**
 * Whether `file`, from the repository root, is production source: under `src/` of its package or of a `packages/<name>/` folder, outside `src/__tests__/`, and not a test beside its source.
 * @param {string} file
 * @returns {boolean}
 */
export function isProductionSource(file) {
  const relative = file.replace(/^packages\/[^/]+\//, '');

  return relative.startsWith('src/') && !relative.startsWith('src/__tests__/') && !/\.test\.[cm]?[jt]sx?$/.test(relative);
}

/**
 * Whether `file`, from the repository root, is repository tooling under `scripts/`, outside its tests: it runs the
 * product's own modules (the documentation generator, the verify world), so a rule that holds for production holds there.
 * @param {string} file
 * @returns {boolean}
 */
export function isScriptSource(file) {
  return file.startsWith('scripts/') && !/\.test\.[cm]?[jt]sx?$/.test(file);
}

/**
 * Whether the linted file is production source ({@link isProductionSource}).
 * @param {Context} context
 * @returns {boolean}
 */
export function inProductionSource(context) {
  return isProductionSource(sourcePath(context));
}

/**
 * The repository files a rule is scoped to. A rename throws when lint loads the rule, instead of leaving it guarding nothing.
 * @param {readonly string[]} files relative to the repository root
 * @returns {readonly string[]}
 */
export function scopedFiles(files) {
  const missing = files.filter((file) => !fs.existsSync(new URL(`../${file}`, import.meta.url)));

  if (missing.length > 0) throw new Error(`Lint rule scope file missing: ${missing.join(', ')}. Point the rule at the file's new path.`);

  return files;
}

/**
 * The text of a string literal; undefined for any other node, and for a number, boolean, null, bigint or RegExp literal.
 * @param {ESTree.Node | null | undefined} node
 * @returns {string | undefined}
 */
export function stringLiteralValue(node) {
  // oxlint-disable-next-line teamai/no-runtime-typeof -- an ESTree Literal's value is a string, number, boolean, null, bigint or RegExp, and typeof is how ESTree tells them apart
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

/**
 * What `name` names where `node` uses it: the variable it resolves to from the innermost scope around `node` outwards,
 * or undefined for a name nothing in the file binds.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 * @param {string} name
 */
export function variableOf(sourceCode, node, name) {
  /** @type {import('@oxlint/plugins').Scope | null} */
  let scope = sourceCode.getScope(node);

  for (; scope; scope = scope.upper) {
    const variable = scope.set.get(name);

    if (variable) return variable;
  }

  return undefined;
}
