import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/configured-tool-paths', { filename: 'src/pull.ts' });
rule.invalid('rejects configured skill joins outside locate', `import path from 'node:path'; const root = path.join(base, toolPath.skills);`);
rule.valid('allows strings that merely mention configured fields', `const root = path.join(base, 'example.skills');`);
rule.invalid('rejects named joins and optional nested configured rules', `import { join } from 'node:path'; const root = join(resolve(base), tool?.rules);`);
rule.invalid('rejects configured claudemd and computed fields', `const root = path.resolve(base, tool['claudemd']);`);
rule.valid('allows the locate owner', `const root = path.join(base, tool.skills);`, { filename: 'src/locate.ts' });
rule.valid('allows literal directory names', `const root = path.join(base, 'skills');`);
rule.valid('allows test fixtures', `const root = path.join(base, tool.skills);`, { filename: 'src/__tests__/locate.test.ts' });
rule.valid('allows explained exceptions', `// oxlint-disable-next-line teamai/configured-tool-paths -- compares an old installed path
const root = path.join(base, tool.skills);`);
rule.valid('scopes to src/ of the checkout, not of a parent directory', `import path from 'node:path'; const root = path.join(base, toolPath.skills);`, { filename: 'src/teamai-cli/scripts/check.ts', files: { 'src/teamai-cli/package.json': '{}' } });
