import { expect } from 'vitest';
import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/configured-tool-paths', { filename: 'src/pull.ts' });
rule.invalid('rejects configured skill joins outside locate', `import path from 'node:path'; const root = path.join(base, toolPath.skills);`);
rule.invalid('rejects a configured join in a repository script', `import path from 'node:path'; const root = path.join(base, toolPath.skills);`, undefined, { filename: 'scripts/verify/world.ts' });
rule.valid('allows a configured join in a script\'s test', `import path from 'node:path'; const root = path.join(base, toolPath.skills);`, { filename: 'scripts/check-docs.test.ts' });
rule.valid('allows strings that merely mention configured fields', `const root = path.join(base, 'example.skills');`);
rule.invalid('rejects named joins and optional nested configured rules', `import { join } from 'node:path'; const root = join(resolve(base), tool?.rules);`);
rule.invalid('rejects configured claudemd and computed fields', `const root = path.resolve(base, tool['claudemd']);`);
rule.invalid('rejects a settings file joined to a home by hand', `import path from 'node:path'; const file = path.join(baseDir, paths.settings);`, (output) => {
  expect(output).toContain('toolPathUnder');
});
rule.invalid('rejects agents, hooks and mcp joins through a host path module', `const dir = host.path.join(base, paths.agents); const file = at.path.resolve(base, paths.hooks, paths.mcp);`);
rule.invalid('rejects a configured path first read into a variable', `import path from 'node:path'; function f(paths) { const settings = paths.settings; return path.join(baseDir, settings); }`, (output) => {
  expect(output).toContain('settings path');
});
rule.invalid('rejects a configured path destructured before the join', `import path from 'node:path'; const { skills } = toolPaths.claude; const dir = path.join(home, skills);`);
rule.valid('allows a variable that holds no configured path', `import path from 'node:path'; const name = paths.label; const file = path.join(base, name);`);
rule.valid('allows a variable reassigned after a configured path, which the rule cannot follow', `import path from 'node:path'; let file = paths.settings; file = 'settings.local.json'; const at = path.join(base, file);`);
rule.valid('allows a path the one resolver gives', `const file = toolPathUnder(tool, baseDir, paths.settings);`);
rule.valid('allows the locate owner', `const root = path.join(base, tool.skills);`, { filename: 'src/locate.ts' });
rule.valid('allows literal directory names', `const root = path.join(base, 'skills');`);
rule.valid('allows test fixtures', `const root = path.join(base, tool.skills);`, { filename: 'src/__tests__/locate.test.ts' });
rule.valid('allows explained exceptions', `// oxlint-disable-next-line teamai/configured-tool-paths -- compares an old installed path
const root = path.join(base, tool.skills);`);
rule.valid('scopes to src/ of the checkout, not of a parent directory', `import path from 'node:path'; const root = path.join(base, toolPath.skills);`, { filename: 'src/teamai-cli/website/check.ts', files: { 'src/teamai-cli/package.json': '{}' } });
