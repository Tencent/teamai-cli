import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { isIdentifier } from '@babel/types';

/** Literal codes stay owned by their runtime declarations, including LIMIT_FAILURES. */
/** @param {string} file @param {string} name */
function policyArray(file, name) {
  const source = fs.readFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), 'utf8');

  const declarations = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body
    .map((statement) => statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement)
    .flatMap((statement) => statement?.type === 'VariableDeclaration' ? statement.declarations : []);

  const declaration = declarations.find((candidate) => isIdentifier(candidate.id, { name }));
  const initializer = declaration?.init;
  const array = initializer?.type === 'TSAsExpression' ? initializer.expression : initializer;

  if (array?.type !== 'ArrayExpression') throw new Error(`Failure-code policy cannot read ${name} in ${file}. Keep its literal array declaration available to lint.`);

  return array;
}

/** @param {string} file @param {string} name @returns {string[]} */
function literalStrings(file, name) {
  return policyArray(file, name).elements.flatMap((element) => {
    if (element?.type === 'StringLiteral') return [element.value];

    if (element?.type === 'SpreadElement' && element.argument.type === 'Identifier' && element.argument.name === 'LIMIT_FAILURES') return literalStrings('src/workflow/requirements.ts', 'LIMIT_FAILURES');
    throw new Error(`Failure-code policy cannot resolve a nonliteral entry in ${name}.`);
  });
}

const diagnostics = ['unknown_key', 'missing_needs', 'false_if', 'bad_template', 'dotted_name', 'undeclared_output', 'undeclared_end', 'bad_loop', 'bad_workspace', 'bad_role', 'workflow_namespace_conflict', 'prompt_namespace_conflict', 'benchmark_namespace_conflict', 'bad_delivery', 'bad_invoke', 'bad_alias', 'alias_conflict', 'workflow_folder_invalid',
  // Why pull refuses a team file that would replace a default its contract guards.
  'default_override_alias', 'score_override_contract', 'score_override_command', 'score_override_workflow_step', 'score_override_prompt',
  'score_override_confined_dir', 'score_override_judge_prompt', 'score_override_step_missing', 'score_override_publish',
  // Why pull refuses a step that runs teamai-score or teamai-finished-sessions and lists scorers.
  'judging_scored'];

const answers = [...literalStrings('src/workflow/failure-codes.ts', 'FAILURE_CODES'), ...literalStrings('src/scorers/label.ts', 'JUDGE_FAILURES')];

/** Every recognized producer code, including diagnostics and command-only refusals. */
export const KNOWN_FAILURE_CODES = new Set([...diagnostics, ...answers]);

/** The string constants `@teamai/runtime-protocol` exports, by name, such as `CANCEL_FAILED`: a code a step may take from it. */
export const PROTOCOL_STRING_CONSTANTS = new Map(
  parse(fs.readFileSync(fileURLToPath(new URL('../packages/runtime-protocol/src/protocol.ts', import.meta.url)), 'utf8'), { sourceType: 'module', plugins: ['typescript'] }).program.body
    .flatMap((statement) => (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration' ? statement.declaration.declarations : []))
    .flatMap((declaration) => (isIdentifier(declaration.id) && declaration.init?.type === 'StringLiteral' ? [[declaration.id.name, declaration.init.value]] : [])),
);
