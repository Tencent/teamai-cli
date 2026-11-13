import type { ToolFamily } from '@teamai/tool-core/family';
import type { TokenFormat } from '@teamai/tool-core/tokens';
import { tools } from './definitions.js';
import { launch } from './launch.js';
import { readOpencodeDb } from './opencode-db.js';
import { platforms } from './sessions.js';

const tokens: Readonly<Record<'opencode-db', TokenFormat>> = { 'opencode-db': readOpencodeDb };

/** OpenCode. teamai reads no OpenCode version. */
export const family = { tools, launch, platforms, tokens, detect: {} } as const satisfies ToolFamily;
