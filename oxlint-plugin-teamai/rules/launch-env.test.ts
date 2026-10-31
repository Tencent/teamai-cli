import { ruleHarness } from '../test/harness.ts';
const rule = ruleHarness('teamai/launch-env', { filename: 'src/workflow/engine.ts' });
rule.invalid('rejects duplicated launch variable spellings', `const name = 'TEAMAI_MODE';`);
rule.invalid('rejects the launcher variable', `const name = "TEAMAI_LAUNCHED_BY";`);
rule.invalid('rejects an attempt variable template', 'const name = `TEAMAI_WORKFLOW_ATTEMPT`;');
rule.valid('allows the canonical owner', `const name = 'TEAMAI_MODE';`, { filename: 'src/launch-context.ts' });
rule.valid('allows tests and unrelated variables', `const name = 'TEAMAI_MODE';`, { filename: 'src/__tests__/launch-context.test.ts' });
rule.valid('allows an imported spelling', `const env = { [RUN_MODE_ENV]: 'attended' };`);
rule.valid('scopes to src/ of the checkout, not of a parent directory', `const name = 'TEAMAI_MODE';`, { filename: 'src/teamai-cli/oxlint-plugin-teamai/rules/launch-env.js', files: { 'src/teamai-cli/package.json': '{}' } });
