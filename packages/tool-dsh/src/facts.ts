import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import { detect } from './detect.js';
import { tools } from './definitions.js';

/** What every command may load of this family: its tools and its version detectors; it keeps no sessions teamai reads. */
export const facts = { tools, platforms: {}, detect } as const satisfies ToolFamilyFacts;
