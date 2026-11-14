import type { ToolFamily } from '@teamai/tool-core/family';
import { tools } from './definitions.js';
import { launch } from './launch.js';

/** Kiro. teamai keeps no Kiro sessions and reads no Kiro version. */
export const family = { tools, launch, platforms: {}, tokens: {}, detect: {} } as const satisfies ToolFamily;
