import type { ToolFamily } from '@teamai/tool-core/family';
import { tools } from './definitions.js';

/** Trae and Trae CN. teamai launches neither, keeps no sessions of them and reads no version. */
export const family = { tools, launch: {}, platforms: {}, tokens: {}, detect: {} } as const satisfies ToolFamily;
