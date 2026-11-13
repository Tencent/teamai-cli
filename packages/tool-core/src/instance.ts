/**
 * A tool a team or a member adds over a shipped definition, with no code: another command, home and paths. It keeps
 * the formats of the definition it extends (launch flags, session and token formats, sync writers), and its sessions
 * are its own: their platform is the instance's name. An instance named like the shipped tool adjusts that tool.
 */
export interface ToolInstance<TBase extends string = string> {
  readonly name: string;
  /** The shipped definition it is an instance of. */
  readonly extends: TBase;
  /** The executable on PATH that starts it; the shipped command when unset. */
  readonly command?: string;
  /** Its home: a `$HOME`-relative directory, and the variable that moves it, as the shipped tool's home variable does. */
  readonly home?: ToolInstanceHome;
}

export interface ToolInstanceHome {
  readonly dir: string;
  readonly env?: string;
}

/** The keys an instance file may set. Any other key, such as one naming a format, is refused at load, naming it. */
export const INSTANCE_KEYS = ['schemaVersion', 'name', 'extends', 'command', 'home', 'paths'] as const;

declare const instancePlatform: unique symbol;

/** An instance's own session platform: its name, which is no shipped platform. */
export type InstancePlatform = string & { readonly [instancePlatform]: true };
