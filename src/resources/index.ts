import { ResourceHandler } from './base.js';
import { SkillsHandler } from './skills.js';
import { RulesHandler } from './rules.js';
import { DocsHandler } from './docs.js';
import { EnvHandler } from './env.js';
import { AgentsHandler } from './agents.js';
import { HooksHandler } from './hooks.js';
import { McpHandler } from './mcp.js';
import { RepoResourceHandler } from './repo-resource.js';
import type { ResourceType } from '../types.js';

const handlers: Record<ResourceType, ResourceHandler> = {
  skills: new SkillsHandler(),
  rules: new RulesHandler(),
  docs: new DocsHandler(),
  env: new EnvHandler(),
  agents: new AgentsHandler(),
  hooks: new HooksHandler(),
  mcp: new McpHandler(),
  claudemd: new RepoResourceHandler('claudemd', 'claudemd'),
  learnings: new RepoResourceHandler('learnings', 'learnings'),
  wiki: new RepoResourceHandler('wiki', 'teamwiki/evidence/code'),
  prompts: new RepoResourceHandler('prompts', 'prompts'),
};

export function getHandler(type: ResourceType): ResourceHandler {
  return handlers[type];
}

export function getAllHandlers(): ResourceHandler[] {
  return Object.values(handlers);
}

export {
  SkillsHandler, RulesHandler, DocsHandler, EnvHandler, AgentsHandler, HooksHandler, McpHandler,
  RepoResourceHandler,
};
