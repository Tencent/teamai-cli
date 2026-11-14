import type { ToolFamily } from '@teamai/tool-core/family';
import type { TokenFormat } from '@teamai/tool-core/tokens';
import { tools } from './definitions.js';
import { detect } from './detect.js';
import { launch } from './launch.js';
import { readMuseSession } from './muse-session.js';
import { platforms } from './sessions.js';

const tokens: Readonly<Record<'muse-session', TokenFormat>> = { 'muse-session': readMuseSession };

/** Muse Code. */
export const family = { tools, launch, platforms, tokens, detect } as const satisfies ToolFamily;
