import type { ToolFamily } from '@teamai/tool-core/family';
import { tools } from './definitions.js';
import { launch } from './launch.js';
import { platforms } from './sessions.js';

/** GitHub Copilot CLI. teamai reads Copilot sessions and no Copilot version; it reads Copilot tokens from the totals its session-end hook carries. */
export const family = { tools, launch, platforms, tokens: {}, detect: {} } as const satisfies ToolFamily;
