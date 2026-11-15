import type { ToolFamily } from '@teamai/tool-core/family';
import type { TokenFormat } from '@teamai/tool-core/tokens';
import { tools } from './definitions.js';
import { detect } from './detect.js';
import { launch } from './launch.js';
import { readPiSession } from './pi-session.js';
import { platforms } from './sessions.js';

const tokens: Readonly<Record<'pi-session', TokenFormat>> = { 'pi-session': readPiSession };

/** Pi Coding Agent and omp. */
export const family = { tools, launch, platforms, tokens, detect } as const satisfies ToolFamily;
