/** @import { Context } from '@oxlint/plugins' */

import { defineRule } from '@oxlint/plugins';

import { isOneOf } from '../utils.js';

/** The Windows CI allow-list maintained in src/__tests__/helpers/windows-tests.ts. */
// This is kept equal to WINDOWS_TESTS by windows-test-list.test.ts. The plugin
// runs under plain Node, so it cannot import the TypeScript source list directly.
export const WINDOWS_TEST_FILES = [
  'src/__tests__/buddy-windows-cwd.test.ts',
  'src/__tests__/builtin-hooks.test.ts',
  'src/__tests__/codex-hook-rules.test.ts',
  'src/__tests__/codex-team-hooks.test.ts',
  'src/__tests__/cursor-tool-roots.test.ts',
  'src/__tests__/dsh-hooks.test.ts',
  'src/__tests__/hermes-config.test.ts',
  'src/__tests__/hermes-hooks.test.ts',
  'src/__tests__/home-normalize.test.ts',
  'src/__tests__/hooks-golden.test.ts',
  'src/__tests__/hooks-shell-check.test.ts',
  'src/__tests__/hooks-skill-retire.test.ts',
  'src/__tests__/hooks-windows-bash.test.ts',
  'src/__tests__/installed-launcher-readiness.test.ts',
  'src/__tests__/joycode.test.ts',
  'src/__tests__/locate-agents.test.ts',
  'src/__tests__/locate-blocks.test.ts',
  'src/__tests__/locate-hooks.test.ts',
  'src/__tests__/locate-matrix.test.ts',
  'src/__tests__/locate-mcp.test.ts',
  'src/__tests__/locate-rules.test.ts',
  'src/__tests__/locate-sessions.test.ts',
  'src/__tests__/locate-workbuddy.test.ts',
  'src/__tests__/locate.test.ts',
  'src/__tests__/pi-adapter.test.ts',
  'src/__tests__/qoder-cn.test.ts',
  'src/__tests__/skill-use.test.ts',
  'src/__tests__/tool-roots.test.ts',
  'src/__tests__/tools-channels.test.ts',
  'src/__tests__/tools.test.ts',
  'src/__tests__/trae.test.ts',
  'src/__tests__/user-home-resolution.test.ts',
  'src/__tests__/windows-test-list.test.ts',
];

const SHELLS = new Set(['sh', 'bash', 'zsh']);
const SHELL_COMMAND = /^(?:ba|z)?sh(?:\s|$)/;
const POSIX_APIS = new Set(['chmod', 'chmodSync', 'symlink', 'symlinkSync']);
const SHEBANG = /#!\/(?:usr\/)?bin\//;
const BASH_LC = /\bbash -lc\b/;
const SH_C = /\bsh -c\b/;
const BASH_RENDERING_GUARD = /vi\.spyOn\(process,\s*['"]platform['"]|\bcommandWindows\b/;

/** @param {any} node */
function literalText(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

/** @param {any} callee */
function calleeName(callee) {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') return callee.property.name;
  return undefined;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Keep the Windows CI test allow-list free of unguarded POSIX-only operations.' },
  },
  create(context) {
    if (!isOneOf(context, WINDOWS_TEST_FILES)) return {};
    return {
      Program(node) {
        const source = context.sourceCode.text;
        if (SHEBANG.test(source)) {
          context.report({ node, message: 'Windows test allow-list must not contain a POSIX shebang fixture.' });
        }
        if (SH_C.test(source)) {
          context.report({ node, message: 'Windows test allow-list must not contain a sh -c rendering.' });
        }
        if (BASH_LC.test(source) && !BASH_RENDERING_GUARD.test(source)) {
          context.report({ node, message: 'Windows test allow-list must platform-pin a bash -lc rendering or provide commandWindows.' });
        }
      },
      /** @param {any} node */
      CallExpression(node) {
        const expression = /** @type {any} */ (node);
        const name = calleeName(expression.callee);
        const args = expression.arguments ?? [];
        const first = literalText(args[0]);
        if (name === 'exec' || name === 'execSync') {
          if (first !== undefined && SHELL_COMMAND.test(first)) {
            context.report({ node, message: `Windows test allow-list must not execute POSIX shell command ${first}; use a platform-pinned fixture or a Windows-safe command.` });
          }
          return;
        }
        if ((name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') && SHELLS.has(first)) {
          context.report({ node, message: `Windows test allow-list must not spawn POSIX shell ${first}; use a platform-pinned fixture or a Windows-safe command.` });
          return;
        }
        if (name && POSIX_APIS.has(name)) {
          context.report({ node, message: `Windows test allow-list must not call POSIX-only ${name}(); move it to a non-Windows test or guard the platform-specific operation.` });
        }
      },
    };
  },
});