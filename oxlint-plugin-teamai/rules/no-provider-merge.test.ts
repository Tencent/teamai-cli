import { ruleHarness } from '../test/harness.ts';
const rule = ruleHarness('teamai/no-provider-merge', { filename: 'src/providers/new/adapter.ts' });
rule.invalid('rejects provider merge commands', `await exec('gh', ['pr', 'merge', '12']);`);
rule.invalid('rejects REST acceptance', `await api.put('/projects/12/merge_requests/3/accept');`);
rule.invalid('rejects GraphQL merging', `await api.mergePullRequest(id);`);
rule.invalid('rejects automatic merging in delivery', `const params = { merge_when_pipeline_succeeds: true };`, undefined, { filename: 'src/workflow/pr-delivery.ts' });
rule.valid('allows finding and creating requests', `await exec('gh', ['pr', 'create']); const label = 'pull/merge requests';`);
rule.valid('leaves engine merge behavior outside providers alone', `const action = 'merge';`, { filename: 'src/workflow/engine.ts' });
rule.valid('scopes to src/providers/ of the checkout, not of a parent directory', `await exec('gh', ['pr', 'merge', '12']);`, { filename: 'src/providers/teamai-cli/scripts/release.ts', files: { 'src/providers/teamai-cli/package.json': '{}' } });
