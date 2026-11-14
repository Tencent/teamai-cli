import type { ToolDescriptor } from './definition.js';
import type { VersionDetector } from './detect.js';
import type { LaunchAdapter } from './launch.js';
import type { SessionPlatformDefinition, SessionPlatformFacts } from './sessions/platform.js';
import type { TokenFormat } from './tokens.js';

/**
 * What a family declares as data: its tools' descriptors, its session platforms' facts and how it reads a tool's
 * version, with no adapter, launch profile, token reader or schema. A family exports them from its `./facts` entry, the only part of it that every
 * command loads (teamai/family-facts); the rest loads where it is first used.
 */
export interface ToolFamilyFacts {
  readonly tools: Readonly<Record<string, ToolDescriptor>>;
  readonly platforms: Readonly<Record<string, SessionPlatformFacts>>;
  /** How teamai reads a tool's version, by tool id or platform id; a tool with none reads no version. */
  readonly detect: Readonly<Record<string, VersionDetector>>;
}

/**
 * One vendor's variants of one product, and everything only they use. Each tool's descriptor names its rows by id:
 * `launch` a launch profile here, `sessions` platforms here, `tokens` a token format here. A family lists every row
 * its tools name, a shared format of `tool-core/formats` included, and may hold a platform no tool lists
 * (the CodeBuddy IDE's store). Declare it `as const satisfies ToolFamily`, so its ids stay literal.
 */
export interface ToolFamily extends ToolFamilyFacts {
  readonly launch: Readonly<Record<string, LaunchAdapter>>;
  readonly platforms: Readonly<Record<string, SessionPlatformDefinition>>;
  readonly tokens: Readonly<Record<string, TokenFormat>>;
}
