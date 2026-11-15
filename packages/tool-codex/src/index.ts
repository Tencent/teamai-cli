import type { ToolFamily } from '@teamai/tool-core/family';
import { readCodexRollout } from '@teamai/tool-core/formats/codex-rollout';
import { tools } from './definitions.js';
import { launch } from './launch.js';
import { platforms } from './sessions.js';

/** Codex, codex-internal and tcodex. It has no version detector (see facts.ts). */
export const family = { tools, launch, platforms, tokens: { 'codex-rollout': readCodexRollout }, detect: {} } as const satisfies ToolFamily;
