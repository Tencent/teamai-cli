import fs from 'node:fs';
import path from 'node:path';
import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';

import { importVisitors } from '../imports.js';
import { lintedPath } from '../utils.js';

const ManifestSchema = z.object({ name: z.string().optional(), private: z.boolean().optional(), workspaces: z.unknown().optional() });

/**
 * The package.json at `dir`, or undefined when it is missing or unreadable.
 * @param {string} dir
 */
function manifest(dir) {
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
function workspaceRoot(dir) {
  if (roots.has(dir)) return roots.get(dir);
  const parent = path.posix.dirname(dir);
  const root = manifest(dir)?.workspaces !== undefined ? dir : parent === dir ? undefined : workspaceRoot(parent);
  roots.set(dir, root);

  return root;
}

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

    if (own === undefined && !inApp) return {};

    return {
      Program(node) {
        if (own !== undefined && manifest(`${root}/packages/${own}`)?.private !== true) {
          context.report({ node, message: `A workspace package is private: set "private": true in packages/${own}/package.json, so it ships only inside teamai-cli.` });
        }
      },
      ...importVisitors(({ node, specifier }) => {
        if (specifier.startsWith('.')) {
          const to = path.posix.relative(root, path.posix.resolve(path.posix.dirname(file), specifier));
          const target = packageFolder(to);

          if (target === own) return;

          if (target === undefined) {
            context.report({ node, message: `A workspace package imports only its own files and other workspace packages by name, never src/ or other repository files: ${from} -> ${to}.` });
          } else {
            const name = [...packagesByName(root)].find(([, folder]) => folder === target)?.[0] ?? `the name in packages/${target}/package.json`;
            context.report({ node, message: `Import a workspace package by its package name, so only its exports map is reachable: ${from} -> ${to}. Use '${name}'.` });
          }

          return;
        }

        if (!inApp) return;

        for (const [name, folder] of packagesByName(root)) {
          if ((specifier === name || specifier.startsWith(`${name}/`)) && folder.startsWith('runtime-')) {
            context.report({ node, message: `src/ never imports a runtime package: teamai reaches a runtime only through its executable over stdio. ${from} -> ${specifier}.` });
          }
        }
      }),
    };
  },
});
