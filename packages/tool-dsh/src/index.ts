import type { ToolFamily } from '@teamai/tool-core/family';
import { tools } from './definitions.js';
import { detect } from './detect.js';

/** DeepSeek Harness. teamai launches no dsh and keeps no dsh sessions. */
export const family = { tools, launch: {}, platforms: {}, tokens: {}, detect } as const satisfies ToolFamily;
