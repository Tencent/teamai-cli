import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/configured-tool-paths', { filename: 'src/resources/skills.ts' });

describe('teamai/configured-tool-paths', () => {
  rule.invalid('reports a configured skills path', `
    import path from 'node:path';
    const dest = path.join(baseDir, toolPath.skills, name);
  `, (output) => {
    expect(output).toContain('locate()');
  });

  rule.invalid('reports a nested configured rules path', `
    import path from 'node:path';
    const dest = path.resolve(baseDir, scopes[tool].rules, name);
  `);

  rule.invalid('reports a configured claudemd path', `
    import path from 'node:path';
    const dest = path.join(baseDir, toolPath.claudemd);
  `);

  rule.valid('allows a literal directory name', `
    import path from 'node:path';
    const dest = path.join(baseDir, 'skills', name);
  `);

  rule.valid('allows locating a configured path in locate.ts', `
    import path from 'node:path';
    const dest = path.join(baseDir, toolPath.skills, name);
  `, { filename: 'src/locate.ts' });

  rule.valid('does not report an unrelated property', `
    import path from 'node:path';
    const dest = path.join(baseDir, toolPath.settings);
  `);
});