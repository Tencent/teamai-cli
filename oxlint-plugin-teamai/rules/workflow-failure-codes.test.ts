import { ruleHarness } from '../test/harness.ts';
const rule = ruleHarness('teamai/workflow-failure-codes', { filename: 'src/workflow/engine.ts' });
rule.invalid('rejects a failure code records cannot classify', `const failure = { code: 'new_unclassified_failure', message: 'failed' };`);
rule.invalid('rejects unclassified wrapper failures', `return error('new_unclassified_failure', 'failed');`);
rule.invalid('rejects unknown code unions', `type Answer = { code: 'tool_failed' | 'new_unclassified_failure' };`);
rule.invalid('requires an explanation for forwarded codes', `return failure(answer.code, answer.message);`);
rule.valid('allows a recorded failure', `return error('tool_failed', 'failed');`);
rule.valid('allows command-only failures', `return error('invalid_arguments', 'bad arguments');`);
rule.valid('allows explicitly explained forwarding', `// oxlint-disable-next-line teamai/workflow-failure-codes -- producer already classified
return error(answer.code, answer.message);`);
rule.valid('leaves unrelated domain codes alone', `const answer = { code: 'unrelated' };`, { filename: 'src/unrelated.ts' });
rule.valid('scopes to src/ of the checkout, not of a parent directory', `const failure: WorkflowEnvelope = { code: 'new_unclassified_failure', message: 'failed' };`, { filename: 'src/teamai-cli/scripts/check.ts', files: { 'src/teamai-cli/package.json': '{}' } });
