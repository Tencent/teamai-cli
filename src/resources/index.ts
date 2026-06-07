import { ResourceHandler } from './base.js';
import { SkillsHandler } from './skills.js';
import { RulesHandler } from './rules.js';
import { DocsHandler } from './docs.js';
import { EnvHandler } from './env.js';
import { WikiHandler } from './wiki.js';
import { AgentsHandler } from './agents.js';
import type { ResourceType } from '../types.js';

const handlers: Record<ResourceType, ResourceHandler> = {
  skills: new SkillsHandler(),
  rules: new RulesHandler(),
  docs: new DocsHandler(),
  env: new EnvHandler(),
  wiki: new WikiHandler(),
  agents: new AgentsHandler(),
};

export function getHandler(type: ResourceType): ResourceHandler {
  return handlers[type];
}

export function getAllHandlers(): ResourceHandler[] {
  return Object.values(handlers);
}

export { SkillsHandler, RulesHandler, DocsHandler, EnvHandler, WikiHandler, AgentsHandler };
