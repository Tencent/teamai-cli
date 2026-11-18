import type { ToolFamily } from '@teamai/tool-core/family';
import { tools } from './definitions.js';
import { platforms } from './sessions.js';

/** ZCode. teamai reads ZCode sessions, launches no ZCode and reads no ZCode version. */
export const family = { tools, launch: {}, platforms, tokens: {}, detect: {} } as const satisfies ToolFamily;
