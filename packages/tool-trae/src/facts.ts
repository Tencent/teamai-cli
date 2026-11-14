import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import { tools } from './definitions.js';

/** What every command may load of this family: its tools; it has no version detector and keeps no sessions teamai reads. */
export const facts = { tools, platforms: {}, detect: {} } as const satisfies ToolFamilyFacts;
