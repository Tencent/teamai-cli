/**
 * adapters/index.ts — Adapter registration.
 *
 * Register every platform adapter in ADAPTER_REGISTRY for the migration engine.
 */

import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { type LocalConfig } from '../../types.js';
import path from 'node:path';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import type { ToolFamily } from '@teamai/tool-core/family';
import { locatesOwnStore, type SessionHost, type StoredPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import { executablesOf, toolCommandEnv } from '../../tool-launch/tools.js';
import { isSessionPlatform, isStoredSessionPlatform, type SessionPlatform, type StoredSessionPlatform } from './platform-facts.js';
import { sessionStoreDir } from '../../locate.js';
import { instanceHomeDir } from '../../tool-home.js';
import { acceptedCommandOf, type DeclaredTool } from '../../tool-instances.js';
import { instancePlatform, toolInstancesFor } from '../../tool-registry.js';

/**
 * Builds a platform's adapter on its session store directory, which the caller resolved (`storeDirOf`). A platform
 * whose adapter finds its own store, such as the CodeBuddy IDE's history, ignores it.
 */
export type AdapterFactory = (storeDir: string) => AgentAdapter;

/** What every adapter this registry builds starts its processes through, and the executables of each tool installed here. */
export const SESSION_HOST: SessionHost = { processes: HOST_PROCESSES, executablesOf, homeEnvAt: (tool, dir) => toolCommandEnv(tool, { kind: 'at', dir }) };

function stored(definition: StoredPlatformDefinition): AdapterFactory {
  return (storeDir) => definition.adapter(storeDir, SESSION_HOST);
}

/** Platform id → adapter factory. Open to any id so a test can register a stand-in platform. */
export interface AdapterRegistry {
  [platform: string]: AdapterFactory;
}

export const ADAPTER_REGISTRY: AdapterRegistry = {
  // Base platforms
  'claude-code': stored(BUILT_IN_TOOLS.claude.platforms['claude-code']),
  codex: stored(BUILT_IN_TOOLS.codex.platforms.codex),
  qoder: stored(BUILT_IN_TOOLS.qoder.platforms.qoder),
  'qoder-cn': stored(BUILT_IN_TOOLS.qoder.platforms['qoder-cn']),
  // CodeBuddy has two independent stores, split into two platforms:
  //   codebuddy     = CLI (<CodeBuddy home>/projects/...)
  //   codebuddy-ide = IDE GUI (CodeBuddyExtension/.../history)
  codebuddy: stored(BUILT_IN_TOOLS.codebuddy.platforms.codebuddy),
  'codebuddy-ide': () => BUILT_IN_TOOLS.codebuddy.platforms['codebuddy-ide'].adapter(),
  workbuddy: stored(BUILT_IN_TOOLS.codebuddy.platforms.workbuddy),
  cursor: stored(BUILT_IN_TOOLS.cursor.platforms.cursor),
  opencode: stored(BUILT_IN_TOOLS.opencode.platforms.opencode),
  agy: stored(BUILT_IN_TOOLS.agy.platforms.agy),
  pi: stored(BUILT_IN_TOOLS.pi.platforms.pi),
  omp: stored(BUILT_IN_TOOLS.pi.platforms.omp),
  muse: stored(BUILT_IN_TOOLS.muse.platforms.muse),
  hermes: stored(BUILT_IN_TOOLS.hermes.platforms.hermes),
  copilot: stored(BUILT_IN_TOOLS.copilot.platforms.copilot),
  // TeamAI variants (different path prefixes, identical format)
  'claude-internal': stored(BUILT_IN_TOOLS.claude.platforms['claude-internal']),
  tclaude: stored(BUILT_IN_TOOLS.claude.platforms.tclaude),
  'codex-internal': stored(BUILT_IN_TOOLS.codex.platforms['codex-internal']),
  tcodex: stored(BUILT_IN_TOOLS.codex.platforms.tcodex),
  joycode: stored(BUILT_IN_TOOLS.joycode.platforms.joycode),
} satisfies Record<SessionPlatform, AdapterFactory>;

/** The definition, adapters included, of the shipped platform `platform`, from the family that declares it. */
function storedDefinitionOf(platform: StoredSessionPlatform): StoredPlatformDefinition | undefined {
  for (const family of Object.values<ToolFamily>(BUILT_IN_TOOLS)) {
    const definition = Object.hasOwn(family.platforms, platform) ? family.platforms[platform] : undefined;

    if (definition !== undefined && !locatesOwnStore(definition)) return definition;
  }

  return undefined;
}

/**
 * An instance's own platform: the definition of the shipped platform whose format its sessions keep, and the
 * instance's home. Absent when the instance keeps no sessions teamai reads.
 */
function instanceStore(platform: string) {
  const hosted = instancePlatform(platform);

  if (!hosted || !isStoredSessionPlatform(hosted.platform)) return undefined;
  const definition = storedDefinitionOf(hosted.platform);
  const { home } = hosted.instance;

  if (definition?.adapterAs === undefined || home === undefined) return undefined;

  return { store: definition.store, adapterAs: definition.adapterAs, name: hosted.instance.name, home, host: instanceSessionHost(hosted.instance) };
}

/**
 * What an instance's adapter runs: the instance's own command first, when it may run with no one to ask
 * (`acceptedCommandOf`), then the executables of the tool it extends, which read a store of the same format; either
 * starts with every home variable the instance's command reads set to the store's home.
 */
function instanceSessionHost(instance: DeclaredTool): SessionHost {
  const own = (tool: string): string => tool === instance.extends ? instance.name : tool;

  return {
    processes: SESSION_HOST.processes,
    executablesOf: (tool) => {
      const command = tool === instance.extends ? acceptedCommandOf(instance) : undefined;

      return command === undefined ? executablesOf(tool) : [command, ...executablesOf(tool)];
    },
    homeEnvAt: (tool, dir) => toolCommandEnv(own(tool), { kind: 'at', dir }),
  };
}

/** The factory of `platform`: a shipped platform's, or an instance's own, in its shipped platform's format. */
function factoryOf(platform: string): AdapterFactory | undefined {
  if (Object.hasOwn(ADAPTER_REGISTRY, platform)) return ADAPTER_REGISTRY[platform];
  const store = instanceStore(platform);

  return store && ((storeDir) => store.adapterAs(platform, storeDir, store.host));
}

/** The platforms of the instances this process knows that keep sessions of their own: each one's name. */
function instancePlatforms(): string[] {
  return toolInstancesFor('use').flatMap(({ name }) => instancePlatform(name) === undefined ? [] : [name]);
}

/**
 * The store directory `platform`'s adapter is built on, which follows the member's recorded `toolRoots`. An instance's
 * store sits in the instance's home. Empty for a platform whose adapter finds its own store, or that teamai has no facts for.
 */
export function storeDirOf(platform: string, toolRoots: LocalConfig['toolRoots']): string {
  if (isSessionPlatform(platform)) return isStoredSessionPlatform(platform) ? sessionStoreDir(platform, toolRoots) : '';
  const instance = instanceStore(platform);

  if (!instance) return '';
  const { store, name, home } = instance;
  const dir = store.in === 'tool-home' ? store.dir : store.child;

  return path.join(instanceHomeDir({ name, home }), dir);
}

/** `platform`'s adapter on `storeDir`, a store directory the caller already resolved (`storeDirOf`). */
export function adapterAt({ platform, storeDir }: { platform: string; storeDir: string }): AgentAdapter {
  const factory = factoryOf(platform);

  if (!factory) {
    throw new Error(`Unsupported platform: ${platform}. Registered: ${listAvailablePlatforms().join(', ')}`);
  }

  return factory(storeDir);
}

export function getAdapter(platform: string, toolRoots?: LocalConfig['toolRoots']): AgentAdapter {
  return adapterAt({ platform, storeDir: storeDirOf(platform, toolRoots) });
}

export function listAvailablePlatforms(): string[] {
  return [...Object.keys(ADAPTER_REGISTRY), ...instancePlatforms()];
}

export function listInstalledPlatforms(toolRoots?: LocalConfig['toolRoots'], projectPath = process.cwd()): string[] {
  const installed: string[] = [];

  for (const platform of listAvailablePlatforms()) {
    const factory = factoryOf(platform);

    if (!factory) continue;

    try {
      const adapter = factory(storeDirOf(platform, toolRoots));

      if (adapter.isReady(projectPath)) installed.push(platform);
    } catch {
      // skip
    }
  }

  return installed;
}

export { AgentAdapter, type SessionMeta } from '@teamai/tool-core/sessions/base';

export { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';

export { CodexAdapter } from '@teamai/tool-core/formats/codex';

