import type { ToolFamily } from '@teamai/tool-core/family';
import type { TokenFormat } from '@teamai/tool-core/tokens';
import { readAgyTranscript } from './agy-transcript.js';
import { tools } from './definitions.js';
import { detect } from './detect.js';
import { launch } from './launch.js';
import { platforms } from './sessions.js';

const tokens: Readonly<Record<'agy-transcript', TokenFormat>> = { 'agy-transcript': readAgyTranscript };

/** Antigravity. */
export const family = { tools, launch, platforms, tokens, detect } as const satisfies ToolFamily;
