import type { ToolFamily } from '@teamai/tool-core/family';
import { tools } from './definitions.js';

/** ZCode. teamai launches no ZCode, keeps no ZCode sessions and reads no ZCode version. */
export const family = { tools, launch: {}, platforms: {}, tokens: {}, detect: {} } as const satisfies ToolFamily;
