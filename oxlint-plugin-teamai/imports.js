/** @import { ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { isIdentifier, traverseFast } from '@babel/types';

/** @param {ESTree.ImportDeclaration['specifiers'][number]} specifier */
function importedName(specifier) {
  if (specifier.type === 'ImportDefaultSpecifier') return 'default';
  if (specifier.type === 'ImportNamespaceSpecifier') return '*';
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);
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
    || callee.property.type !== 'Identifier' || callee.property.name !== 'mock'
    || source?.type !== 'Literal' || typeof source.value !== 'string') return undefined;
  return source.value;
}

/** Every import syntax the workflow policy owns, including dynamic imports and vi.mock. */
export function importVisitors(/** @type {(edge: { node: ESTree.Node; specifier: string; typeOnly: boolean; names: string[] }) => void} */ visit) {
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
    /** @param {ESTree.ImportExpression} node */
    ImportExpression(node) {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') visit({ node, specifier: node.source.value, typeOnly: false, names: ['*'] });
    },
    /** @param {ESTree.CallExpression} node */
    CallExpression(node) {
      const specifier = mockedModule(node);
      if (specifier !== undefined) visit({ node, specifier, typeOnly: false, names: ['*'] });
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
  if (statement.type !== 'ExportNamedDeclaration' && statement.type !== 'ExportAllDeclaration') return undefined;
  return includeTypes || statement.exportKind !== 'type' ? statement.source?.value : undefined;
}

/** @param {string} file @param {boolean} includeTypes */
function sourceModules(file, includeTypes) {
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
