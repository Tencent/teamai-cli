import type { ToolFamily } from '@teamai/tool-core/family';
import { readClaudeJsonl } from '@teamai/tool-core/formats/claude-jsonl';
import { tools } from './definitions.js';
import { launch } from './launch.js';
import { platforms } from './sessions.js';

/** Qoder CLI and Qoder CN. teamai reads no Qoder version. */
export const family = { tools, launch, platforms, tokens: { 'claude-jsonl': readClaudeJsonl }, detect: {} } as const satisfies ToolFamily;
