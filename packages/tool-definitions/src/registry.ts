import type { ToolFamily } from '@teamai/tool-core/family';
import type { StepLaunch } from '@teamai/tool-core/launch';
import { family as claude } from '@teamai/tool-claude';
import { family as codex } from '@teamai/tool-codex';
import { family as qoder } from '@teamai/tool-qoder';
import { family as joycode } from '@teamai/tool-joycode';
import { family as pi } from '@teamai/tool-pi';
import { family as codebuddy } from '@teamai/tool-codebuddy';
import { family as kiro } from '@teamai/tool-kiro';
import { family as trae } from '@teamai/tool-trae';
import { family as zcode } from '@teamai/tool-zcode';
import { family as openclaw } from '@teamai/tool-openclaw';
import { family as hermes } from '@teamai/tool-hermes';
import { family as dsh } from '@teamai/tool-dsh';
import { family as muse } from '@teamai/tool-muse';
import { family as copilot } from '@teamai/tool-copilot';
import { family as opencode } from '@teamai/tool-opencode';
import { family as agy } from '@teamai/tool-agy';
import { family as cursor } from '@teamai/tool-cursor';
import type { BUILT_IN_FACTS } from './facts.js';

/**
 * Every built-in tool family, the one with each list of facts (`BUILT_IN_FACTS`). The app reads tools only through these,
 * never by importing a family.
 */
export const BUILT_IN_TOOLS = { claude, codex, qoder, joycode, pi, codebuddy, kiro, trae, zcode, openclaw, hermes, dsh, muse, copilot, opencode, agy, cursor } as const satisfies Readonly<Record<keyof typeof BUILT_IN_FACTS, ToolFamily>>;

/** The sign-in variables of each built-in tool a step runtime launches on the member's own sign-in, by launch adapter id. */
// oxlint-disable-next-line teamai/tool-facts -- read from each launch adapter's own signIn, keyed by launch adapter id as LAUNCH_ADAPTERS is
export const SIGN_INS = { claude: claude.launch.claude.signIn, codex: codex.launch.codex.signIn, codebuddy: codebuddy.launch.codebuddy.signIn } as const;

/**
 * The workflow step profile of the built-in launch adapter `id` (`claude`, `codex`, …), for a step runtime that launches
 * a step's tool itself and reads no app registry; undefined for an adapter that runs no step.
 */
export function stepLaunchOf(id: string): StepLaunch | undefined {
  for (const family of Object.values<ToolFamily>(BUILT_IN_TOOLS)) {
    if (Object.hasOwn(family.launch, id)) return family.launch[id]?.step;
  }

  return undefined;
}
