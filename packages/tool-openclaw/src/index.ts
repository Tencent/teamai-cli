import type { ToolFamily } from '@teamai/tool-core/family';
import { tools } from './definitions.js';
import { detect } from './detect.js';
import { launch } from './launch.js';

/** OpenClaw. teamai keeps no OpenClaw sessions. */
export const family = { tools, launch, platforms: {}, tokens: {}, detect } as const satisfies ToolFamily;
