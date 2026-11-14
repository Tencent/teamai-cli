import type { InstancePlatform, ToolInstance } from './instance.js';

/**
 * What the registry reads of a tool: the session platforms teamai reads for it, first the one its launched
 * sessions write. `'none'`: it keeps sessions teamai has no adapter for. `'unknown'`: where it keeps them is unknown.
 */
export interface RegisteredTool<TPlatform extends string = string> {
  readonly sessions: readonly TPlatform[] | 'none' | 'unknown';
}

/** A name a reader passes, resolved: the shipped definition it runs as, and the instance over it when one is defined. */
export interface ResolvedTool<TId extends string, TInstance extends ToolInstance<TId> = ToolInstance<TId>> {
  readonly name: string;
  readonly base: TId;
  readonly instance?: TInstance;
}

/** The lookups every reader of a tool id goes through, over one table of tools keyed by id and the instances over them. */
export interface ToolRegistry<TTools, TPlatform extends string, TInstance extends ToolInstance<keyof TTools & string> = ToolInstance<keyof TTools & string>> {
  /** Every shipped tool, in the order the table declares them. Instances are never listed. */
  readonly ids: readonly (keyof TTools & string)[];
  /** Whether the table declares `value`; a name an object inherits, such as `toString`, is no tool. */
  isToolId(value: string): value is keyof TTools & string;
  definitionOf<K extends keyof TTools & string>(id: K): TTools[K];
  /** The tool `name` names: an instance first, then a shipped tool; undefined for neither. */
  toolOf(name: string): ResolvedTool<keyof TTools & string, TInstance> | undefined;
  /**
   * The session platforms teamai reads for `tool`, first the one its launched sessions write; none for a tool it does
   * not know. An instance has one, its own name, when it has a home of its own and the tool it extends keeps sessions
   * teamai reads; one that keeps the home of the tool it extends has that tool's.
   */
  sessionPlatformsOf(tool: string): readonly (TPlatform | InstancePlatform)[];
  /** The first tool whose `sessions` lists `platform`, or the instance whose platform it is: its sessions are credited to it. */
  sessionPlatformOwner(platform: string): string | undefined;
  /** The instance whose own platform `platform` is, and the shipped platform whose format its sessions keep. */
  instancePlatform(platform: string): { instance: TInstance; platform: TPlatform } | undefined;
}

/**
 * A registry over `tools`, keyed by tool id, and the instances `instances` holds when a lookup runs (keyed by name, each
 * extending a tool of `tools`). An instance keeps sessions of its own only when `hostsInstances` says the platform of the
 * tool it extends can keep that instance's under another id. Declare the table `as const satisfies`, so tool ids and session
 * platforms stay literal.
 */
export function makeToolRegistry<
  const TTools extends Readonly<Record<string, RegisteredTool>>,
  const TPlatform extends string,
  TInstance extends ToolInstance<keyof TTools & string> = ToolInstance<keyof TTools & string>,
>(
  tools: TTools & Readonly<Record<string, RegisteredTool<TPlatform>>>,
  instances: () => ReadonlyMap<string, TInstance> = () => new Map(),
  hostsInstances: (platform: TPlatform, instance: TInstance) => boolean = () => true,
): ToolRegistry<TTools, TPlatform, TInstance> {
  const declared: Readonly<Record<string, RegisteredTool<TPlatform>>> = tools;
  const isToolId = (value: string): value is keyof TTools & string => Object.hasOwn(tools, value);
  const ids = Object.keys(tools).filter(isToolId);

  const shippedPlatforms = (tool: string): readonly TPlatform[] => {
    const sessions = isToolId(tool) ? declared[tool].sessions : 'none';

    return sessions instanceof Object ? sessions : [];
  };

  /**
   * An instance whose sessions are its own: not a shipped tool's adjustment, and with a home of its own. One that keeps
   * the home of the tool it extends writes that tool's sessions, which stay credited to that tool.
   */
  const ownInstance = (name: string): TInstance | undefined => {
    const instance = isToolId(name) ? undefined : instances().get(name);
    const [platform] = instance?.home ? shippedPlatforms(instance.extends) : [];

    return instance && platform !== undefined && hostsInstances(platform, instance) ? instance : undefined;
  };

  const sessionPlatformsOf = (tool: string): readonly (TPlatform | InstancePlatform)[] => {
    if (isToolId(tool)) return shippedPlatforms(tool);
    const own = ownInstance(tool);

    if (own) {
      // SAFETY: ownInstance answers only for a name the table does not declare, so the name is no shipped platform's.
      return [own.name as InstancePlatform];
    }

    const instance = instances().get(tool);

    return instance && !instance.home ? shippedPlatforms(instance.extends) : [];
  };

  return {
    ids,
    isToolId,
    definitionOf: (id) => tools[id],
    toolOf: (name) => {
      const instance = instances().get(name);

      if (instance) return { name, base: instance.extends, instance };

      return isToolId(name) ? { name, base: name } : undefined;
    },
    sessionPlatformsOf,
    sessionPlatformOwner: (platform) => (ownInstance(platform) ? platform : ids.find((tool) => shippedPlatforms(tool).some((listed) => listed === platform))),
    instancePlatform: (platform) => {
      const instance = ownInstance(platform);
      const [shipped] = instance ? shippedPlatforms(instance.extends) : [];

      return instance && shipped !== undefined ? { instance, platform: shipped } : undefined;
    },
  };
}
