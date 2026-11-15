import type { ToolFamily } from '@teamai/tool-core/family';
import { readCodexRollout } from '@teamai/tool-core/formats/codex-rollout';
import { tools } from './definitions.js';
import { platforms } from './sessions.js';

/** JoyCode. teamai launches no JoyCode and reads no JoyCode version. */
export const family = { tools, launch: {}, platforms, tokens: { 'codex-rollout': readCodexRollout }, detect: {} } as const satisfies ToolFamily;
