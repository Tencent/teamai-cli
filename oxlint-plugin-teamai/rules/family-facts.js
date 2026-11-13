import fs from 'node:fs';
import path from 'node:path';
import { defineRule } from '@oxlint/plugins';
import { dynamicImports, importVisitors, sourceImport, sourceModules } from '../imports.js';
import { z } from 'zod';
import { FAMILY, lintedPath, scopedFiles, sourcePath, workspaceFile, workspaceRoot } from '../utils.js';

/**
 * The facts modules outside a family: the list of every family's facts and the app modules that read only facts. A
 * family's own `src/facts.ts`, `src/definitions.ts` and `src/detect.ts` are facts modules too, in any `tool-<name>`
 * package (FAMILY), with no edit here. Paths are from the repository root.
 */
export const FACTS_FILES = new Set(scopedFiles([
  'packages/tool-definitions/src/facts.ts',
  'packages/tool-core/src/definition.ts',
  'src/tools.ts',
  'src/session-flow/adapters/platform-facts.ts',
]));

/**
 * The CLI commands an agent waits on, as it waits on startup: the one every hook a tool runs starts with
 * (`teamai hook-dispatch <event>`, builtin-hooks.ts), and `teamai pull`, which an agent runs in its session.
 */
const WAITED_COMMANDS = ['hook-dispatch', 'pull'];

/**
 * A step runtime's own executable, which exists to launch tools and so loads their behaviour: it is no command or hook
 * an agent waits on. Any other executable is a startup entry.
 */
const RUNTIME_EXECUTABLE = /^packages\/runtime-[^/]+\/src\/main\.ts$/;

/** package.json's `bin`: one executable named after the package, or a name for each. */
const ManifestSchema = z.object({ bin: z.union([z.string().transform((one) => ({ [one]: one })), z.record(z.string(), z.string())]).default({}) });

/** @type {Map<string, { entries: Set<string>; waited: Set<string> }>} */
const startups = new Map();

/**
 * The modules that load before a command or a hook does anything, read from what the tree records, from the root
 * `root`: each executable's source (package.json `bin`, through tsup.config.ts `entry`) but a step runtime's, each
 * bundle such an executable loads by URL (the CLI), each module the CLI's hook and pull commands load, and each module
 * one of those loads with `import()` before it answers. A new executable, bundle, hook step or pull step is one of them
 * with no edit here. Paths are from the root.
 * @param {string} root
 * @returns {Set<string>}
 */
export function startupEntries(root) {
  return startupsOf(root).entries;
}

/**
 * The startup entries of `root`, and among them the modules a waited command loads, whose own `import()`s run before
 * it answers.
 * @param {string} root
 */
