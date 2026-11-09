import fs from 'node:fs';
import { expect, it } from 'vitest';
import { packagedSkillRoots } from '../skill-content.js';

// skill-data reaches an agent only through `teamai skill get`, after the teamai skill's context pointer made the agent
// load the skill. Another packaged skill would put its pointer in every session; the skills pull generates for
// workflows are counted by scripts/agent-context-budget.ts.
it('deploys only the teamai skill, so skill-data stays behind its context pointer', () => {
  const { deployRoot } = packagedSkillRoots();
  const deployed = fs.readdirSync(deployRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  expect(deployed).toEqual(['teamai']);
});
