/** @import { ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { isIdentifier, traverseFast } from '@babel/types';
import { stringLiteralValue, variableOf } from './utils.js';

/**
 * The name `specifier` imports: `default` for a default import, `*` for a namespace import.
 * @param {ESTree.ImportDeclaration['specifiers'][number]} specifier
 */
export function importedName(specifier) {
  if (specifier.type === 'ImportDefaultSpecifier') return 'default';

  if (specifier.type === 'ImportNamespaceSpecifier') return '*';

  return specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);
}

/**
 * Whether `node` names export `name` of one of `modules`: read off any object as `.name`, or a name imported from one
 * of them as `name`. Undefined for a name no import binds, which each rule judges by its own policy.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 * @param {{ modules: ReadonlySet<string>; name: string }} exported
 * @returns {boolean | undefined}
 */
export function namesExport(sourceCode, node, { modules, name }) {
  if (node.type === 'MemberExpression') return !node.computed && node.property.type === 'Identifier' && node.property.name === name;

  if (node.type !== 'Identifier') return false;
  const def = variableOf(sourceCode, node, node.name)?.defs[0];

  if (def?.type !== 'ImportBinding') return undefined;

  return def.node.type === 'ImportSpecifier' && def.parent?.type === 'ImportDeclaration' && modules.has(String(def.parent.source.value)) && importedName(def.node) === name;
}

/** @param {ESTree.ExportNamedDeclaration['specifiers'][number]} specifier */
function exportedName(specifier) {
  return specifier.local.type === 'Identifier' ? specifier.local.name : String(specifier.local.value);
}

/** @param {ESTree.CallExpression} node */
function mockedModule(node) {
  const callee = node.callee;
  const source = node.arguments[0];

  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || callee.object.name !== 'vi'
    || callee.property.type !== 'Identifier' || callee.property.name !== 'mock') return undefined;

  return stringLiteralValue(source);
}

/**
 * The module a dynamic import or a `require` names: a string literal, or a template literal with no placeholder.
 * @param {ESTree.Node | undefined} node
 * @returns {string | undefined}
 */
function moduleName(node) {
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;

  return stringLiteralValue(node);
}

/**
 * The names `const { a, b: c } = await import(...)` takes from the module; undefined for any other use of the
 * module, a rest element or a computed key included, which may read any of its names.
 * @param {ESTree.ImportExpression} node
 * @returns {string[] | undefined}
 */
function destructuredNames(node) {
  const awaited = node.parent;
  const declarator = awaited?.type === 'AwaitExpression' ? awaited.parent : undefined;

  if (declarator?.type !== 'VariableDeclarator' || declarator.init !== awaited || declarator.id.type !== 'ObjectPattern') return undefined;
  /** @type {string[]} */
  const names = [];

  for (const property of declarator.id.properties) {
    if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier') return undefined;
    names.push(property.key.name);
  }

  return names;
}

/**
 * Every import syntax the workflow policy owns: static imports and re-exports, TypeScript's `import x = require()`,
 * `import()`, `require()` and vi.mock. `computed` gets an `import()` or `require()` whose module name is computed, which
 * `visit` cannot be given.
 */
export function importVisitors(
  /** @type {(edge: { node: ESTree.Node; specifier: string; typeOnly: boolean; names: string[] }) => void} */ visit,
  /** @type {(node: ESTree.Node) => void} */ computed = () => {},
) {
  return {
    /** @param {ESTree.ImportDeclaration} node */
    ImportDeclaration(node) {
      const names = node.specifiers.map(importedName);
      visit({ node, specifier: String(node.source.value), typeOnly: node.importKind === 'type', names });
    },
    /** @param {ESTree.ExportNamedDeclaration} node */
    ExportNamedDeclaration(node) {
      if (node.source) visit({ node, specifier: String(node.source.value), typeOnly: node.exportKind === 'type', names: node.specifiers.map(exportedName) });
    },
    /** @param {ESTree.ExportAllDeclaration} node */
    ExportAllDeclaration(node) {
      visit({ node, specifier: String(node.source.value), typeOnly: node.exportKind === 'type', names: ['*'] });
    },
    /** @param {ESTree.TSImportEqualsDeclaration} node */
    TSImportEqualsDeclaration(node) {
      // `import x = Space.name` aliases a namespace; only `require('...')` names a module.
      if (node.moduleReference.type !== 'TSExternalModuleReference') return;
      visit({ node, specifier: String(node.moduleReference.expression.value), typeOnly: node.importKind === 'type', names: ['*'] });
    },
    /** @param {ESTree.ImportExpression} node */
    ImportExpression(node) {
      const specifier = moduleName(node.source);

      if (specifier === undefined) computed(node);
      else visit({ node, specifier, typeOnly: false, names: destructuredNames(node) ?? ['*'] });
    },
    /** @param {ESTree.CallExpression} node */
    CallExpression(node) {
      const mocked = mockedModule(node);

      if (mocked !== undefined) visit({ node, specifier: mocked, typeOnly: false, names: ['*'] });

      if (node.callee.type !== 'Identifier' || node.callee.name !== 'require' || node.arguments.length === 0) return;
      const required = moduleName(node.arguments[0]);

      if (required === undefined) computed(node);
      else visit({ node, specifier: required, typeOnly: false, names: ['*'] });
    },
  };
}

