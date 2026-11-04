import { ResourceHandler } from './base.js';
import { SkillsHandler } from './skills.js';
import { RulesHandler } from './rules.js';
import { DocsHandler } from './docs.js';
import { EnvHandler } from './env.js';
import { AgentsHandler } from './agents.js';
import { HooksHandler } from './hooks.js';
import { McpHandler } from './mcp.js';
import { RepoResourceHandler } from './repo-resource.js';
import { existingSharedInstructionDirs, SHARED_INSTRUCTION_SOURCE_DIRS } from '../shared-instruction-source.js';
import type { ResourceType } from '../types.js';

const handlers = {
  skills: new SkillsHandler(),
  rules: new RulesHandler(),
  docs: new DocsHandler(),
  env: new EnvHandler(),
  agents: new AgentsHandler(),
  hooks: new HooksHandler(),
  mcp: new McpHandler(),
  models: new RepoResourceHandler('models', 'models'),
  // The shared-instruction SOURCE directory: `claudemd/` or `agentsmd/`,
  // whichever the team repo uses (#1682). A push may also bring a file in
  // the other directory, so both are scanned for push.
  claudemd: new RepoResourceHandler('claudemd', 'claudemd', undefined, existingSharedInstructionDirs, SHARED_INSTRUCTION_SOURCE_DIRS),
  learnings: new RepoResourceHandler('learnings', 'learnings'),
  wiki: new RepoResourceHandler('wiki', 'teamwiki/evidence/code'),
  workflows: new RepoResourceHandler('workflows', 'workflows', (f) => f.endsWith('.yaml')),
  prompts: new RepoResourceHandler('prompts', 'prompts'),
  scorers: new RepoResourceHandler('scorers', 'scorers'),
  benchmarks: new RepoResourceHandler('benchmarks', 'benchmarks'),
} satisfies Record<ResourceType, ResourceHandler>;

/** The handler of `type`, typed as its own class: `getHandler('rules')` is a RulesHandler. */
export function getHandler<TType extends ResourceType>(type: TType): (typeof handlers)[TType] {
  return handlers[type];
}

export function getAllHandlers(): ResourceHandler[] {
  return Object.values(handlers);
}

export {
  SkillsHandler, RulesHandler, DocsHandler, EnvHandler, AgentsHandler, HooksHandler, McpHandler,
  RepoResourceHandler,
};
