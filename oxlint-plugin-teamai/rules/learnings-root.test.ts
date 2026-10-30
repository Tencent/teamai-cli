import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/learnings-root', { filename: 'src/recall.ts' });

describe('teamai/learnings-root', () => {
  rule.invalid('reports a manually joined learnings directory', `
import path from 'node:path';
const root = path.join(getKnowledgeDir(config), 'learnings');
`, (output) => expect(output).toContain('learningsRoots(localConfig)'));

  rule.invalid('reports an absolute learnings suffix', `
import path from 'node:path';
const root = path.resolve(base, '/learnings');
`);

  rule.invalid('reports a learnings template path', `
const root = \`\${base}/learnings\`;
`);

  rule.valid('allows unrelated path joins', `
import path from 'node:path';
const root = path.join(base, 'skills');
`);

  rule.valid('allows imports of learnings accessors', `
import { learningsRoots } from './utils/learnings-roots.js';
const root = learningsRoots(localConfig);
`);

  rule.valid('allows similarly named learnings files', `
import path from 'node:path';
const index = path.join(base, 'learnings-index.json');
`);

  rule.valid('allows an explained exception outside the accessor allowlist', `
import path from 'node:path';
// learnings-root ok: this migration keeps a legacy root temporarily
const root = path.join(getKnowledgeDir(config), 'learnings');
`);

  rule.valid('allows intentional root definitions', `
import path from 'node:path';
const root = path.join(getKnowledgeDir(config), 'learnings');
`, { filename: 'src/utils/learnings-roots.ts' });
});
