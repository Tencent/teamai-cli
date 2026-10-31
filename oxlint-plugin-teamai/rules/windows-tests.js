import { defineRule } from '@oxlint/plugins';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { lintedPath } from '../utils.js';

const listFile = fileURLToPath(new URL('../../src/__tests__/helpers/windows-tests.ts', import.meta.url));
const list = parse(fs.readFileSync(listFile, 'utf8'), { sourceType: 'module', plugins: ['typescript'] }).program.body
  .filter((statement) => statement.type === 'ExportNamedDeclaration')
  .flatMap((statement) => statement.declaration?.type === 'VariableDeclaration' ? statement.declaration.declarations : [])
  .find((declaration) => declaration.id.type === 'Identifier' && declaration.id.name === 'WINDOWS_TESTS')?.init;
const files = list?.type === 'TSAsExpression' && list.expression.type === 'ArrayExpression'
  ? list.expression.elements.map((element) => {
    if (element?.type !== 'StringLiteral') throw new Error('WINDOWS_TESTS must contain literal test paths so lint and Windows CI share a scope.');
    return element.value;
  }) : [];
if (files.length === 0) throw new Error('WINDOWS_TESTS matched no files. Restore its literal test list before running lint.');

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep Windows-selected tests free of POSIX-only constructs.' } },
  create(context) {
    const file = lintedPath(context);
    if (!files.some((selected) => file.endsWith('/' + selected))) return {};
    const message = 'Windows-selected tests must not require POSIX shells, shebangs, chmod or symlinks. Use a portable fixture or remove the test from WINDOWS_TESTS.';
    const bashRenderingAllowed = /vi\.spyOn\(process, 'platform'|\bcommandWindows\b/.test(context.sourceCode.text);
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name = callee.type === 'Identifier' ? callee.name
          : callee.type === 'MemberExpression' && callee.property.type === 'Identifier' ? callee.property.name : undefined;
        const command = node.arguments[0];
        if (name && (/^(?:chmod|symlink)(?:Sync)?$/.test(name)
          || (/^(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?)$/.test(name) && command?.type === 'Literal' && typeof command.value === 'string' && /^(?:ba|z)?sh\b/.test(command.value)))) context.report({ node, message });
      },
      Literal(node) {
        if (typeof node.value === 'string' && (/#!\/(?:usr\/)?bin\/|\bsh -c\b/.test(node.value) || (!bashRenderingAllowed && /\bbash -lc\b/.test(node.value)))) context.report({ node, message });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((part) => /#!\/(?:usr\/)?bin\/|\bsh -c\b/.test(part.value.raw) || (!bashRenderingAllowed && /\bbash -lc\b/.test(part.value.raw)))) context.report({ node, message });
      },
    };
  },
});
