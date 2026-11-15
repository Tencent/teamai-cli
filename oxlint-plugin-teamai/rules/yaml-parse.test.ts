import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/yaml-parse', { filename: 'src/config.ts' });

rule.valid('allows the owner module to call the library parse', `
import YAML from 'yaml';
export const parseYaml = (text: string) => YAML.parse(text, { resolveKnownTags: false });
`, { filename: 'packages/shared/src/yaml.ts' });

rule.valid('allows stringify and document parsing', `
import YAML, { parseDocument } from 'yaml';
export const text = YAML.stringify({ a: 1 });
export const doc = parseDocument('a: 1');
`);

rule.valid('allows tests to call the library parse', `
import YAML from 'yaml';
export const read = YAML.parse('a: 1');
`, { filename: 'src/__tests__/config.test.ts' });

rule.invalid('rejects the library parse in a workspace package', `
import YAML from 'yaml';
export const read = YAML.parse('a: 1');
`, undefined, { filename: 'packages/tool-core/src/config.ts', files: { 'packages/tool-core/package.json': '{}' } });

rule.invalid('rejects the library parse in a packages/ folder without a package.json', `
import YAML from 'yaml';
export const read = YAML.parse('a: 1');
`, undefined, { filename: 'packages/tool-core/src/config.ts' });

rule.valid('allows a test beside its source in a workspace package to call the library parse', `
import YAML from 'yaml';
export const read = YAML.parse('a: 1');
`, { filename: 'packages/tool-core/src/config.test.ts', files: { 'packages/tool-core/package.json': '{}' } });

rule.invalid('rejects YAML.parse on the default import', `
import YAML from 'yaml';
export const team = YAML.parse('team: lab');
`, (output) => {
  expect(output).toContain('parseYaml()');
});

rule.invalid('rejects the parse named import', `
import { parse as parseYamlText } from 'yaml';
export const team = parseYamlText('team: lab');
`);

rule.invalid('rejects parse on a namespace import', `
import * as yaml from 'yaml';
export const team = yaml.parse('team: lab');
`);

rule.invalid('rejects parse on the default export of a dynamic import', `
export async function team(text: string) {
  const YAML = (await import('yaml')).default;
  return YAML.parse(text);
}
`);

rule.invalid('rejects parse on a destructured dynamic import', `
export async function team(text: string) {
  const { default: YAML } = await import('yaml');
  const { parse } = await import('yaml');
  return [YAML.parse(text), parse(text)];
}
`, (output) => {
  expect(output).toContain('2 errors');
});

rule.valid('allows stringify on a dynamic import', `
export async function render(value: object) {
  const { default: YAML } = await import('yaml');
  return YAML.stringify(value);
}
`);
