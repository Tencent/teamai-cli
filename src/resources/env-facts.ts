

/**
 * This machine's team env, by name, resolved once per `next` before the run is locked. Values stay with whoever
 * runs the step.
 */
export interface EnvFacts {
  /** Keys env.yaml or env/secrets.yaml declare here. */
  declared: ReadonlySet<string>;
  /** The keys among them env/secrets.yaml declares. */
  secrets: ReadonlySet<string>;
  /** Keys with a value here: team values, or the environment. */
  present: ReadonlySet<string>;
  /** Why the team env cannot be read here, when it cannot. */
  unreadable?: string;
}
