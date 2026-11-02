import { ruleHarness } from '../test/harness.ts';
const rule = ruleHarness('teamai/no-chained-type-assertions', { filename: 'src/utils/assertions.ts' });
rule.valid('allows a single assertion', 'const value = input as User;');
rule.valid('allows a parenthesized single assertion', 'const value = (input as User);');
rule.valid('allows const-only chains', 'const value = ({ id: 1 } as const) as const;');
rule.invalid('rejects assertion chains that widen then narrow', 'const value = input as unknown as User;');
rule.invalid('rejects parenthesized assertion chains', 'const value = (input as unknown) as User;');
rule.invalid('rejects angle-bracket assertion chains', 'const value = <User>(<unknown>input);');
rule.invalid('rejects mixed const and non-const chains', 'const value = ({ id: 1 } as const) as User;');