function startupsOf(root) {
  const known = startups.get(root);

  if (known !== undefined) return known;
  const read = (/** @type {string} */ file) => (fs.existsSync(path.posix.join(root, file)) ? fs.readFileSync(path.posix.join(root, file), 'utf8') : '');

  const { bin } = ManifestSchema.parse(JSON.parse(read('package.json') || '{}'));
  // tsup.config.ts names one bundle per line in `entry`: `<bundle>: '<source>'`.
  const entry = /\bentry:\s*\{([^}]*)\}/.exec(read('tsup.config.ts'))?.[1] ?? '';
  const bundles = new Map([...entry.matchAll(/^\s*'?([\w-]+)'?:\s*'([^']+)'/gm)].map(([, name = '', source = '']) => [name, source]));

  /** @type {string[]} */
  const executables = [];

  for (const output of Object.values(bin)) {
    const source = bundles.get(path.posix.basename(output, '.js'));

    if (source === undefined) throw new Error(`teamai/family-facts: package.json bin ${output} names no entry of tsup.config.ts, so the rule cannot find the module it starts. Name its source there.`);

    if (!RUNTIME_EXECUTABLE.test(source)) executables.push(source);
  }

  // A bundle an executable loads by URL beside itself, as bin.ts loads the CLI.
  const clis = executables.flatMap((source) => [...read(source).matchAll(/new URL\('\.\/([\w-]+)\.js'/g)].flatMap(([, name = '']) => bundles.get(name) ?? []));
  const entries = new Set([...executables, ...clis]);
  /** @type {Set<string>} */
  const waited = new Set();

  for (const command of clis.length === 0 ? [] : WAITED_COMMANDS) {
    const found = clis.flatMap((cli) => {
      const text = read(cli);
      // The name ends at its arguments or its quote, so `pull` is not `pull-requests`.
      const at = text.search(new RegExp(`\\.command\\(['"\`]${command}[ '"\`]`));

      if (at === -1) return [];
      // The command's own block: up to the next command the CLI declares.
      const next = text.indexOf('.command(', at + 1);

      return [{ cli, block: text.slice(at, next === -1 ? undefined : next) }];
    });

    if (found.length === 0) throw new Error(`teamai/family-facts: ${clis.join(', ')} declares no ${command} command, so the rule cannot find what an agent waits on there. Declare it as .command('${command}'), or update WAITED_COMMANDS.`);
    const loaded = found.flatMap(({ cli, block }) => [...block.matchAll(/import\((['"`])(\.[^'"`]+)\1\)/g)].flatMap(([, , specifier = '']) => sourceImport(path.posix.join(root, cli), specifier) ?? []));

    if (loaded.length === 0) throw new Error(`teamai/family-facts: its ${command} command loads no module with import() in ${found.map(({ cli }) => cli).join(', ')}, so the rule cannot find what an agent waits on there. Load the command's module with import('./<module>.js') in its action.`);

    for (const module of loaded) {
      const relative = path.posix.relative(root, module);
      entries.add(relative);
      waited.add(relative);

      // What that module loads before it answers, such as the session captures of a SessionStart.
      for (const step of dynamicImports(module)) {
        const file = resolved(root, relative, step);

        if (file !== undefined) entries.add(file);
      }
    }
  }

  const found = { entries, waited };
  startups.set(root, found);

  return found;
}

/**
 * Whether `relative`, from the repository root, is a facts module: data a tool family declares, which loads nothing
 * else of the family.
 * @param {string} relative
 */
export function isFactsModule(relative) {
  const family = /^packages\/([^/]+)\/src\/(facts|definitions|detect)\.ts$/.exec(relative)?.[1];

  return FACTS_FILES.has(relative) || (family !== undefined && FAMILY.test(family));
}

/**
 * Whether `relative` is a family's behaviour: any other module of a family package, or of the list of families
 * (`@teamai/tool-definitions`), whose session adapters, launch profiles, token readers and schemas cost every command
 * that loads them.
 * @param {string} relative
 */
function isFamilyBehaviour(relative) {
  const folder = /^packages\/([^/]+)\/src\//.exec(relative)?.[1];

  return folder !== undefined && (FAMILY.test(folder) || folder === 'tool-definitions') && !isFactsModule(relative) && !relative.endsWith('.test.ts');
}

/**
 * The module a non-type import of `from` names, from the repository root: a relative path or a workspace package's
 * export. Undefined for a dependency or a node: module.
 * @param {string} root
 * @param {string} from
 * @param {string} specifier
 */
function resolved(root, from, specifier) {
  if (specifier.startsWith('.')) {
    const file = sourceImport(path.posix.join(root, from), specifier);

    return file === undefined ? undefined : path.posix.relative(root, file);
  }

  return specifier.startsWith('@teamai/') ? workspaceFile(root, specifier) : undefined;
}

/**
 * The chain of static, non-type imports from `start` to the first family behaviour module it reaches, or undefined.
 * `seen` is shared across the entry's imports, so a module is followed once per lint of the entry.
 * @param {string} root
 * @param {string} start
 * @param {Set<string>} seen
 * @returns {string[] | undefined}
 */
function chainToBehaviour(root, start, seen) {
  /** @type {Map<string, string | undefined>} */
  const previous = new Map([[start, undefined]]);
  const queue = [start];

  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (isFamilyBehaviour(file)) {
      const chain = [];

      for (let step = /** @type {string | undefined} */ (file); step !== undefined; step = previous.get(step)) chain.unshift(step);

      return chain;
    }

    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of new Set(sourceModules(path.posix.join(root, file), false))) {
      const next = resolved(root, file, specifier);

      if (next !== undefined && !previous.has(next)) {
        previous.set(next, file);
        queue.push(next);
      }
    }
  }

  return undefined;
}

const FIX = 'Read a family at startup only through its facts (@teamai/tool-definitions/facts), and load its behaviour with a dynamic import() where it is first needed.';

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Startup, the hook dispatch, pull and the facts modules load a tool family\'s facts only, never its session adapters, launch profiles, token readers or schemas.' } },
  create(context) {
    const file = lintedPath(context);
    const root = workspaceRoot(path.posix.dirname(file));
    const from = root === undefined ? sourcePath(context) : path.posix.relative(root, file);

    if (isFactsModule(from)) {
      return importVisitors(({ node, specifier, typeOnly }) => {
        if (typeOnly) return;
        const to = root === undefined ? undefined : resolved(root, from, specifier);

        if (to !== undefined && isFactsModule(to)) return;
        context.report({
          node,
          message: `${from} is a facts module (oxlint-plugin-teamai/rules/family-facts.js), which every command loads, so it imports only other facts modules: `
            + `a family's src/facts.ts, src/definitions.ts and src/detect.ts, and FACTS_FILES. ${specifier} is not one. Move the data it needs into a facts module, or read it where the behaviour is loaded.`,
        });
      });
    }

    const startup = root === undefined ? undefined : startupsOf(root);

    if (root === undefined || startup === undefined || !startup.entries.has(from)) return {};
    const seen = new Set();

    return importVisitors(({ node, specifier, typeOnly }) => {
      // A waited command's module loads what it imports with import() before it answers: a family's behaviour among it
      // is loaded there. What such a module imports itself is held when it is linted, as a startup entry.
      if (typeOnly || (node.type === 'ImportExpression' && !startup.waited.has(from))) return;
      const to = resolved(root, from, specifier);

      if (node.type === 'ImportExpression' && (to === undefined || !isFamilyBehaviour(to))) return;
      const chain = to === undefined ? undefined : chainToBehaviour(root, to, seen);

      if (chain === undefined) return;
      context.report({
        node,
        message: `${from} loads at startup or before a hook or pull an agent waits on ends, and through ${specifier} it loads a tool family's behaviour there: ${[from, ...chain].join(' -> ')}. ${FIX}`,
      });
    });
  },
});
