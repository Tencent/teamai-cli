import type { ToolFamily } from '@teamai/tool-core/family';
import { readCodexRollout } from '@teamai/tool-core/formats/codex-rollout';
import { tools } from './definitions.js';
import { detect } from './detect.js';
import { launch } from './launch.js';
import { platforms } from './sessions.js';

/** Codex, codex-internal and tcodex. teamai reads the version of codex only. */
export const family = { tools, launch, platforms, tokens: { 'codex-rollout': readCodexRollout }, detect } as const satisfies ToolFamily;
