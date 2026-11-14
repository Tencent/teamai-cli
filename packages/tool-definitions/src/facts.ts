import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import { facts as claude } from '@teamai/tool-claude/facts';
import { facts as codex } from '@teamai/tool-codex/facts';
import { facts as qoder } from '@teamai/tool-qoder/facts';
import { facts as joycode } from '@teamai/tool-joycode/facts';
import { facts as pi } from '@teamai/tool-pi/facts';
import { facts as codebuddy } from '@teamai/tool-codebuddy/facts';
import { facts as kiro } from '@teamai/tool-kiro/facts';
import { facts as trae } from '@teamai/tool-trae/facts';
import { facts as zcode } from '@teamai/tool-zcode/facts';
import { facts as openclaw } from '@teamai/tool-openclaw/facts';
import { facts as hermes } from '@teamai/tool-hermes/facts';
import { facts as dsh } from '@teamai/tool-dsh/facts';
import { facts as muse } from '@teamai/tool-muse/facts';
import { facts as copilot } from '@teamai/tool-copilot/facts';
import { facts as opencode } from '@teamai/tool-opencode/facts';
import { facts as agy } from '@teamai/tool-agy/facts';
import { facts as cursor } from '@teamai/tool-cursor/facts';

/**
 * Every built-in tool family's facts: its tools and its session platforms, with no adapter, launch profile or schema.
 * This is what every command loads (teamai/family-facts); the families themselves (`BUILT_IN_TOOLS`) load where first used.
 */
export const BUILT_IN_FACTS = { claude, codex, qoder, joycode, pi, codebuddy, kiro, trae, zcode, openclaw, hermes, dsh, muse, copilot, opencode, agy, cursor } as const satisfies Readonly<Record<string, ToolFamilyFacts>>;
