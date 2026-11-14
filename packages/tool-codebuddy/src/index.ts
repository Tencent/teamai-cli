import type { ToolFamily } from '@teamai/tool-core/family';
import type { TokenFormat } from '@teamai/tool-core/tokens';
import { readCodebuddy } from './codebuddy-tokens.js';
import { tools } from './definitions.js';
import { detect } from './detect.js';
import { launch } from './launch.js';
import { platforms } from './sessions.js';

const tokens: Readonly<Record<'codebuddy', TokenFormat>> = { 'codebuddy': readCodebuddy };

/** The CodeBuddy CLI, the CodeBuddy IDE and WorkBuddy. */
export const family = { tools, launch, platforms, tokens, detect } as const satisfies ToolFamily;
