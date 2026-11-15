/** @import { ESTree } from '@oxlint/plugins' */
import { importedName } from './imports.js';
import { variableOf } from './utils.js';

/** The modules a file is opened from. */
export const FS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra']);

/**
 * The module `variable` imports, and the name it imports from it (`default` or `*` for the module itself); undefined
 * when it is no import.
 * @param {import('@oxlint/plugins').Variable | undefined} variable
 */
function importOf(variable) {
  const def = variable?.defs[0];

  if (def?.type !== 'ImportBinding' || def.parent?.type !== 'ImportDeclaration') return undefined;
  const { node } = def;

  if (node.type !== 'ImportSpecifier' && node.type !== 'ImportDefaultSpecifier' && node.type !== 'ImportNamespaceSpecifier') return undefined;

  return { from: String(def.parent.source.value), name: importedName(node) };
}

/**
 * The name `property` gives, as `fs.readFile` or `fs['readFile']` does; undefined for one computed at run time.
 * @param {ESTree.Node} member
 * @returns {string | undefined}
 */
function memberName(member) {
  if (member.type !== 'MemberExpression') return undefined;

  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : undefined;

  // oxlint-disable-next-line teamai/no-runtime-typeof -- an ESTree Literal's value is a string, number, boolean, null, bigint or RegExp, and typeof is how ESTree tells them apart
  return member.property.type === 'Literal' && typeof member.property.value === 'string' ? member.property.value : undefined;
}

/**
 * Whether `node` loads a file module at run time: `import('node:fs/promises')`, awaited or not, or `require('fs')`.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function loadsFsModule(node) {
  const loaded = node.type === 'AwaitExpression' ? node.argument : node;

  if (loaded.type === 'ImportExpression') return loaded.source.type === 'Literal' && FS.has(String(loaded.source.value));

  return loaded.type === 'CallExpression' && loaded.callee.type === 'Identifier' && loaded.callee.name === 'require'
    && loaded.arguments[0]?.type === 'Literal' && FS.has(String(loaded.arguments[0].value));
}

/**
 * The declarator `variable` is bound by, when it is a `const`/`let`/`var` with a value, and the pattern part that binds it.
 * @param {import('@oxlint/plugins').Variable | undefined} variable
 */
function declaredBy(variable) {
  const def = variable?.defs[0];

  return def?.type === 'Variable' && def.node.type === 'VariableDeclarator' && def.node.init ? { declarator: def.node, name: def.name } : undefined;
}

/**
 * Whether `node` is a file module itself: a default or namespace import of one, or its `promises`; one loaded at run
 * time; or a variable holding any of these.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
export function isFsModule(sourceCode, node) {
  if (node.type === 'MemberExpression') return memberName(node) === 'promises' && isFsModule(sourceCode, node.object);

  if (loadsFsModule(node)) return true;

  if (node.type !== 'Identifier') return false;
  const variable = variableOf(sourceCode, node, node.name);
  const imported = importOf(variable);

  if (imported !== undefined) return FS.has(imported.from) && (imported.name === 'default' || imported.name === '*' || imported.name === 'promises');
  const declared = declaredBy(variable);

  if (declared === undefined || declared.declarator.init === null || !isFsModule(sourceCode, declared.declarator.init)) return false;

  return declared.declarator.id.type === 'Identifier' || destructuredKey(declared) === 'promises';
}

/**
 * The key `declared.name` is destructured from in its declarator's object pattern: `promises` for
 * `const { promises: fsp } = fs`. Undefined for a computed key or a name the pattern does not bind.
 * @param {NonNullable<ReturnType<typeof declaredBy>>} declared
 * @returns {string | undefined}
 */
function destructuredKey(declared) {
  if (declared.declarator.id.type !== 'ObjectPattern') return undefined;

  const property = declared.declarator.id.properties.find((entry) => entry.type === 'Property'
    && (entry.value === declared.name || (entry.value.type === 'AssignmentPattern' && entry.value.left === declared.name)));

  return property?.type === 'Property' && !property.computed && property.key.type === 'Identifier' ? property.key.name : undefined;
}

/**
 * The file module function `callee` calls: `fs.open`, `fs['open']`, `fs.promises.open`, a named import of `open` from a
 * file module, and `open` destructured from one, under any local name, all give `open`. Undefined for any other callee.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} callee
 * @returns {string | undefined}
 */
