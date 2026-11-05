/**
 * What the registry reads of a tool: the session platforms teamai reads for it, first the one its launched
 * sessions write. `'none'`: it keeps sessions teamai has no adapter for. `'unknown'`: where it keeps them is unknown.
 */
export interface RegisteredTool<TPlatform extends string = string> {
  readonly sessions: readonly TPlatform[] | 'none' | 'unknown';
}

/** The lookups every reader of a tool id goes through, over one table of tools keyed by id. */
export interface ToolRegistry<TTools, TPlatform extends string> {
  /** Every tool, in the order the table declares them. */
  readonly ids: readonly (keyof TTools & string)[];
  /** Whether the table declares `value`; a name an object inherits, such as `toString`, is no tool. */
  isToolId(value: string): value is keyof TTools & string;
  definitionOf<K extends keyof TTools & string>(id: K): TTools[K];
  /** The session platforms teamai reads for `tool`, first the one its launched sessions write; none for a tool the table does not declare. */
  sessionPlatformsOf(tool: string): readonly TPlatform[];
  /** The first tool whose `sessions` lists `platform`: its sessions are credited to that tool. */
  sessionPlatformOwner(platform: string): (keyof TTools & string) | undefined;
}

/**
 * A registry over `tools`, keyed by tool id. Declare the table `as const satisfies`, so tool ids and session
 * platforms stay literal unions.
 */
export function makeToolRegistry<const TTools extends Readonly<Record<string, RegisteredTool>>, const TPlatform extends string>(
  tools: TTools & Readonly<Record<string, RegisteredTool<TPlatform>>>,
): ToolRegistry<TTools, TPlatform> {
  const declared: Readonly<Record<string, RegisteredTool<TPlatform>>> = tools;
  const isToolId = (value: string): value is keyof TTools & string => Object.hasOwn(tools, value);
  const ids = Object.keys(tools).filter(isToolId);

  const sessionPlatformsOf = (tool: string): readonly TPlatform[] => {
    const sessions = isToolId(tool) ? declared[tool].sessions : 'none';

    return sessions instanceof Object ? sessions : [];
  };

  return {
    ids,
    isToolId,
    definitionOf: (id) => tools[id],
    sessionPlatformsOf,
    sessionPlatformOwner: (platform) => ids.find((tool) => sessionPlatformsOf(tool).some((listed) => listed === platform)),
  };
}