/** Resolve source imports without requiring a built dist directory. */
export function sourceImport(/** @type {string} */ from, /** @type {string} */ specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const stem = path.resolve(path.dirname(from), specifier).replace(/\.[cm]?js$/, '');

  return [stem + '.ts', stem + '.tsx', path.join(stem, 'index.ts')].find((candidate) => fs.existsSync(candidate));
}

/** @type {Map<string, { source: string; specifiers: string[] }>} */
const dependencyCache = new Map();

/** @param {import('@babel/types').Node} node */
function dynamicModule(node) {
  if (node.type === 'ImportExpression' && node.source.type === 'StringLiteral') return node.source.value;

  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return undefined;
  const { object, property } = node.callee;
  const literal = node.arguments[0];

  return isIdentifier(object, { name: 'vi' }) && isIdentifier(property, { name: 'mock' }) && literal?.type === 'StringLiteral'
    ? literal.value : undefined;
}

/** @param {import('@babel/types').Statement} statement @param {boolean} includeTypes */
function staticModule(statement, includeTypes) {
  if (statement.type === 'ImportDeclaration') return includeTypes || statement.importKind !== 'type' ? statement.source.value : undefined;

  if (statement.type === 'TSImportEqualsDeclaration') {
    const reference = statement.moduleReference;

    return reference.type === 'TSExternalModuleReference' && (includeTypes || statement.importKind !== 'type') ? reference.expression.value : undefined;
  }

  if (statement.type !== 'ExportNamedDeclaration' && statement.type !== 'ExportAllDeclaration') return undefined;

  return includeTypes || statement.exportKind !== 'type' ? statement.source?.value : undefined;
}

/**
 * The modules `file` loads with a dynamic `import()` of a string, anywhere in it.
 * @param {string} file
 * @returns {string[]}
 */
export function dynamicImports(file) {
  const program = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', createImportExpressions: true, plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] }).program;
  /** @type {string[]} */
  const specifiers = [];

  traverseFast(program, (node) => {
    if (node.type === 'ImportExpression' && node.source.type === 'StringLiteral') specifiers.push(node.source.value);
  });

  return specifiers;
}

/**
 * The modules `file` imports at its top level, its type-only imports too when `includeTypes`, and with them its dynamic
 * imports and vi.mock calls.
 * @param {string} file @param {boolean} includeTypes
 */
export function sourceModules(file, includeTypes) {
  const source = fs.readFileSync(file, 'utf8');
  const key = `${file}:${includeTypes}`;
  const cached = dependencyCache.get(key);

  if (cached?.source === source) return cached.specifiers;
  const program = parse(source, { sourceType: 'module', createImportExpressions: true, plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] }).program;
  /** @type {string[]} */
  const specifiers = [];

  for (const statement of program.body) {
    const specifier = staticModule(statement, includeTypes);

    if (specifier !== undefined) specifiers.push(specifier);
  }

  if (includeTypes) traverseFast(program, (node) => {
    const specifier = dynamicModule(node);

    if (specifier !== undefined) specifiers.push(specifier);
  });
  dependencyCache.set(key, { source, specifiers });

  return specifiers;
}

/** Follow a source graph with the declared TypeScript parser, caching dependencies for this lint process. */
export function reachesSource(/** @type {string} */ from, /** @type {(file: string) => boolean} */ forbidden, includeTypes = true) {
  const seen = new Set();

  /** @param {string} file @returns {string | undefined} */
  function follow(file) {
    if (forbidden(file)) return file;

    if (seen.has(file)) return undefined;
    seen.add(file);

    for (const specifier of new Set(sourceModules(file, includeTypes))) {
      const dependency = sourceImport(file, specifier);

      if (!dependency) continue;
      const reached = follow(dependency);

      if (reached) return reached;
    }

    return undefined;
  }

  return follow(from);
}