export function fsFunctionOf(sourceCode, callee) {
  if (callee.type === 'MemberExpression') return isFsModule(sourceCode, callee.object) ? memberName(callee) : undefined;

  if (callee.type !== 'Identifier') return undefined;
  const variable = variableOf(sourceCode, callee, callee.name);
  const imported = importOf(variable);

  if (imported !== undefined) return FS.has(imported.from) && imported.name !== 'default' && imported.name !== '*' ? imported.name : undefined;
  const declared = declaredBy(variable);

  if (declared === undefined || declared.declarator.init === null || !isFsModule(sourceCode, declared.declarator.init)) return undefined;

  return destructuredKey(declared);
}

/** The `fs.constants` an open only reads with; any other constant, such as `O_WRONLY` or `O_CREAT`, counts as a write. */
const READ_FLAGS = new Set(['O_RDONLY', 'O_NONBLOCK', 'O_NOFOLLOW', 'O_NOATIME', 'O_CLOEXEC', 'O_DIRECTORY', 'O_SYNC', 'O_DSYNC']);

/**
 * The constant names `node` ORs together, such as `O_WRONLY` of `fs.constants.O_WRONLY`; undefined when any part is
 * not a named constant.
 * @param {ESTree.Node} node
 * @returns {string[] | undefined}
 */
function constantNames(node) {
  if (node.type === 'BinaryExpression' && node.operator === '|') {
    const left = constantNames(node.left);
    const right = constantNames(node.right);

    return left && right && [...left, ...right];
  }

  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? [node.property.name] : undefined;
}

/**
 * What an open with `flags`, its second argument, does: `read` with no flags, a string with no `w`, `a` or `+`, or only
 * read constants; `write` with a string with `w` or `a` and no `+`, or write constants without `O_RDWR`; `readwrite` with
 * a `+` or `O_RDWR`, whose handle reads as well; `unknown` for flags no source text says, which each rule counts as what
 * it guards, so both fail closed.
 * @param {ESTree.Node | undefined} flags
 * @returns {'read' | 'write' | 'readwrite' | 'unknown'}
 */
export function openKindOf(flags) {
  if (flags === undefined) return 'read';
  const text = flags.type === 'Literal' ? flags.value : undefined;

  // oxlint-disable-next-line teamai/no-runtime-typeof -- an ESTree Literal's value is a string, number, boolean, null, bigint or RegExp, and typeof is how ESTree tells them apart
  if (typeof text === 'string') return text.includes('+') ? 'readwrite' : /[wa]/.test(text) ? 'write' : 'read';
  const names = constantNames(flags);

  if (names === undefined) return 'unknown';

  if (names.includes('O_RDWR')) return 'readwrite';

  return names.every((name) => READ_FLAGS.has(name)) ? 'read' : 'write';
}

/**
 * Whether `node` is used as a value where it stands, rather than naming something: not an import, a declared name, a
 * property key, the object or property of a longer member access, or a type query.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
export function refersToValue(node) {
  const { parent } = node;

  switch (parent?.type) {
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': case 'TSTypeQuery': case 'TSQualifiedName':
      return false;
    case 'MemberExpression':
      return parent.object !== node && parent.computed;
    case 'Property':
      return parent.value === node && parent.parent?.type !== 'ObjectPattern';
    case 'VariableDeclarator':
      return parent.init === node;
    default:
      return true;
  }
}

/**
 * Whether `node`, a reference to a file module function, is that call's callee rather than the function passed on.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
export function isCalled(node) {
  return node.parent?.type === 'CallExpression' && node.parent.callee === node;
}

/**
 * Whether `node`, a reference, passes a file module on as a value: as an argument, a property, a return, an export or
 * anything else but a member access or a local alias, which `isFsModule` follows. A rule cannot see the reads and writes
 * made through it where it lands.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
export function passesOnFsModule(sourceCode, node) {
  if (!refersToValue(node) || !isFsModule(sourceCode, node)) return false;
  const { parent } = node;

  // `fs.promises` is followed as an alias of its own; only what is done with the whole access counts.
  if (parent?.type === 'MemberExpression' && parent.object === node) return false;

  return !(parent?.type === 'VariableDeclarator' && parent.init === node && parent.parent?.parent?.type !== 'ExportNamedDeclaration');
}

/**
 * Whether `node`, an export declaration, re-exports from a file module: any of its functions, or the module itself.
 * @param {ESTree.ExportNamedDeclaration | ESTree.ExportAllDeclaration} node
 * @returns {boolean}
 */
export function reExportsFsModule(node) {
  return node.source !== null && node.source !== undefined && FS.has(String(node.source.value));
}

/** What a rule says of a file module passed on or re-exported. */
export const PASSED_ON_MESSAGE = 'This re-exports or passes on a file module, so the reads and writes made through it are out of this rule\'s sight: a wrapper module or a function given the module would read a FIFO a step left without the rule seeing it. Use the module where it stands, or pass on a helper of @teamai/shared/regular-file.';
