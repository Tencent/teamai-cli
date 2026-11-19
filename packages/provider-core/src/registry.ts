export interface ProviderDefinition<TName extends string = string, TProvider = unknown> {
  readonly name: TName;
  readonly hosts: readonly string[];
  /** Whether TEAMAI_DEFAULT_PROVIDER may select this provider. */
  readonly defaultEligible: boolean;
  create(): TProvider;
}

export interface ProviderRegistry<TName extends string, TProvider> {
  readonly ids: readonly TName[];
  readonly defaultIds: ReadonlySet<TName>;
  isProviderId(value: string): value is TName;
  nameForHost(host: string): TName | undefined;
  create(name: string): TProvider | undefined;
}

/** Build every provider lookup from one ordered definition list. */
export function makeProviderRegistry<
  const TDefinitions extends readonly ProviderDefinition<string, unknown>[],
>(definitions: TDefinitions): ProviderRegistry<TDefinitions[number]['name'], ReturnType<TDefinitions[number]['create']>> {
  type Name = TDefinitions[number]['name'];

  type Created = ReturnType<TDefinitions[number]['create']>;

  const byName = new Map<Name, TDefinitions[number]>();
  const byHost = new Map<string, Name>();
  const defaultIds = new Set<Name>();

  for (const definition of definitions) {
    const name: Name = definition.name;

    if (byName.has(name)) throw new Error(`Duplicate provider: ${name}`);

    byName.set(name, definition);

    if (definition.defaultEligible) defaultIds.add(name);

    for (const rawHost of definition.hosts) {
      const host = rawHost.toLowerCase();

      if (byHost.has(host)) throw new Error(`Duplicate provider host: ${host}`);
      byHost.set(host, name);
    }
  }

  const isProviderId = (value: string): value is Name => definitions.some(({ name }) => name === value);

  return {
    ids: [...byName.keys()],
    defaultIds,
    isProviderId,
    nameForHost: (host) => byHost.get(host.toLowerCase()),
    // SAFETY: Created is the union of the factories' return types; the registry stores only those definitions.
    create: (name) => isProviderId(name) ? byName.get(name)?.create() as Created : undefined,
  };
}
